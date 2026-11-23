import type { MetricRow, ModelBreakdown, Session } from "./types";
import { familyOf } from "./model-family";
import { isGeminiModel, OTHER_PROVIDER, providerFromAgent, providerFromModel } from "./provider";

/** One checked entry in the Agent filter. `agent:` covers a whole coarse agent ("claude"),
 * `model:` covers one release-stripped model family ("claude-opus-5"). The two live in one list
 * so a person picking "everything Claude" and a person picking "just Opus 5" use one control.
 *
 * Gemini is the one family whose entry depends on the agent (see `buildAgentTree`): under the
 * Antigravity branch it is `antigravity:<family>`, Antigravity's own sessions of that family, and
 * under Google it is `model:<family>`, every other agent's. The two are selected independently. */
export type AgentEntry = `agent:${string}` | `model:${string}` | `antigravity:${string}`;

/** An empty selection means "everything" — the same thing the old `all` option meant. */
export type AgentSelection = AgentEntry[];

export const agentEntry = (agent: string): AgentEntry => `agent:${agent}`;
export const modelEntry = (family: string): AgentEntry => `model:${family}`;

function isAntigravityAgent(agent: string) {
  return providerFromAgent(agent) === "antigravity";
}

/** What one agent's model family is matched against: the family itself, except Gemini run by
 * Antigravity, which is `antigravity:<family>`. Shared with the server, which receives these
 * tokens as `modelFamilies`. */
export function familyToken(agent: string, family: string) {
  return isGeminiModel(family) && isAntigravityAgent(agent) ? `antigravity:${family}` : family;
}

/** The entry that selects `family` as run by `agent`. A branch's children use it; the Google
 * heading's families, run by other agents, are plain `model:` entries. */
export function familyEntry(agent: string, family: string): AgentEntry {
  const token = familyToken(agent, family);
  return token === family ? modelEntry(family) : token as AgentEntry;
}

/** `models` holds family tokens (see `familyToken`). */
export function splitSelection(selection: AgentSelection) {
  const agents = new Set<string>();
  const models = new Set<string>();
  for (const entry of selection) {
    if (entry.startsWith("agent:")) agents.add(entry.slice("agent:".length));
    else if (entry.startsWith("model:")) models.add(entry.slice("model:".length));
    else models.add(entry);
  }
  return { agents, models };
}

/** One coarse agent and the model families that belong to it. */
export type AgentBranch = { agent: string; models: string[] };
/** `google` lists the Gemini families some agent other than Antigravity ran (Warp, for one). It is
 * a vendor heading, not an agent: it has no `agent:` entry of its own, and its families stay
 * ordinary `model:` entries. */
export type AgentTree = { branches: AgentBranch[]; google: string[]; unparented: string[] };

/** Groups model families under the agent that produced them. A family whose vendor cannot be read
 * from its name gets no parent rather than an assumed one — it stays independently checkable.
 *
 * Gemini is the one family that depends on the agent: it sits under Antigravity when Antigravity
 * ran it and under Google when another agent did. A family both ran is listed in both places, with
 * a separate entry in each (see `AgentEntry`), whereas a Claude family under the Claude branch
 * also matches Warp's Claude sessions. `agentsByFamily` says which agents ran each family; a
 * Gemini family missing from it is listed under Google. */
export function buildAgentTree(agents: string[], families: string[], agentsByFamily: ReadonlyMap<string, readonly string[]> = new Map()): AgentTree {
  const branches = agents.map((agent) => ({ agent, models: [] as string[] }));
  const google: string[] = [];
  const unparented: string[] = [];
  const branchFor = (provider: string | null) => provider
    ? branches.find((candidate) => providerFromAgent(candidate.agent) === provider)
    : undefined;
  for (const family of families) {
    if (isGeminiModel(family)) {
      const ranBy = agentsByFamily.get(family) ?? [];
      const antigravity = ranBy.some((agent) => providerFromAgent(agent) === "antigravity") ? branchFor("antigravity") : undefined;
      if (antigravity) antigravity.models.push(family);
      if (!antigravity || ranBy.some((agent) => providerFromAgent(agent) !== "antigravity")) google.push(family);
      continue;
    }
    const branch = branchFor(providerFromModel(family));
    if (branch) branch.models.push(family);
    else unparented.push(family);
  }
  return { branches, google, unparented };
}

/** Which agents ran each model family, for `buildAgentTree`. */
export function agentsByFamily(sessions: Array<Pick<Session, "agent" | "modelBreakdowns">>) {
  const byFamily = new Map<string, string[]>();
  for (const session of sessions) {
    for (const model of session.modelBreakdowns) {
      const family = familyOf(model.modelName);
      const agents = byFamily.get(family) ?? [];
      if (!agents.includes(session.agent)) agents.push(session.agent);
      byFamily.set(family, agents);
    }
  }
  return byFamily;
}

export type BranchState = "checked" | "indeterminate" | "unchecked";

/** `checked` is stored as the `agent:` entry, never as the expanded child list — see
 * `normalizeSelection`. */
export function branchState(selection: AgentSelection, branch: AgentBranch): BranchState {
  const { agents } = splitSelection(selection);
  if (agents.has(branch.agent)) return "checked";
  const chosen = branch.models.filter((family) => selection.includes(familyEntry(branch.agent, family))).length;
  if (chosen === 0) return "unchecked";
  return chosen === branch.models.length ? "checked" : "indeterminate";
}

/** A collapsed parent makes every child read as checked even though the individual `model:`
 * entries are intentionally absent from storage. */
export function matchesEntry(selection: AgentSelection, branch: AgentBranch, family: string) {
  const { agents } = splitSelection(selection);
  return agents.has(branch.agent) || selection.includes(familyEntry(branch.agent, family));
}

/** Collapses a fully-checked branch back to its `agent:` entry and expands nothing else.
 *
 * The collapsed form is not just tidier: `agent:claude` matches on `session.agent`, so it still
 * catches a session whose models are missing or unrecognised. The expanded child list cannot,
 * which is why "all children checked" and "agent checked" must not be stored the same way. */
export function normalizeSelection(selection: AgentSelection, tree: AgentTree): AgentSelection {
  const { agents } = splitSelection(selection);
  const entries = new Set(selection);
  const next: AgentSelection = [];
  for (const branch of tree.branches) {
    const chosen = branch.models.map((family) => familyEntry(branch.agent, family)).filter((entry) => entries.has(entry));
    const complete = agents.has(branch.agent) || (branch.models.length > 0 && chosen.length === branch.models.length);
    if (complete) next.push(agentEntry(branch.agent));
    else next.push(...chosen);
  }
  // A family under Google is its own entry, never one of a branch's: it neither completes nor
  // clears the Antigravity branch that also lists the family.
  next.push(...[...tree.google, ...tree.unparented].map(modelEntry).filter((entry) => entries.has(entry)));
  return [...new Set(next)];
}

/** Checking an agent means every model under it; unchecking clears the whole branch, including
 * children that were checked individually. */
export function toggleBranch(selection: AgentSelection, branch: AgentBranch, tree: AgentTree): AgentSelection {
  const cleared = selection.filter(
    (entry) => entry !== agentEntry(branch.agent) && !branch.models.some((family) => entry === familyEntry(branch.agent, family)),
  );
  if (branchState(selection, branch) !== "unchecked") return normalizeSelection(cleared, tree);
  return normalizeSelection([...cleared, agentEntry(branch.agent)], tree);
}

/** Unchecking one auto-checked child drops the parent to indeterminate and keeps its siblings, so
 * the parent entry has to be expanded before the child is removed. */
export function toggleModel(selection: AgentSelection, family: string, tree: AgentTree): AgentSelection {
  const branch = tree.branches.find((candidate) => candidate.models.includes(family));
  const expanded: AgentSelection = branch && splitSelection(selection).agents.has(branch.agent)
    ? [...selection.filter((entry) => entry !== agentEntry(branch.agent)), ...branch.models.map((child) => familyEntry(branch.agent, child))]
    : [...selection];
  const entry = branch ? familyEntry(branch.agent, family) : modelEntry(family);
  const next = expanded.includes(entry)
    ? expanded.filter((candidate) => candidate !== entry)
    : [...expanded, entry];
  return normalizeSelection(next, tree);
}

/** A family under a heading with no agent (Google, Other models) toggles its own `model:` entry
 * only. It must not expand or collapse a branch that also lists it: the branch's entry for the
 * family is a different one. */
export function toggleFamilyEntry(selection: AgentSelection, family: string, tree: AgentTree): AgentSelection {
  const entry = modelEntry(family);
  return normalizeSelection(selection.includes(entry) ? selection.filter((candidate) => candidate !== entry) : [...selection, entry], tree);
}

/** Entries are unioned, never intersected: checking "claude" and "gpt-5.6-sol" asks for Claude
 * activity *plus* gpt-5.6-sol activity. Intersecting them would silently return nothing, since no
 * session is both. */
export function matchesAgentSelection(session: Session, selection: AgentSelection) {
  if (selection.length === 0) return true;
  const { agents, models } = splitSelection(selection);
  if (agents.has(session.agent)) return true;
  return session.modelBreakdowns.some((model) => models.has(familyToken(session.agent, familyOf(model.modelName))));
}

const zeroTotals = () => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalTokens: 0,
  totalCost: 0,
});

function addBreakdown(totals: ReturnType<typeof zeroTotals>, model: ModelBreakdown) {
  totals.inputTokens += model.inputTokens;
  totals.outputTokens += model.outputTokens;
  totals.cacheReadTokens += model.cacheReadTokens;
  totals.cacheCreationTokens += model.cacheCreationTokens;
  totals.totalTokens += model.inputTokens + model.outputTokens + model.cacheReadTokens + model.cacheCreationTokens;
  totals.totalCost += model.cost;
}

function addRow(totals: ReturnType<typeof zeroTotals>, row: MetricRow) {
  totals.inputTokens += row.inputTokens;
  totals.outputTokens += row.outputTokens;
  totals.cacheReadTokens += row.cacheReadTokens;
  totals.cacheCreationTokens += row.cacheCreationTokens;
  totals.totalTokens += row.totalTokens;
  totals.totalCost += row.totalCost;
}

/** Restricts one daily row to the selection, returning `null` when nothing survives so callers can
 * drop the day. A checked agent contributes its whole sub-row (authoritative totals); an unchecked
 * agent contributes only the model breakdowns whose family is checked, so the day-by-day charts
 * mean the same thing as the session lists. */
export function selectAgentRow(row: MetricRow, selection: AgentSelection): MetricRow | null {
  if (selection.length === 0) return row;
  const { agents, models } = splitSelection(selection);
  const sources = row.agents?.length ? row.agents : [{ ...row, modelBreakdowns: row.modelBreakdowns }];
  const totals = zeroTotals();
  const kept: Array<MetricRow & { modelBreakdowns: ModelBreakdown[] }> = [];
  for (const source of sources) {
    if (agents.has(source.agent)) {
      addRow(totals, source);
      kept.push(source);
      continue;
    }
    const matching = source.modelBreakdowns.filter((model) => models.has(familyToken(source.agent, familyOf(model.modelName))));
    if (matching.length === 0) continue;
    const partial = zeroTotals();
    matching.forEach((model) => addBreakdown(partial, model));
    matching.forEach((model) => addBreakdown(totals, model));
    kept.push({
      ...partial,
      agent: source.agent,
      period: source.period,
      modelsUsed: matching.map((model) => model.modelName),
      modelBreakdowns: matching,
    });
  }
  if (kept.length === 0) return null;
  const keptModels = kept.flatMap((source) => source.modelBreakdowns);
  return {
    ...totals,
    agent: kept.length === 1 ? kept[0].agent : "all",
    period: row.period,
    modelsUsed: [...new Set(keptModels.map((model) => model.modelName))],
    modelBreakdowns: keptModels,
    // The per-agent split survives filtering, so the Agent Mix chart still reports real agents
    // rather than one merged "all" slice.
    agents: kept,
    metadata: row.metadata,
  };
}

/** The provider to highlight in charts, or `null` when the selection spans both. Highlighting is a
 * single-provider affordance; a mixed selection has no one answer, and guessing would be worse
 * than leaving every series at full strength. */
export function selectionProvider(selection: AgentSelection) {
  if (selection.length === 0) return null;
  const { agents, models } = splitSelection(selection);
  const resolved = [...[...agents].map(providerFromAgent), ...[...models].map(providerFromModel)];
  // An unrecognised model is not evidence for either provider, so it suppresses highlighting
  // rather than being dropped and letting the rest of the selection speak for it.
  if (resolved.some((provider) => provider === null)) return null;
  const providers = new Set(resolved);
  return providers.size === 1 ? [...providers][0]! : null;
}

/** Query parameters shared by `/api/effort` and `/api/insights`. Agents are sent as providers
 * because both endpoints scope by provider, not by the raw ccusage agent label. Families are sent
 * as tokens (see `familyToken`), so an Antigravity Gemini entry stays apart from the Google one. */
export function agentSelectionParams(selection: AgentSelection) {
  const { agents, models } = splitSelection(selection);
  // An agent with no recognized provider is sent as `other`. Dropping it would leave the list
  // empty, and an empty list asks the server for every provider.
  const providers = [...new Set([...agents].map((name) => providerFromAgent(name) ?? OTHER_PROVIDER))] as string[];
  return { providers, modelFamilies: [...models] };
}
