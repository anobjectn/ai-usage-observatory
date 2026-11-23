import { describe, expect, test } from "bun:test";
import {
  agentEntry,
  agentsByFamily,
  agentSelectionParams,
  branchState,
  buildAgentTree,
  familyEntry,
  familyTokenLabel,
  matchesEntry,
  matchesAgentSelection,
  modelEntry,
  selectAgentRow,
  selectionProvider,
  toggleBranch,
  toggleFamilyEntry,
  toggleModel,
} from "./agent-filter";
import { parseUrlFilters, writeUrlFilters, defaultUrlFilters } from "./url-filters";
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
  });  test("sends an agent with no recognized provider as other, never as an empty list", () => {
    // An empty provider list asks the server for every provider.
    expect(agentSelectionParams([agentEntry("copilot")])).toEqual({ providers: ["other"], modelFamilies: [] });
    // Cline (ccusage 20.0.49+) runs models from many vendors; it scopes as other, like Copilot.
    expect(agentSelectionParams([agentEntry("cline")])).toEqual({ providers: ["other"], modelFamilies: [] });
    expect(agentSelectionParams([agentEntry("copilot"), agentEntry("grok"), agentEntry("codex")]).providers).toEqual(["other", "codex"]);
  });
});

describe("family token labels", () => {
  test("an Antigravity Gemini token reads as Antigravity and its family, any other token as itself", () => {
    const params = agentSelectionParams([familyEntry("antigravity", "gemini-4-neon"), modelEntry("gemini-4-argon")]);
    expect(params.modelFamilies.map(familyTokenLabel)).toEqual(["Antigravity · gemini-4-neon", "gemini-4-argon"]);
    expect(familyTokenLabel("claude-opus-5")).toBe("claude-opus-5");
  });
});

describe("Antigravity and Google in the Agent filter", () => {
  test("Gemini Antigravity ran groups under the Antigravity agent, and the agent maps to its provider", async () => {
    const { modelGroup, providerFromAgent, providerFromModel } = await import("./provider");
    expect(providerFromAgent("antigravity")).toBe("antigravity");
    // A Gemini model names no provider by itself: the agent that ran it decides.
    expect(providerFromModel("gemini-4-neon")).toBeNull();
    expect(modelGroup("gemini-4-neon", "antigravity")).toBe("antigravity");
    expect(modelGroup("gemini-3-flash", "warp")).toBe("google");
    expect(modelGroup("claude-opus-5-5", "warp")).toBe("anthropic");
    expect(providerFromModel("claude-opus-5-5")).toBe("anthropic");
    const sessions = [
      session("c", "claude", [breakdown("claude-opus-5", 1)]),
      session("g", "antigravity", [breakdown("gemini-4-neon", 1), breakdown("gemini-4-argon", 1)]),
    ];
    const tree = buildAgentTree(["claude", "antigravity"], ["claude-opus-5", "gemini-4-neon", "gemini-4-argon"], agentsByFamily(sessions));
    expect(tree.branches).toEqual([
      { agent: "claude", models: ["claude-opus-5"] },
      { agent: "antigravity", models: ["gemini-4-neon", "gemini-4-argon"] },
    ]);
    expect(tree.google).toEqual([]);
    expect(tree.unparented).toEqual([]);
    expect(agentSelectionParams([agentEntry("antigravity")])).toEqual({ providers: ["antigravity"], modelFamilies: [] });
  });

  test("Gemini another agent ran groups under Google, never under Antigravity", () => {
    const sessions = [
      session("w", "warp", [breakdown("gemini-3-flash", 1), breakdown("claude-opus-5", 1)]),
      session("g", "antigravity", [breakdown("gemini-4-neon", 1)]),
    ];
    const tree = buildAgentTree(["warp", "antigravity", "claude"], ["claude-opus-5", "gemini-3-flash", "gemini-4-neon"], agentsByFamily(sessions));
    expect(tree.branches).toEqual([
      { agent: "warp", models: [] },
      { agent: "antigravity", models: ["gemini-4-neon"] },
      // Claude in Warp keeps grouping under Anthropic.
      { agent: "claude", models: ["claude-opus-5"] },
    ]);
    expect(tree.google).toEqual(["gemini-3-flash"]);
    // Picking the Google entry selects Warp's session, not Antigravity's.
    const selection = toggleFamilyEntry([], "gemini-3-flash", tree);
    expect(selection).toEqual([modelEntry("gemini-3-flash")]);
    expect(matchesAgentSelection(sessions[0]!, selection)).toBe(true);
    expect(matchesAgentSelection(sessions[1]!, selection)).toBe(false);
    // No provider is highlighted for a Gemini family: it is not Antigravity's by name.
    expect(selectionProvider(selection)).toBeNull();
    // With no Antigravity sessions loaded, Gemini still groups under Google.
    expect(buildAgentTree(["warp"], ["gemini-3-flash"], agentsByFamily([sessions[0]!])).google).toEqual(["gemini-3-flash"]);
  });

  test("a Gemini family both agents ran is listed under each, as one entry", () => {
    const sessions = [
      session("w", "warp", [breakdown("gemini-3-flash", 1)]),
      session("g", "antigravity", [breakdown("gemini-3-flash", 1), breakdown("gemini-4-neon", 1)]),
    ];
    const tree = buildAgentTree(["warp", "antigravity"], ["gemini-3-flash", "gemini-4-neon"], agentsByFamily(sessions));
    const antigravity = tree.branches.find((branch) => branch.agent === "antigravity")!;
    expect(antigravity.models).toEqual(["gemini-3-flash", "gemini-4-neon"]);
    expect(tree.google).toEqual(["gemini-3-flash"]);
    // Checking the whole Antigravity branch leaves the Google entry unchecked: Warp's Gemini is
    // not Antigravity usage.
    const branch = toggleBranch([], antigravity, tree);
    expect(branch).toEqual([agentEntry("antigravity")]);
    expect(branch.includes(modelEntry("gemini-3-flash"))).toBe(false);
    expect(matchesAgentSelection(sessions[0]!, branch)).toBe(false);
    // Checking the Google entry then adds Warp's sessions and does not expand the branch.
    const both = toggleFamilyEntry(branch, "gemini-3-flash", tree);
    expect(both).toEqual([agentEntry("antigravity"), modelEntry("gemini-3-flash")]);
    expect(matchesAgentSelection(sessions[0]!, both)).toBe(true);
    // And unchecking it again keeps the branch.
    expect(toggleFamilyEntry(both, "gemini-3-flash", tree)).toEqual([agentEntry("antigravity")]);
  });
});

describe("a Gemini family under both Google and Antigravity is selected independently in each", () => {
  const antigravityNeon = familyEntry("antigravity", "gemini-4-neon");

  test("as Antigravity's only model, toggling the Google entry twice restores the selection", () => {
    const sessions = [
      session("w", "warp", [breakdown("gemini-4-neon", 1)]),
      session("g", "antigravity", [breakdown("gemini-4-neon", 1)]),
    ];
    const tree = buildAgentTree(["warp", "antigravity"], ["gemini-4-neon"], agentsByFamily(sessions));
    const antigravity = tree.branches.find((branch) => branch.agent === "antigravity")!;
    expect(antigravity.models).toEqual(["gemini-4-neon"]);
    expect(tree.google).toEqual(["gemini-4-neon"]);

    // The Google entry neither adds `agent:antigravity` nor checks the branch.
    const once = toggleFamilyEntry([], "gemini-4-neon", tree);
    expect(once).toEqual([modelEntry("gemini-4-neon")]);
    expect(branchState(once, antigravity)).toBe("unchecked");
    expect(matchesEntry(once, antigravity, "gemini-4-neon")).toBe(false);
    expect(matchesAgentSelection(sessions[0]!, once)).toBe(true);
    expect(matchesAgentSelection(sessions[1]!, once)).toBe(false);
    expect(toggleFamilyEntry(once, "gemini-4-neon", tree)).toEqual([]);
    // Starting from Antigravity checked, two Google toggles return to it.
    const branch = toggleBranch([], antigravity, tree);
    expect(branch).toEqual([agentEntry("antigravity")]);
    expect(toggleFamilyEntry(toggleFamilyEntry(branch, "gemini-4-neon", tree), "gemini-4-neon", tree)).toEqual(branch);

    // Toggling the Antigravity parent on and off keeps the Google choice.
    const withParent = toggleBranch(once, antigravity, tree);
    expect(withParent).toEqual([agentEntry("antigravity"), modelEntry("gemini-4-neon")]);
    expect(toggleBranch(withParent, antigravity, tree)).toEqual(once);
    // The Antigravity child is its own entry: Antigravity's sessions only. As the branch's only
    // child, checking it collapses to the agent entry, and the Google choice stays.
    const child = toggleModel([], "gemini-4-neon", tree);
    expect(child).toEqual([agentEntry("antigravity")]);
    expect(toggleModel(withParent, "gemini-4-neon", tree)).toEqual(once);
  });

  test("beside other Antigravity models, the two entries filter different sessions", () => {
    const sessions = [
      session("w", "warp", [breakdown("gemini-4-neon", 3)]),
      session("g", "antigravity", [breakdown("gemini-4-neon", 5), breakdown("gemini-4-argon", 7)]),
    ];
    const tree = buildAgentTree(["warp", "antigravity"], ["gemini-4-argon", "gemini-4-neon"], agentsByFamily(sessions));
    const antigravity = tree.branches.find((branch) => branch.agent === "antigravity")!;
    expect(antigravity.models).toEqual(["gemini-4-argon", "gemini-4-neon"]);

    const child = toggleModel([], "gemini-4-neon", tree);
    expect(child).toEqual([antigravityNeon]);
    expect(branchState(child, antigravity)).toBe("indeterminate");
    expect(matchesAgentSelection(sessions[0]!, child)).toBe(false);
    expect(matchesAgentSelection(sessions[1]!, child)).toBe(true);
    const google = toggleFamilyEntry([], "gemini-4-neon", tree);
    expect(branchState(google, antigravity)).toBe("unchecked");
    expect(matchesAgentSelection(sessions[0]!, google)).toBe(true);
    expect(matchesAgentSelection(sessions[1]!, google)).toBe(false);

    const both = toggleFamilyEntry(child, "gemini-4-neon", tree);
    expect(both).toEqual([antigravityNeon, modelEntry("gemini-4-neon")]);
    expect(toggleFamilyEntry(both, "gemini-4-neon", tree)).toEqual(child);
    // Unchecking the Antigravity child leaves the Google entry.
    expect(toggleModel(both, "gemini-4-neon", tree)).toEqual(google);
    // Unchecking the whole branch leaves it too.
    expect(toggleBranch(toggleModel(both, "gemini-4-argon", tree), antigravity, tree)).toEqual(google);

    // Daily rows split the same way.
    const row: MetricRow = {
      period: "2026-07-20", agent: "all", modelsUsed: [], inputTokens: 15, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 15, totalCost: 3,
      modelBreakdowns: [],
      agents: [
        { period: "2026-07-20", agent: "warp", modelsUsed: ["gemini-4-neon"], inputTokens: 3, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 3, totalCost: 1, modelBreakdowns: [breakdown("gemini-4-neon", 3)] },
        { period: "2026-07-20", agent: "antigravity", modelsUsed: ["gemini-4-neon", "gemini-4-argon"], inputTokens: 12, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 12, totalCost: 2, modelBreakdowns: [breakdown("gemini-4-neon", 5), breakdown("gemini-4-argon", 7)] },
      ],
    } as MetricRow;
    expect(selectAgentRow(row, google)?.totalTokens).toBe(3);
    expect(selectAgentRow(row, child)?.totalTokens).toBe(5);
    expect(selectAgentRow(row, both)?.totalTokens).toBe(8);

    // Query parameters and the URL keep the distinction.
    expect(agentSelectionParams(both)).toEqual({ providers: [], modelFamilies: ["antigravity:gemini-4-neon", "gemini-4-neon"] });
    expect(selectionProvider(child)).toBe("antigravity");
    const params = new URLSearchParams();
    writeUrlFilters(params, { ...defaultUrlFilters, agent: both });
    expect(parseUrlFilters(params).agent).toEqual(both);
  });
});
