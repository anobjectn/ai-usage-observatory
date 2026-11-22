export type ActivityProvider = "anthropic" | "codex" | "warp" | "antigravity";

/** Scope value for every agent `providerFromAgent` does not recognize (Copilot, for one). It is
 * a filter value only, never an `ActivityProvider`: such agents have no quota, no effort index,
 * and no chart series. */
export const OTHER_PROVIDER = "other";

/** The single agent → API-provider mapper. Collector, insights, and effort code all route
 * through this so a session can never be Anthropic in one view and Codex in another.
 * Substring matching (rather than equality) is deliberate: ccusage agent labels have carried
 * values like "claude-code" and "codex-cli" as well as bare "claude" / "codex". */
export function providerFromAgent(agent: string): ActivityProvider | null {
  const normalized = agent.toLowerCase();
  if (normalized.includes("claude") || normalized.includes("anthropic")) return "anthropic";
  if (normalized.includes("codex") || normalized.includes("openai")) return "codex";
  if (normalized.includes("warp")) return "warp";
  if (normalized.includes("antigravity")) return "antigravity";
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
  // Gemini is Google's, and Antigravity is the provider it is tracked under here. A Gemini model
  // Warp ran groups here too, as a Claude model Warp ran groups under Anthropic.
  if (/^gemini/.test(normalized)) return "antigravity";
  return null;
}

/** Agents whose sessions no ccusage price covers. Their `totalCost` of 0 is an absent cost, not a
 * free one, so it stays out of every cost median, rate, and comparison. Warp is not listed: its
 * credits have their own treatment. */
export function agentIsUnpriced(agent: string) {
  return providerFromAgent(agent) === "antigravity";
}
