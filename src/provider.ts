export type ActivityProvider = "anthropic" | "codex" | "warp";

/** The single agent → API-provider mapper. Collector, insights, and effort code all route
 * through this so a session can never be Anthropic in one view and Codex in another.
 * Substring matching (rather than equality) is deliberate: ccusage agent labels have carried
 * values like "claude-code" and "codex-cli" as well as bare "claude" / "codex". */
export function providerFromAgent(agent: string): ActivityProvider | null {
  const normalized = agent.toLowerCase();
  if (normalized.includes("claude") || normalized.includes("anthropic")) return "anthropic";
  if (normalized.includes("codex") || normalized.includes("openai")) return "codex";
  if (normalized.includes("warp")) return "warp";
  return null;
}

/** Provider for a model name, for the places that hold a model rather than an agent — the Agent
 * filter's model entries most of all. Agent labels are tried first because some of them ("codex")
 * also appear in model names; only then do the model prefixes apply. Returns null for a model
 * whose vendor cannot be read off its name, which callers treat as "unknown", never as a guess. */
export function providerFromModel(model: string): ActivityProvider | null {
  const fromAgent = providerFromAgent(model);
  if (fromAgent) return fromAgent;
  const normalized = model.toLowerCase();
  if (/^(gpt|o\d|text-|davinci)/.test(normalized)) return "codex";
  return null;
}
