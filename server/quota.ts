import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { QuotaObservation, QuotaProvider } from "../src/types";

const baseUrl = process.env.QUOTA_SERVICE_URL ?? "http://127.0.0.1:8787";
const defaultHistoryDbPath = join(homedir(), ".quota-service", "quota.db");

type SnapshotHistoryRow = { provider: string; capturedAt: number; snapshotJson: string | null };
type ResetHistoryRow = { capturedAt: number; creditsJson: string | null };
type ResetCreditHistory = { id?: string; title?: string | null; status?: string | null; expiresAt?: string | null };
export type QuotaSeriesPoint = { provider: "anthropic" | "codex"; window: "fiveHour" | "weekly"; capturedAt: number; usedPercent: number; resetsAt: number | null; cycleId: string };

export function summarizeQuotaHistory(snapshotRows: SnapshotHistoryRow[], resetRows: ResetHistoryRow[]) {
  const reachedCycles = new Map<string, Map<string, number>>();
  const series: QuotaSeriesPoint[] = [];
  const seenBuckets = new Set<string>();
  let trackingSince: number | null = null;
  for (const row of snapshotRows) {
    trackingSince = trackingSince === null ? row.capturedAt : Math.min(trackingSince, row.capturedAt);
    if (!row.snapshotJson) continue;
    try {
      const snapshot = JSON.parse(row.snapshotJson) as { kind?: string; fiveHour?: {usedPercent?:number;resetsAt?:number|null}|null; weekly?: {usedPercent?:number;resetsAt?:number|null}|null };
      if (snapshot.kind !== "window") continue;
      if (row.provider !== "anthropic" && row.provider !== "codex") continue;
      for (const [window, value] of [["fiveHour", snapshot.fiveHour], ["weekly", snapshot.weekly]] as const) {
        if (!value || !Number.isFinite(Number(value.usedPercent))) continue;
        const cycleId = value.resetsAt ? String(Math.round(value.resetsAt / 60_000)) : `observed:${row.capturedAt}`;
        const bucket = `${row.provider}:${window}:${Math.floor(row.capturedAt / 300_000)}`;
        if (!seenBuckets.has(bucket)) {
          seenBuckets.add(bucket);
          series.push({ provider: row.provider, window, capturedAt: row.capturedAt, usedPercent: Number(value.usedPercent), resetsAt: value.resetsAt ?? null, cycleId });
        }
        if (Number(value.usedPercent) < 100) continue;
        const key = `${row.provider}:${window}`;
        const cycle = cycleId;
        const cycles = reachedCycles.get(key) ?? new Map<string, number>();
        const firstObservedAt = cycles.get(cycle);
        if (firstObservedAt === undefined || row.capturedAt < firstObservedAt) {
          cycles.set(cycle, row.capturedAt);
        }
        reachedCycles.set(key, cycles);
      }
    } catch { /* Ignore malformed historical rows; current quota collection remains available. */ }
  }

  const usedResets = new Map<string, { id: string; title: string; usedAt: number }>();
  const recordUsedReset = (id: string, credit: ResetCreditHistory, usedAt: number) => {
    if (!usedResets.has(id)) {
      usedResets.set(id, { id, title: credit.title?.trim() || "Banked reset", usedAt });
    }
  };
  let previousAvailable = new Map<string, ResetCreditHistory>();
  for (const row of [...resetRows].sort((a, b) => a.capturedAt - b.capturedAt)) {
    trackingSince = trackingSince === null ? row.capturedAt : Math.min(trackingSince, row.capturedAt);
    let credits: ResetCreditHistory[] = [];
    try { credits = row.creditsJson ? JSON.parse(row.creditsJson) : []; } catch { continue; }
    const currentAvailable = new Map<string, ResetCreditHistory>();
    for (const credit of credits) {
      if (!credit.id) continue;
      const status = credit.status?.toLowerCase();
      if (status && ["used", "consumed", "redeemed"].includes(status)) recordUsedReset(credit.id, credit, row.capturedAt);
      if (status === "available") currentAvailable.set(credit.id, credit);
    }
    for (const [id, credit] of previousAvailable) {
      const expiry = credit.expiresAt ? Date.parse(credit.expiresAt) : NaN;
      if (!currentAvailable.has(id) && (!Number.isFinite(expiry) || expiry > row.capturedAt)) recordUsedReset(id, credit, row.capturedAt);
    }
    previousAvailable = currentAvailable;
  }

  const windows = (["codex", "anthropic"] as const).flatMap((provider) => (["fiveHour", "weekly"] as const).map((window) => {
    const reachedAt = [...(reachedCycles.get(`${provider}:${window}`)?.values() ?? [])]
      .sort((left, right) => right - left);
    return {
      provider,
      window,
      reachedCount: reachedAt.length,
      lastReachedAt: reachedAt[0] ?? null,
      reachedAt,
    };
  }));
  const used = [...usedResets.values()].sort((left, right) => right.usedAt - left.usedAt);
  return { available: snapshotRows.length > 0 || resetRows.length > 0, trackingSince, windows, series, codexBankedResets: { usedCount: used.length, used } };
}

export function collectQuotaHistory() {
  try {
    const host = new URL(baseUrl).hostname;
    if (!process.env.QUOTA_DB_PATH && host !== "127.0.0.1" && host !== "localhost") return { available: false, trackingSince: null, windows: [], series: [], codexBankedResets: { usedCount: 0, used: [] } };
    const dbPath = process.env.QUOTA_DB_PATH ?? defaultHistoryDbPath;
    if (!existsSync(dbPath)) return { available: false, trackingSince: null, windows: [], series: [], codexBankedResets: { usedCount: 0, used: [] } };
    const db = new Database(dbPath, { readonly: true });
    try {
      const snapshotRows = db.query("SELECT provider, captured_at AS capturedAt, snapshot_json AS snapshotJson FROM snapshots WHERE status IN ('ok', 'stale') ORDER BY captured_at").all() as SnapshotHistoryRow[];
      const resetRows = db.query("SELECT captured_at AS capturedAt, credits_json AS creditsJson FROM reset_credits WHERE status IN ('ok', 'stale') ORDER BY captured_at").all() as ResetHistoryRow[];
      return summarizeQuotaHistory(snapshotRows, resetRows);
    } finally { db.close(); }
  } catch {
    return { available: false, trackingSince: null, windows: [], series: [], codexBankedResets: { usedCount: 0, used: [] } };
  }
}

type RawHistoryResult = {
  available: boolean;
  provider: "anthropic" | "codex" | "warp";
  observations: QuotaObservation[];
  earliestObservationAt: number | null;
  historyVersion: number;
  retentionDays: number | null;
  retentionMode: "forever" | "finite";
  sourceState: "connected" | "history_only" | "degraded" | "unreachable";
  error?: string;
};
export type QuotaLifecycleMarker = {
  provider: "anthropic";
  sessionId: string;
  event: "session_start" | "session_resume" | "turn_stop" | "session_end";
  occurredAt: number;
  source: "claude_hook";
};

const lastRawHistory = new Map<RawHistoryResult["provider"], RawHistoryResult>();
const lastUsageProviders = new Map<QuotaProvider["provider"], QuotaProvider>();

function providerId(value: string): value is RawHistoryResult["provider"] {
  return value === "anthropic" || value === "codex" || value === "warp";
}

function tableExists(database: Database, name: string) {
  return Boolean(database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function planAt(database: Database, provider: RawHistoryResult["provider"], observedAt: number) {
  if (!tableExists(database, "plan_assignments")) return null;
  return database.query(`SELECT plan_id AS id, plan_label AS label, effective_from AS effectiveFrom
    FROM plan_assignments WHERE provider = ? AND effective_from <= ?
    ORDER BY effective_from DESC, id DESC LIMIT 1`).get(provider, observedAt) as
      { id: string; label: string; effectiveFrom: number } | null;
}

function normalizeLocalObservation(database: Database, row: {
  id: number;
  provider: RawHistoryResult["provider"];
  status: string;
  source: string;
  dataAsOf: number | null;
  capturedAt: number;
  snapshotJson: string;
}): QuotaObservation | null {
  const observedAt = row.dataAsOf ?? row.capturedAt;
  const snapshot = JSON.parse(row.snapshotJson) as Record<string, unknown>;
  const assigned = planAt(database, row.provider, observedAt);
  const extra = snapshot.extra && typeof snapshot.extra === "object" ? snapshot.extra as Record<string, unknown> : {};
  const reported = typeof extra.planType === "string"
    ? extra.planType
    : typeof extra.subscriptionType === "string"
      ? extra.subscriptionType
      : null;
  const plan = assigned
    ? { ...assigned, source: "configured" as const }
    : reported
      ? { id: reported, label: reported, effectiveFrom: null, source: "provider" as const }
      : { id: null, label: null, effectiveFrom: null, source: "unknown" as const };
  const base = {
    schemaVersion: 1 as const,
    provider: row.provider,
    capturedAt: row.capturedAt,
    observedAt,
    timeSource: row.dataAsOf === null
      ? "collector" as const
      : row.source === "warp_plist" || row.source.endsWith("_file")
        ? "source_mtime" as const
        : "provider" as const,
    status: row.status === "stale" ? "stale" as const : "ok" as const,
    source: row.source,
    plan,
  };
  const cycle = (at: number | null) => at === null ? `observed:${observedAt}` : `reset:${Math.floor(at / 60_000) * 60_000}`;
  if (snapshot.kind === "window") {
    const windows = (["fiveHour", "weekly"] as const).flatMap((id) => {
      const value = snapshot[id] as { usedPercent?: unknown; resetsAt?: unknown } | null;
      const usedPercent = Number(value?.usedPercent);
      if (!value || !Number.isFinite(usedPercent)) return [];
      const resetsAt = Number.isFinite(Number(value.resetsAt)) ? Number(value.resetsAt) : null;
      return [{ id, usedPercent, resetsAt, cycleId: cycle(resetsAt) }];
    });
    return { ...base, quota: { kind: "windows", windows } };
  }
  if (snapshot.kind !== "pool" || !snapshot.pool || typeof snapshot.pool !== "object") return null;
  const pool = snapshot.pool as Record<string, unknown>;
  const usedUnits = Number(pool.used);
  const limitUnits = Number(pool.limit);
  const storedPercent = Number(pool.usedPercent);
  if (![usedUnits, limitUnits, storedPercent].every(Number.isFinite) || limitUnits <= 0) return null;
  const usedPercent = usedUnits / limitUnits * 100;
  if (Math.abs(usedPercent - storedPercent) > 0.11) return null;
  const refreshesAt = Number.isFinite(Number(pool.refreshesAt)) ? Number(pool.refreshesAt) : null;
  return {
    ...base,
    quota: {
      kind: "pool",
      pool: {
        id: "monthly",
        usedUnits,
        limitUnits,
        unit: "warp_credit",
        unitSource: "provider_docs_and_local_schema",
        usedPercent,
        refreshesAt,
        cadence: typeof pool.cadence === "string" ? pool.cadence : null,
        cycleId: cycle(refreshesAt),
      },
    },
  };
}

function readLocalRawHistory(
  provider: RawHistoryResult["provider"],
  from: number,
  to: number,
): RawHistoryResult {
  const unavailable = (error?: string): RawHistoryResult => ({
    available: false, provider, observations: [], earliestObservationAt: null,
    historyVersion: 0, retentionDays: null, retentionMode: "forever", sourceState: "unreachable",
    ...(error ? { error } : {}),
  });
  try {
    const host = new URL(baseUrl).hostname;
    if (!process.env.QUOTA_DB_PATH && host !== "127.0.0.1" && host !== "localhost") return unavailable();
    const dbPath = process.env.QUOTA_DB_PATH ?? defaultHistoryDbPath;
    if (!existsSync(dbPath)) return unavailable();
    const database = new Database(dbPath, { readonly: true });
    try {
      const columns = database.query("PRAGMA table_info(snapshots)").all() as Array<{ name: string }>;
      const required = ["id", "provider", "status", "source", "data_as_of", "captured_at", "snapshot_json"];
      if (!required.every((name) => columns.some((column) => column.name === name))) {
        return unavailable("history unavailable: unrecognized quota database schema");
      }
      const version = Number((database.query("SELECT COALESCE(MAX(id), 0) AS value FROM snapshots WHERE provider = ?").get(provider) as { value: number }).value);
      const earliest = (database.query(`SELECT MIN(COALESCE(data_as_of, captured_at)) AS value
        FROM snapshots WHERE provider = ? AND snapshot_json IS NOT NULL AND status IN ('ok', 'stale')`).get(provider) as { value: number | null }).value;
      const rows = database.query(`SELECT id, provider, status, source, data_as_of AS dataAsOf,
          captured_at AS capturedAt, snapshot_json AS snapshotJson
        FROM snapshots WHERE provider = ? AND snapshot_json IS NOT NULL AND status IN ('ok', 'stale')
          AND COALESCE(data_as_of, captured_at) BETWEEN ? AND ?
        ORDER BY COALESCE(data_as_of, captured_at), id`).all(provider, from, to) as Array<{
          id: number; provider: RawHistoryResult["provider"]; status: string; source: string;
          dataAsOf: number | null; capturedAt: number; snapshotJson: string;
        }>;
      return {
        available: rows.length > 0,
        provider,
        observations: rows.flatMap((row) => {
          try { const normalized = normalizeLocalObservation(database, row); return normalized ? [normalized] : []; }
          catch { return []; }
        }),
        earliestObservationAt: earliest,
        historyVersion: version,
        retentionDays: null,
        retentionMode: "forever",
        sourceState: "history_only",
      };
    } finally {
      database.close();
    }
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

export async function collectRawQuotaHistory(
  provider: RawHistoryResult["provider"],
  from: number,
  to: number,
): Promise<RawHistoryResult> {
  let cursor: string | null = null;
  const observations: QuotaObservation[] = [];
  try {
    let metadata: Omit<RawHistoryResult, "available" | "observations" | "sourceState"> | null = null;
    do {
      const query = new URLSearchParams({ provider, from: String(from), to: String(to), limit: "5000" });
      if (cursor) query.set("cursor", cursor);
      const response = await fetch(`${baseUrl}/history?${query}`, { signal: AbortSignal.timeout(4000) });
      if (!response.ok) throw new Error(`/history returned ${response.status}`);
      const page = await response.json() as {
        provider: string; observations: QuotaObservation[]; earliestObservationAt: number | null;
        historyVersion: number; retentionDays: number | null; retentionMode: "forever" | "finite";
        nextCursor: string | null;
      };
      if (!providerId(page.provider) || page.provider !== provider || !Array.isArray(page.observations)) {
        throw new Error("/history returned an incompatible contract");
      }
      metadata ??= {
        provider, earliestObservationAt: page.earliestObservationAt, historyVersion: page.historyVersion,
        retentionDays: page.retentionDays, retentionMode: page.retentionMode,
      };
      observations.push(...page.observations);
      cursor = page.nextCursor;
    } while (cursor);
    const result: RawHistoryResult = {
      available: observations.length > 0,
      observations,
      sourceState: "connected",
      ...metadata!,
    };
    if (result.available) lastRawHistory.set(provider, result);
    return result;
  } catch (error) {
    const fallback = readLocalRawHistory(provider, from, to);
    if (fallback.available) {
      lastRawHistory.set(provider, fallback);
      return { ...fallback, error: error instanceof Error ? error.message : String(error) };
    }
    const cached = lastRawHistory.get(provider);
    if (cached) {
      return {
        ...cached,
        observations: cached.observations.filter((row) => row.observedAt >= from && row.observedAt <= to),
        sourceState: "degraded",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return { ...fallback, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function collectQuotaLifecycleMarkers(from: number, to: number): Promise<{
  available: boolean;
  markers: QuotaLifecycleMarker[];
  sourceState: "connected" | "history_only" | "unreachable";
}> {
  try {
    const response = await fetch(`${baseUrl}/markers?${new URLSearchParams({ from: String(from), to: String(to) })}`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error(`/markers returned ${response.status}`);
    const data = await response.json() as { markers?: QuotaLifecycleMarker[] };
    return { available: true, markers: Array.isArray(data.markers) ? data.markers : [], sourceState: "connected" };
  } catch {
    try {
      const dbPath = process.env.QUOTA_DB_PATH ?? defaultHistoryDbPath;
      if (!existsSync(dbPath)) throw new Error("missing database");
      const database = new Database(dbPath, { readonly: true });
      try {
        if (!tableExists(database, "lifecycle_markers")) throw new Error("missing marker table");
        const markers = database.query(`SELECT provider, session_id AS sessionId, event,
          occurred_at AS occurredAt, source FROM lifecycle_markers
          WHERE provider = 'anthropic' AND occurred_at BETWEEN ? AND ? ORDER BY occurred_at, id`)
          .all(from, to) as QuotaLifecycleMarker[];
        return { available: true, markers, sourceState: "history_only" };
      } finally {
        database.close();
      }
    } catch {
      return { available: false, markers: [], sourceState: "unreachable" };
    }
  }
}

/** Thin proxy to quota-service's user-imported Claude Web credit endpoint.
 * Forwards the producer's status and parsed body verbatim; the producer owns
 * all field validation and returns a field-specific 400 on bad input, so we do
 * not re-validate here. Never accepts or forwards browser cookies. */
export async function importAnthropicWebCredits(body: unknown): Promise<{ status: number; data: unknown }> {
  const response = await fetch(`${baseUrl}/anthropic-web-import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(4000),
  });
  let data: unknown = null;
  try { data = await response.json(); } catch { /* producer may return a non-JSON error body */ }
  return { status: response.status, data };
}

export async function collectQuota() {
  const collectedAt = new Date().toISOString();
  const history = collectQuotaHistory();
  if (process.env.QUOTA_SERVICE_ENABLED === "0") {
    return { available: false, source: baseUrl, sourceState: "disabled" as const, history, collectedAt };
  }
  const endpoint = async (path: string) => {
    try {
      const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(4000) });
      if (!response.ok) throw new Error(`${path} returned ${response.status}`);
      return { ok: true as const, data: await response.json() };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const [usageResult, resetsResult, statusResult] = await Promise.all([
    endpoint("/usage"), endpoint("/resets"), endpoint("/status"),
  ]);
  let usage = usageResult.ok ? usageResult.data : undefined;
  if (usageResult.ok && usage && typeof usage === "object" && Array.isArray((usage as { providers?: unknown }).providers)) {
    for (const provider of (usage as { providers: QuotaProvider[] }).providers) {
      lastUsageProviders.set(provider.provider, provider);
    }
  } else if (lastUsageProviders.size) {
    usage = { generatedAt: Date.now(), providers: [...lastUsageProviders.values()] };
  }
  const failures = [usageResult, resetsResult, statusResult].flatMap((result) => result.ok ? [] : [result.error]);
  const successCount = 3 - failures.length;
  const configured = Boolean(process.env.QUOTA_SERVICE_URL) || history.available;
  const sourceState = successCount === 3
    ? "connected" as const
    : successCount > 0
      ? "degraded" as const
      : history.available
        ? "history_only" as const
        : configured
          ? "unreachable" as const
          : "disabled" as const;
  return {
    available: successCount > 0 || history.available,
    source: baseUrl,
    sourceState,
    ...(usage ? { usage } : {}),
    ...(resetsResult.ok ? { resets: resetsResult.data } : {}),
    ...(statusResult.ok ? { status: statusResult.data } : {}),
    history,
    ...(failures.length ? { error: failures.join("; ") } : {}),
    collectedAt,
  };
}
