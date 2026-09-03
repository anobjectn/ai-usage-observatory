import { join } from "node:path";
import type { ModelRate, RateCardStatus, RateCardSummary } from "../src/types";
import { db } from "./store";

/** ccusage prices from this table at every run, so it is the only source whose rates can
 * decompose a ccusage cost. The app never prices tokens with it directly: rates split a cost
 * ccusage already produced, and every split is validated against that cost first. */
export const LITELLM_PRICING_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export type RateCard = Record<string, ModelRate>;
export type RateCardState = { card: RateCard; status: RateCardStatus; fetchedAt: string | null; error: string | null };

const cacheTtlMs = 24 * 60 * 60 * 1000;
const fetchTimeoutMs = 10_000;
/** Only the families ccusage can emit. Keeps the fallback file and the cache small. */
const keepModel = /^(anthropic\/)?claude-|^gpt-|^o[1-9]|^gemini-/;

export const offlinePricing = () => process.env.USAGE_OBSERVATORY_OFFLINE_PRICING === "1";

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

export function parseLiteLlmRates(json: unknown): RateCard {
  const card: RateCard = {};
  if (!json || typeof json !== "object") return card;
  for (const [name, entry] of Object.entries(json as Record<string, unknown>)) {
    if (!keepModel.test(name) || !entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const input = number(record.input_cost_per_token);
    const output = number(record.output_cost_per_token);
    if (input === null || output === null) continue;
    card[name] = {
      input,
      output,
      cacheRead: number(record.cache_read_input_token_cost) ?? input,
      cacheWrite5m: number(record.cache_creation_input_token_cost) ?? input,
      cacheWrite1h: number(record.cache_creation_input_token_cost_above_1hr),
    };
  }
  return card;
}

/** Mirrors ccusage's lookup order closely enough that a model ccusage priced resolves here too:
 * the exact name, the Anthropic-prefixed key, and the dated name with its date stripped. A
 * `[1m]` context suffix is dropped last. Returns null rather than guessing a family rate. */
export function matchRate(card: RateCard, modelName: string): ModelRate | null {
  const bare = modelName.replace(/\[\d+[mk]\]$/i, "");
  const candidates = [
    modelName,
    `anthropic/${modelName}`,
    bare,
    `anthropic/${bare}`,
    bare.replace(/-\d{8}$/, ""),
    `anthropic/${bare.replace(/-\d{8}$/, "")}`,
  ];
  for (const candidate of candidates) {
    const rate = card[candidate];
    if (rate) return rate;
  }
  return null;
}

type CachedCard = { fetchedAt: string; card: RateCard };

function readCache(): CachedCard | null {
  const row = db.query("SELECT fetched_at, card_json FROM rate_card_cache WHERE id = 1").get() as { fetched_at: string; card_json: string } | null;
  if (!row) return null;
  try {
    const card = JSON.parse(row.card_json) as RateCard;
    return card && typeof card === "object" ? { fetchedAt: row.fetched_at, card } : null;
  } catch {
    return null;
  }
}

function writeCache(entry: CachedCard) {
  db.query(`INSERT INTO rate_card_cache (id, fetched_at, card_json) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET fetched_at = excluded.fetched_at, card_json = excluded.card_json`)
    .run(entry.fetchedAt, JSON.stringify(entry.card));
}

export function clearRateCardCache() {
  db.query("DELETE FROM rate_card_cache").run();
  state = null;
}

let fallbackPromise: Promise<RateCard> | null = null;
function loadFallback(): Promise<RateCard> {
  fallbackPromise ??= Bun.file(join(import.meta.dir, "rate-card-fallback.json"))
    .json()
    .then((json: { models?: RateCard }) => json.models ?? {})
    .catch(() => ({}));
  return fallbackPromise;
}

let state: RateCardState | null = null;
let refreshing: Promise<RateCardState> | null = null;

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Fetches the live table and replaces the cache. Never throws: a failed fetch keeps whatever
 * state was current and records the error for the source-health entry. */
export async function refreshRateCard(fetcher: Fetcher = fetch, now = () => new Date()): Promise<RateCardState> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const current = state ?? (await ensureRateCard());
    try {
      const response = await fetcher(LITELLM_PRICING_URL, { signal: AbortSignal.timeout(fetchTimeoutMs) });
      if (!response.ok) throw new Error(`LiteLLM pricing responded ${response.status}`);
      const card = parseLiteLlmRates(await response.json());
      if (Object.keys(card).length === 0) throw new Error("LiteLLM pricing table had no usable models");
      const entry = { fetchedAt: now().toISOString(), card };
      writeCache(entry);
      state = { card, status: "live", fetchedAt: entry.fetchedAt, error: null };
    } catch (error) {
      state = { ...current, error: error instanceof Error ? error.message : String(error) };
    }
    return state;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

/** Current card without waiting on the network: the cached table when one exists, the bundled
 * fallback otherwise. Kicks off a background refresh when the cache is stale and pricing is not
 * pinned offline, so a collection tick never waits on GitHub. */
export async function ensureRateCard(fetcher: Fetcher = fetch, now = () => new Date()): Promise<RateCardState> {
  if (!state) {
    const cached = readCache();
    state = cached
      ? { card: cached.card, status: "cached", fetchedAt: cached.fetchedAt, error: null }
      : { card: await loadFallback(), status: "fallback", fetchedAt: null, error: null };
  }
  const age = state.fetchedAt ? now().getTime() - Date.parse(state.fetchedAt) : Number.POSITIVE_INFINITY;
  if (!offlinePricing() && age > cacheTtlMs && !refreshing) void refreshRateCard(fetcher, now);
  return state;
}

/** Test seam. */
export function setRateCardState(next: RateCardState | null) {
  state = next;
}

/** The dashboard slice: one entry per model ccusage emitted, resolved once here so the client
 * never has to know the matching rules. */
export function summarizeRateCard(current: RateCardState, modelNames: Iterable<string>): RateCardSummary {
  const models: Record<string, ModelRate | null> = {};
  for (const name of modelNames) models[name] = matchRate(current.card, name);
  return { status: current.status, fetchedAt: current.fetchedAt, models };
}

export function rateCardHealth(current: RateCardState, now = () => new Date()) {
  const ageDays = current.fetchedAt ? (now().getTime() - Date.parse(current.fetchedAt)) / 86_400_000 : null;
  const fresh = ageDays !== null && ageDays <= 7;
  const status = current.status === "fallback" || !fresh ? "degraded" : "healthy";
  const when = current.fetchedAt ? `fetched ${current.fetchedAt.slice(0, 10)}` : "bundled fallback";
  const detail = offlinePricing()
    ? `LiteLLM rates · ${when} · offline pinned (USAGE_OBSERVATORY_OFFLINE_PRICING) · splits ccusage cost by token type, never prices on its own`
    : current.error
      ? `LiteLLM rates · ${when} · last fetch failed: ${current.error}`
      : `LiteLLM rates · ${when} · splits ccusage cost by token type, never prices on its own`;
  return { status, detail };
}
