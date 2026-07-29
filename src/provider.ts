export type ActivityProvider = "anthropic" | "codex";

/** The single agent → API-provider mapper. Collector, insights, and effort code all route
 * through this so a session can never be Anthropic in one view and Codex in another.
 * Substring matching (rather than equality) is deliberate: ccusage agent labels have carried
 * values like "claude-code" and "codex-cli" as well as bare "claude" / "codex". */
export function providerFromAgent(agent: string): ActivityProvider | null {
  const normalized = agent.toLowerCase();
  if (normalized.includes("claude") || normalized.includes("anthropic")) return "anthropic";
  if (normalized.includes("codex") || normalized.includes("openai")) return "codex";
  return null;
}
