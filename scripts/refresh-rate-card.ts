/**
 * Regenerates `server/rate-card-fallback.json` from LiteLLM's public pricing table, the same
 * source ccusage prices from. The fallback is what the app uses when it has never fetched the
 * live table (or when `USAGE_OBSERVATORY_OFFLINE_PRICING=1`), so it is committed and refreshed by
 * hand rather than at build time.
 *
 *   bun run scripts/refresh-rate-card.ts            # fetch from LiteLLM
 *   bun run scripts/refresh-rate-card.ts <file.json> # read an already-downloaded copy
 */
import { join } from "node:path";
import { LITELLM_PRICING_URL, parseLiteLlmRates } from "../server/rate-card";

const source = process.argv[2];
const raw = source
  ? await Bun.file(source).json()
  : await (await fetch(LITELLM_PRICING_URL, { signal: AbortSignal.timeout(30_000) })).json();
const card = parseLiteLlmRates(raw);
const target = join(import.meta.dir, "..", "server", "rate-card-fallback.json");
await Bun.write(
  target,
  `${JSON.stringify({ generatedAt: new Date().toISOString(), source: LITELLM_PRICING_URL, models: card }, null, 2)}\n`,
);
console.log(`${Object.keys(card).length} models written to ${target}`);
