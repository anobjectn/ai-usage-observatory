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
 * whose vendor cannot be read off its name, which callers treat as "unknown", never as a guess.
 *
 * Gemini is deliberately absent. "Antigravity" here means the Gemini subscription, not Google's
 * models: a Gemini model another agent ran (Warp, for one) is not Antigravity usage. Places that
 * group models read `modelGroup`, which knows the agent. */
export function providerFromModel(model: string): ActivityProvider | null {
  const fromAgent = providerFromAgent(model);
  if (fromAgent) return fromAgent;
  const normalized = model.toLowerCase();
  if (/^(gpt|o\d|text-|davinci)/.test(normalized)) return "codex";
  return null;
}

/** A vendor group for models that no activity provider owns. Gemini run by an agent other than
 * Antigravity is shown as Google: a label and a colour, never a filter scope, quota, or session
 * owner. Those stay with the agent that ran the model. */
export const GOOGLE_VENDOR = "google";
export type ModelGroup = ActivityProvider | typeof GOOGLE_VENDOR;

export function isGeminiModel(model: string) {
  return /^gemini/i.test(model);
}

/** The group a model is shown under, given the agent that ran it. Claude and GPT models group
 * under their vendor whatever agent ran them, as before. Gemini groups under Antigravity only when
 * Antigravity ran it, and under Google otherwise. */
export function modelGroup(model: string, agent: string | null | undefined): ModelGroup | null {
  const provider = providerFromModel(model);
  if (provider) return provider;
  if (!isGeminiModel(model)) return null;
  return agent && providerFromAgent(agent) === "antigravity" ? "antigravity" : GOOGLE_VENDOR;
}
