import { describe, expect, test } from "bun:test";
import {
  agentEntry,
  agentSelectionParams,
  branchState,
  buildAgentTree,
  matchesEntry,
  matchesAgentSelection,
  modelEntry,
  normalizeSelection,
  selectAgentRow,
  selectionProvider,
  toggleBranch,
  toggleModel,
} from "./agent-filter";
import type { MetricRow, ModelBreakdown, Session } from "./types";

const breakdown = (modelName: string, tokens: number): ModelBreakdown => ({
  modelName,
  inputTokens: tokens,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  cost: 1,
});

const session = (id: string, agent: string, models: ModelBreakdown[]): Session =>
  ({
    sessionId: id,
    agent,
    period: "2026-07-20",
    inputTokens: models.reduce((sum, model) => sum + model.inputTokens, 0),
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: models.reduce((sum, model) => sum + model.inputTokens, 0),
    totalCost: models.length,
    modelsUsed: models.map((model) => model.modelName),
    modelBreakdowns: models,
    cwd: null,
    pathTags: [],
    annotation: { tags: [], note: "", verdict: null },
  }) as Session;

describe("agent selection matching", () => {
  const claude = session("s1", "claude", [breakdown("claude-opus-5", 1_000)]);
  const codex = session("s2", "codex", [breakdown("gpt-5.6-sol", 2_000)]);
  const otherCodex = session("s3", "codex", [breakdown("gpt-5.5", 3_000)]);

  test("an empty selection means everything", () => {
    expect([claude, codex, otherCodex].filter((row) => matchesAgentSelection(row, []))).toHaveLength(3);
  });

  test("a provider and a model from another provider are unioned", () => {
    const selection = [agentEntry("claude"), modelEntry("gpt-5.6-sol")];
    expect([claude, codex, otherCodex].filter((row) => matchesAgentSelection(row, selection)).map((row) => row.sessionId))
      .toEqual(["s1", "s2"]);
  });

  test("a datestamped model is matched through its family", () => {
    const dated = session("s4", "claude", [breakdown("claude-haiku-4-5-20251001", 100)]);
    expect(matchesAgentSelection(dated, [modelEntry("claude-haiku-4-5")])).toBe(true);
  });

  test("a session is matched on any model it used, not only its dominant one", () => {
    const mixed = session("s5", "claude", [breakdown("claude-opus-5", 9_000), breakdown("claude-haiku-4-5", 10)]);
    expect(matchesAgentSelection(mixed, [modelEntry("claude-haiku-4-5")])).toBe(true);
  });
});

describe("selection provider", () => {
  test("resolves a single provider for chart highlighting", () => {
    expect(selectionProvider([agentEntry("claude"), modelEntry("claude-opus-5")])).toBe("anthropic");
    expect(selectionProvider([modelEntry("gpt-5.6-sol")])).toBe("codex");
  });
  test("declines to guess when the selection spans providers", () => {
    expect(selectionProvider([agentEntry("claude"), modelEntry("gpt-5.6-sol")])).toBeNull();
    expect(selectionProvider([])).toBeNull();
  });
});

describe("daily row selection", () => {
  const row: MetricRow = {
    agent: "all",
    period: "2026-07-20",
    inputTokens: 6_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 6_000,
    totalCost: 3,
    modelsUsed: [],
    modelBreakdowns: [],
    agents: [
      {
        agent: "claude",
        period: "2026-07-20",
        inputTokens: 3_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 3_000,
        totalCost: 1,
        modelsUsed: ["claude-opus-5"],
        modelBreakdowns: [breakdown("claude-opus-5", 3_000)],
      },
      {
        agent: "codex",
        period: "2026-07-20",
        inputTokens: 3_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 3_000,
        totalCost: 2,
        modelsUsed: ["gpt-5.6-sol", "gpt-5.5"],
        modelBreakdowns: [breakdown("gpt-5.6-sol", 2_000), breakdown("gpt-5.5", 1_000)],
      },
    ],
  };

  test("an empty selection returns the row untouched", () => {
    expect(selectAgentRow(row, [])).toBe(row);
  });

  test("a checked agent contributes its whole authoritative sub-row", () => {
    expect(selectAgentRow(row, [agentEntry("claude")])).toMatchObject({ totalTokens: 3_000, agent: "claude" });
  });

  test("an unchecked agent contributes only its checked model breakdowns", () => {
    const selected = selectAgentRow(row, [modelEntry("gpt-5.6-sol")])!;
    expect(selected.totalTokens).toBe(2_000);
    expect(selected.modelsUsed).toEqual(["gpt-5.6-sol"]);
  });

  test("the two grains are unioned across agents", () => {
    const selected = selectAgentRow(row, [agentEntry("claude"), modelEntry("gpt-5.6-sol")])!;
    expect(selected.totalTokens).toBe(5_000);
    expect(selected.agent).toBe("all");
  });

  test("the per-agent split survives so the agent mix chart keeps real agent names", () => {
    const selected = selectAgentRow(row, [agentEntry("claude"), modelEntry("gpt-5.6-sol")])!;
    expect(selected.agents?.map((entry) => [entry.agent, entry.totalTokens])).toEqual([
      ["claude", 3_000],
      ["codex", 2_000],
    ]);
  });

  test("a day with nothing selected is dropped rather than reported as zero", () => {
    expect(selectAgentRow(row, [modelEntry("claude-fable-5")])).toBeNull();
  });
});

describe("agent tree", () => {
  const tree = buildAgentTree(
    ["claude", "codex"],
    ["claude-opus-5", "claude-fable-5", "gpt-5.6-sol", "gpt-5.5", "mystery-9"],
  );

  test("groups families under the agent that produced them", () => {
    expect(tree.branches).toEqual([
      { agent: "claude", models: ["claude-opus-5", "claude-fable-5"] },
      { agent: "codex", models: ["gpt-5.6-sol", "gpt-5.5"] },
    ]);
  });

  test("a family with no readable vendor gets no parent rather than an assumed one", () => {
    expect(tree.unparented).toEqual(["mystery-9"]);
  });

  const claude = tree.branches[0];

  test("checking an agent stores the agent entry, not the expanded children", () => {
    expect(toggleBranch([], claude, tree)).toEqual([agentEntry("claude")]);
  });

  test("unchecking an auto-checked child keeps its siblings and drops the parent", () => {
    const checked = toggleBranch([], claude, tree);
    const partial = toggleModel(checked, "claude-fable-5", tree);
    expect(partial).toEqual([modelEntry("claude-opus-5")]);
    expect(branchState(partial, claude)).toBe("indeterminate");
  });

  test("re-checking the last missing child collapses back to the agent", () => {
    const partial = toggleModel(toggleBranch([], claude, tree), "claude-fable-5", tree);
    expect(toggleModel(partial, "claude-fable-5", tree)).toEqual([agentEntry("claude")]);
  });

  test("clicking an indeterminate agent clears the partial branch", () => {
    const partial = toggleModel([], "claude-opus-5", tree);
    expect(branchState(partial, claude)).toBe("indeterminate");
    expect(toggleBranch(partial, claude, tree)).toEqual([]);
  });

  test("unchecking a checked agent clears the whole branch", () => {
    const complete = toggleBranch([], claude, tree);
    expect(toggleBranch(complete, claude, tree)).toEqual([]);
  });

  test("branches are independent of one another", () => {
    const mixed = toggleModel(toggleBranch([], claude, tree), "gpt-5.6-sol", tree);
    expect(mixed).toEqual([agentEntry("claude"), modelEntry("gpt-5.6-sol")]);
    expect(branchState(mixed, tree.branches[1])).toBe("indeterminate");
  });

  test("an unparented family never rolls up into a branch", () => {
    const selection = toggleModel(toggleBranch([], claude, tree), "mystery-9", tree);
    expect(selection).toEqual([agentEntry("claude"), modelEntry("mystery-9")]);
  });

  test("a collapsed parent makes each child render as checked", () => {
    expect(matchesEntry([agentEntry("claude")], claude, "claude-opus-5")).toBe(true);
    expect(matchesEntry([modelEntry("claude-fable-5")], claude, "claude-opus-5")).toBe(false);
  });

  test("normalizing a hand-built complete child list collapses it", () => {
    expect(normalizeSelection([modelEntry("gpt-5.6-sol"), modelEntry("gpt-5.5")], tree))
      .toEqual([agentEntry("codex")]);
  });

  // The collapsed form is what lets a checked agent keep matching sessions whose models are
  // missing or unrecognised; the expanded child list cannot see them.
  test("the collapsed agent form still matches a session with no recognisable model", () => {
    const blank = session("s9", "claude", []);
    expect(matchesAgentSelection(blank, [agentEntry("claude")])).toBe(true);
    expect(matchesAgentSelection(blank, [modelEntry("claude-opus-5"), modelEntry("claude-fable-5")])).toBe(false);
  });
});

describe("selection to query parameters", () => {
  test("maps agents onto providers and keeps model families verbatim", () => {
    expect(agentSelectionParams([agentEntry("claude"), modelEntry("gpt-5.6-sol")]))
      .toEqual({ providers: ["anthropic"], modelFamilies: ["gpt-5.6-sol"] });
  });
  test("collapses agent labels that map to the same provider", () => {
    expect(agentSelectionParams([agentEntry("claude"), agentEntry("claude-code")]).providers).toEqual(["anthropic"]);
  });
});
