/**
 * Warp keeps the typed prompt for every agent turn in `ai_queries.input`, as a
 * JSON array of tagged variants. Only the two user-authored variants are read
 * here: `Query` is a fresh prompt and `RefineUserQuery` is a follow-up
 * refinement. `ActionResult` rows are the agent reporting a tool outcome back
 * to itself, not something the person wrote, so they are skipped.
 *
 * This table holds prompts only. Responses live in the agent-run blobs read by
 * `warp-transcript.ts`.
 */
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textOf(variant: unknown) {
  if (!record(variant)) return "";
  const value = variant.text ?? variant.query;
  return typeof value === "string" ? value.trim() : "";
}

/** Exported for tests: the parse is pure, so it needs no database. */
export function parseWarpQueryInput(input: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.flatMap((item) => {
    if (!record(item)) return [];
    return ["Query", "RefineUserQuery"]
      .map((variant) => textOf(item[variant]))
      .filter(Boolean);
  });
}
