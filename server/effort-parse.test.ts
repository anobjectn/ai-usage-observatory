import { describe, expect, test } from "bun:test";
import { buildEffortDaySeries, capEffortLevels, foldEffort, normalizeEffort } from "../src/effort-model";
import { dateKeyInTimeZone, hourInTimeZone } from "../src/reporting-time";
import { providerFromAgent } from "../src/provider";
import {
  SENSITIVE_SENTINEL,
  claudeAssistant,
  claudeUser,
  codexCompacted,
  codexMessage,
  codexTokenCount,
  codexTurnContext,
  codexUsageRecord,
  transcript,
} from "./effort-fixtures";
import {
  consumeEffortLine,
  createAccumulator,
  emptyState,
  oversizedCompactionId,
  parseEffortLine,
  startCodexReplay,
  type Agent,
  type CodexReplayPlan,
  type EffortAccumulator,
} from "./effort-parse";

const day = dateKeyInTimeZone("2026-07-01T15:00:00.000Z")!;

function run(lines: string[], agent: Agent, prefilter = true) {
  const accumulator = createAccumulator();
  const state = emptyState();
  for (const line of transcript(lines).split("\n")) consumeEffortLine(line, agent, accumulator, state, prefilter);
  return { accumulator, state, rows: [...accumulator.rows.values()] };
}

const rowFor = (accumulator: EffortAccumulator, effort: string) =>
  [...accumulator.rows.values()].filter((row) => row.effort === effort);

describe("shared reporting-time helpers", () => {
  test("uses the selected IANA timezone for calendar and hour boundaries", () => {
    const instant = "2026-07-02T03:30:00.000Z";
    expect(dateKeyInTimeZone(instant, "America/New_York")).toBe("2026-07-01");
    expect(hourInTimeZone(instant, "America/New_York")).toBe(23);
    expect(dateKeyInTimeZone(instant, "Asia/Tokyo")).toBe("2026-07-02");
    expect(hourInTimeZone(instant, "Asia/Tokyo")).toBe(12);
  });

  test("rejects unusable timestamps rather than guessing a day", () => {
    expect(dateKeyInTimeZone(undefined)).toBeNull();
    expect(dateKeyInTimeZone("not-a-date")).toBeNull();
  });
});

describe("effort normalization", () => {
  test("trims and lowercases without inferring", () => {
    expect(normalizeEffort("  High ")).toBe("high");
    expect(normalizeEffort("XHIGH")).toBe("xhigh");
    expect(normalizeEffort(undefined)).toBe("");
    expect(normalizeEffort(3)).toBe("");
  });

});

describe("Claude attribution contract", () => {
  test("maps every usage field separately and counts one observation", () => {
    const { accumulator, rows } = run([claudeAssistant({ effort: "high" })], "claude");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      occurredOn: day,
      model: "claude-opus-5",
      effort: "high",
      observations: 1,
      inputTokens: 10,
      cacheReadTokens: 100,
      cacheCreationTokens: 20,
      outputTokens: 5,
      totalTokens: 135,
    });
    expect(accumulator.attributedTokens).toBe(135);
    expect(accumulator.unknownObservations).toBe(0);
  });

  test("usage without effort still counts as an observation, in the unknown bucket", () => {
    const { accumulator, rows } = run([claudeAssistant({ effort: null })], "claude");
    expect(rows[0].effort).toBe("");
    expect(accumulator.observations).toBe(1);
    expect(accumulator.unknownObservations).toBe(1);
    expect(accumulator.attributedTokens).toBe(0);
    expect(accumulator.observedUsageTokens).toBe(135);
  });

  test("effort without usable usage contributes no observation", () => {
    const { accumulator } = run([claudeAssistant({ effort: "high", usage: null })], "claude");
    expect(accumulator.observations).toBe(0);
    expect(accumulator.rows.size).toBe(0);
  });

  test("changed effort within one session keeps both values", () => {
    const { accumulator } = run([
      claudeAssistant({ effort: "high" }),
      claudeAssistant({ effort: "low" }),
      claudeAssistant({ effort: "high" }),
    ], "claude");
    expect(rowFor(accumulator, "high")[0].observations).toBe(2);
    expect(rowFor(accumulator, "low")[0].observations).toBe(1);
  });

  test("missing model and missing date fall into sentinel buckets, not a guessed value", () => {
    const { rows } = run([claudeAssistant({ effort: "high", model: null, timestamp: null })], "claude");
    expect(rows[0].model).toBe("");
    expect(rows[0].occurredOn).toBe("");
  });

  test("a malformed assistant line is a parser gap; an unrelated malformed line is not", () => {
    const { accumulator } = run(["{\"type\":\"assistant\", broken", "{ also broken"], "claude");
    expect(accumulator.parseErrors).toBe(1);
  });

  test("does not read effort from message content", () => {
    const line = claudeAssistant({ effort: null }).replace(SENSITIVE_SENTINEL, "effort: high");
    const { rows } = run([line], "claude");
    expect(rows[0].effort).toBe("");
  });
});

describe("Codex attribution contract", () => {
  test("classifies embedded quota windows by duration and converts reset seconds to milliseconds", () => {
    const line = JSON.stringify({
      timestamp: "2026-07-01T15:01:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          primary: { used_percent: 25.5, window_minutes: 10_080, resets_at: 1_788_460_725 },
          secondary: { used_percent: 49.25, window_minutes: 300, resets_at: 1_787_940_980 },
        },
      },
    });
    const { accumulator } = run([line], "codex");
    expect(accumulator.quotaObservations).toEqual([
      {
        observedAt: Date.parse("2026-07-01T15:01:00.000Z"),
        resourceId: "weekly",
        usedPercent: 25.5,
        resetsAt: 1_788_460_725_000,
        cycleId: "reset:1788460680000",
        planId: null,
        planSource: "unknown",
      },
      {
        observedAt: Date.parse("2026-07-01T15:01:00.000Z"),
        resourceId: "fiveHour",
        usedPercent: 49.25,
        resetsAt: 1_787_940_980_000,
        cycleId: "reset:1787940960000",
        planId: null,
        planSource: "unknown",
      },
    ]);
  });

  test("accepts one embedded quota window and ignores replayed parent quota history", () => {
    const quota = (percent: number) => JSON.stringify({
      timestamp: "2026-07-01T15:01:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: { primary: { used_percent: percent, window_minutes: 300, resets_at: 1_787_940_980 } },
      },
    });
    const { accumulator } = run([
      JSON.stringify({ type: "session_meta", payload: { id: "child" } }),
      quota(10.5),
      JSON.stringify({ type: "session_meta", payload: { id: "parent" } }),
      quota(99),
    ], "codex");
    expect(accumulator.quotaObservations.map((row) => row.usedPercent)).toEqual([10.5]);
  });

  test("turn_context establishes state and counts one observation even with no later usage", () => {
    const { accumulator, rows } = run([codexTurnContext({ effort: "high" })], "codex");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ effort: "high", model: "gpt-5.4", observations: 1, totalTokens: 0 });
    expect(accumulator.observations).toBe(1);
  });

  test("cached and reasoning tokens are subsets and are never added twice", () => {
    const { rows } = run([
      codexTurnContext({ effort: "high" }),
      codexTokenCount({}),
    ], "codex");
    const usage = rows.find((row) => row.totalTokens > 0)!;
    // input_tokens 1000 includes cached_input_tokens 400; reasoning 25 is inside output 60.
    expect(usage).toMatchObject({
      inputTokens: 600,
      cacheReadTokens: 400,
      cacheCreationTokens: 0,
      outputTokens: 60,
      reasoningOutputTokens: 25,
      reasoningReportedEvents: 1,
      totalTokens: 1060,
    });
    expect(usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens + usage.outputTokens).toBe(1060);
  });

  test("multiple usage events attach to the active context until the next turn_context", () => {
    const { accumulator } = run([
      codexTurnContext({ effort: "high" }),
      codexTokenCount({ timestamp: "2026-07-01T15:01:00.000Z" }),
      codexTokenCount({ timestamp: "2026-07-01T15:02:00.000Z" }),
      codexTurnContext({ effort: "low", model: "gpt-5.4" }),
      codexTokenCount({ timestamp: "2026-07-01T15:03:00.000Z" }),
    ], "codex");
    expect(rowFor(accumulator, "high").reduce((sum, row) => sum + row.totalTokens, 0)).toBe(2120);
    expect(rowFor(accumulator, "low").reduce((sum, row) => sum + row.totalTokens, 0)).toBe(1060);
  });

  test("repeated token_count events match ccusage de-duplication across parser spans", () => {
    // No cumulative total, so only the timestamp + usage key can recognize the repeat.
    const repeated = JSON.stringify({
      timestamp: "2026-07-01T15:01:00.000Z",
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 60, reasoning_output_tokens: 25, total_tokens: 1060 } } },
    });
    const state = emptyState();
    const firstSpan = createAccumulator();
    consumeEffortLine(codexTurnContext({ effort: "high" }), "codex", firstSpan, state);
    consumeEffortLine(repeated, "codex", firstSpan, state);
    const secondSpan = createAccumulator();
    consumeEffortLine(repeated, "codex", secondSpan, state);
    expect(firstSpan.observedUsageTokens + secondSpan.observedUsageTokens).toBe(1060);
  });

  test("a re-emitted snapshot whose cumulative total did not advance adds no usage", () => {
    const total = { input_tokens: 5000, cached_input_tokens: 0, output_tokens: 300, reasoning_output_tokens: 0, total_tokens: 5300 };
    const { accumulator } = run([
      codexTurnContext({ effort: "high" }),
      codexTokenCount({ total, timestamp: "2026-07-01T15:01:00.000Z" }),
      codexTokenCount({ total, timestamp: "2026-07-01T15:01:30.000Z" }),
    ], "codex");
    expect(accumulator.observedUsageTokens).toBe(1060);
  });

  test("a record that states only the cumulative total adds the growth since the previous one", () => {
    const cumulative = (input: number, output: number) => JSON.stringify({
      timestamp: "2026-07-01T15:01:00.000Z",
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output } } },
    });
    const { accumulator } = run([codexTurnContext({ effort: "high" }), cumulative(1000, 100), cumulative(1500, 150)], "codex");
    expect(accumulator.observedUsageTokens).toBe(1650);
  });

  const parentUsage = { inputTokens: 1000, cachedInputTokens: 400, cacheCreationTokens: 0, outputTokens: 60, reasoningOutputTokens: 25, totalTokens: 1060 };
  const forkLines = (ownTimestamp: string) => [
    JSON.stringify({ type: "session_meta", payload: { id: "child", forked_from_id: "parent" } }),
    JSON.stringify({ type: "session_meta", payload: { id: "parent" } }),
    codexTurnContext({ effort: "high" }),
    codexTokenCount({ timestamp: "2026-07-01T15:01:00.000Z" }),
    codexTokenCount({ timestamp: "2026-07-01T15:01:00.020Z" }),
    JSON.stringify({ type: "event_msg", payload: { type: "thread_rolled_back" } }),
    codexTurnContext({ effort: "low" }),
    codexTokenCount({ timestamp: ownTimestamp }),
  ];
  const runFork = (plan: CodexReplayPlan, ownTimestamp = "2026-07-01T15:02:00.000Z") => {
    const accumulator = createAccumulator();
    const state = { ...emptyState(), codexReplayPlan: plan, codexReplay: { phase: "matching" as const, index: 0 } };
    for (const line of forkLines(ownTimestamp)) consumeEffortLine(line, "codex", accumulator, state);
    return { accumulator, state };
  };

  test("a fork subtracts the usage its parent recorded and keeps its own", () => {
    const { accumulator, state } = runFork({ prefix: [parentUsage, parentUsage], burstStart: null });
    expect(accumulator.observations).toBe(1);
    expect(accumulator.observedUsageTokens).toBe(1060);
    expect(rowFor(accumulator, "low")[0].totalTokens).toBe(1060);
    expect(rowFor(accumulator, "high")).toEqual([]);
    expect(state.codexSessionKey).toBe("child");
    expect(state.codexReplaying).toBe(false);
    expect(state.codexReplay).toBeNull();
  });

  test("a parent prefix shorter than the copied history stops masking at its end", () => {
    const { accumulator } = runFork({ prefix: [parentUsage], burstStart: null });
    expect(accumulator.observedUsageTokens).toBe(2120);
  });

  test("a fork without its parent log skips the rewritten burst, then counts after the pause", () => {
    const { accumulator, state } = runFork({ prefix: [], burstStart: Date.parse("2026-07-01T15:01:00.000Z") });
    expect(accumulator.observedUsageTokens).toBe(1060);
    expect(rowFor(accumulator, "low")[0].totalTokens).toBe(1060);
    expect(state.codexReplay).toBeNull();
  });

  test("a fork whose first records pause between them copied nothing", () => {
    const { accumulator } = runFork({ prefix: [], burstStart: null });
    expect(accumulator.observedUsageTokens).toBe(3180);
  });

  test("embedded history in a rollout that is not a fork is counted, as ccusage counts it, but never attributed", () => {
    const { accumulator } = run(forkLines("2026-07-01T15:02:00.000Z"), "codex");
    expect(accumulator.observedUsageTokens).toBe(3180);
    expect(rowFor(accumulator, "high")).toEqual([]);
    expect(rowFor(accumulator, "")[0].totalTokens).toBe(2120);
    expect(rowFor(accumulator, "low")[0].totalTokens).toBe(1060);
  });

  test("an ordinary rollback preserves the active effort context", () => {
    const rollback = JSON.stringify({ type: "event_msg", payload: { type: "thread_rolled_back" } });
    const { accumulator } = run([
      JSON.stringify({ type: "session_meta", payload: { id: "session" } }),
      codexTurnContext({ effort: "high" }),
      rollback,
      codexTokenCount({ timestamp: "2026-07-01T15:02:00.000Z" }),
    ], "codex");
    expect(accumulator.contextGaps).toBe(0);
    expect(accumulator.attributedTokens).toBe(1060);
  });

  test("empty usage sentinels are dropped, including their nonzero total_tokens", () => {
    const { accumulator } = run([
      codexTurnContext({ effort: "high" }),
      codexTokenCount({ last: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 47_824 } }),
    ], "codex");
    expect(accumulator.observedUsageTokens).toBe(0);
    expect(accumulator.parseErrors).toBe(0);
  });

  test("tokens with no active context go to Unknown and record a context gap", () => {
    const { accumulator } = run([codexTokenCount({})], "codex");
    expect(accumulator.contextGaps).toBe(1);
    expect(accumulator.attributedTokens).toBe(0);
    expect(rowFor(accumulator, "")[0].totalTokens).toBe(1060);
  });

  test("a skipped relevant line clears active attribution before later token events", () => {
    const { accumulator } = run([
      codexTurnContext({ effort: "high" }),
      "{\"type\":\"turn_context\", truncated",
      codexTokenCount({}),
    ], "codex");
    expect(accumulator.parseErrors).toBe(1);
    expect(accumulator.contextGaps).toBe(1);
    expect(accumulator.attributedTokens).toBe(0);
  });

  test("an unsupported token shape is an error, never a clamped healthy row", () => {
    const accumulator = createAccumulator();
    const state = emptyState();
    parseEffortLine(codexTurnContext({ effort: "high" }), "codex", accumulator, state);
    expect(() => parseEffortLine(
      codexTokenCount({ last: { input_tokens: 10, cached_input_tokens: 90, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 15 } }),
      "codex", accumulator, state,
    )).toThrow();
    expect(() => parseEffortLine(
      codexTokenCount({ last: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 9, total_tokens: 105 } }),
      "codex", accumulator, state,
    )).toThrow();
    expect(() => parseEffortLine(
      codexTokenCount({ last: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 1, total_tokens: 999 } }),
      "codex", accumulator, state,
    )).toThrow();
    expect(accumulator.observedUsageTokens).toBe(0);
  });

  test("turn_context without effort is an unknown observation, not a dropped one", () => {
    const { accumulator } = run([codexTurnContext({ effort: null }), codexTokenCount({})], "codex");
    expect(accumulator.observations).toBe(1);
    expect(accumulator.unknownObservations).toBe(1);
    expect(accumulator.attributedTokens).toBe(0);
    expect(accumulator.observedUsageTokens).toBe(1060);
  });
});

describe("Codex compaction usage", () => {
  // The fixture record: 2000 input (500 cached) and 300 output, 2300 in total.
  const compactionTokens = 2300;
  const ordinaryTokens = 1060;

  test("a remote compaction's usage record counts once its compacted item names it", () => {
    const { accumulator, state } = run([
      codexTurnContext({ effort: "high" }),
      codexTokenCount({}),
      codexUsageRecord({ responseId: "resp_remote" }),
      codexCompacted("resp_remote"),
    ], "codex");
    expect(accumulator.observedUsageTokens).toBe(ordinaryTokens + compactionTokens);
    expect(rowFor(accumulator, "high")[0]).toMatchObject({ cacheReadTokens: 400 + 500, inputTokens: 600 + 1500, outputTokens: 360 });
    expect(state.codexCompaction?.pending.size).toBe(0);
  });

  test("the pair counts in either record order", () => {
    const { accumulator } = run([
      codexTurnContext({ effort: "high" }),
      codexCompacted("resp_first"),
      codexUsageRecord({ responseId: "resp_first" }),
    ], "codex");
    expect(accumulator.observedUsageTokens).toBe(compactionTokens);
  });

  test("a usage record no compacted item names is an ordinary response, already in token_count", () => {
    const { accumulator } = run([
      codexTurnContext({ effort: "high" }),
      codexUsageRecord({ responseId: "resp_turn" }),
      codexTokenCount({}),
    ], "codex");
    expect(accumulator.observedUsageTokens).toBe(ordinaryTokens);
  });

  test("a local compaction whose advancing snapshot already counted the request is not added again", () => {
    const usage = { input_tokens: 2000, cached_input_tokens: 500, output_tokens: 300, reasoning_output_tokens: 100, total_tokens: 2300 };
    const { accumulator } = run([
      codexTurnContext({ effort: "high" }),
      codexUsageRecord({ responseId: "resp_local" }),
      codexTokenCount({ last: usage }),
      codexCompacted("resp_local"),
    ], "codex");
    expect(accumulator.observedUsageTokens).toBe(compactionTokens);
  });

  test("a snapshot whose cumulative total equals the record's thread usage covers it", () => {
    const thread = { input_tokens: 9000, cached_input_tokens: 1000, cache_write_input_tokens: 0, output_tokens: 700, reasoning_output_tokens: 200, total_tokens: 9700 };
    const { accumulator } = run([
      codexTurnContext({ effort: "high" }),
      codexUsageRecord({ responseId: "resp_local", thread }),
      codexTokenCount({ total: thread }),
      codexCompacted("resp_local"),
    ], "codex");
    expect(accumulator.observedUsageTokens).toBe(ordinaryTokens);
  });

  test("only the latest usage record can be covered by a snapshot", () => {
    const usage = { input_tokens: 2000, cached_input_tokens: 500, output_tokens: 300, reasoning_output_tokens: 100, total_tokens: 2300 };
    const { accumulator } = run([
      codexTurnContext({ effort: "high" }),
      codexUsageRecord({ responseId: "resp_remote" }),
      codexUsageRecord({ responseId: "resp_other", usage: { ...usage, output_tokens: 1, total_tokens: 2001 } }),
      codexTokenCount({ last: usage }),
      codexCompacted("resp_remote"),
    ], "codex");
    expect(accumulator.observedUsageTokens).toBe(2 * compactionTokens);
  });

  test("a copied compaction counts once, and compaction usage leaves the turn context alone", () => {
    const { accumulator, state } = run([
      codexTurnContext({ effort: "high", model: "gpt-6-sol" }),
      codexUsageRecord({ responseId: "resp_copy" }),
      codexCompacted("resp_copy"),
      codexUsageRecord({ responseId: "resp_copy" }),
      codexCompacted("resp_copy"),
      codexTokenCount({}),
    ], "codex");
    expect(accumulator.observedUsageTokens).toBe(compactionTokens + ordinaryTokens);
    expect(rowFor(accumulator, "high")).toEqual([expect.objectContaining({ model: "gpt-6-sol", totalTokens: compactionTokens + ordinaryTokens })]);
    expect(state).toMatchObject({ effort: "high", model: "gpt-6-sol", active: true });
  });

  test("a fork skips compactions its parent made before the fork, and counts its own", () => {
    const accumulator = createAccumulator();
    const state = emptyState();
    startCodexReplay(state, { prefix: [], burstStart: null, compactions: new Set(["resp_parent"]) });
    for (const line of [
      codexTurnContext({ effort: "high" }),
      codexUsageRecord({ responseId: "resp_parent" }),
      codexCompacted("resp_parent"),
      codexUsageRecord({ responseId: "resp_child" }),
      codexCompacted("resp_child"),
    ]) consumeEffortLine(line, "codex", accumulator, state);
    expect(accumulator.observedUsageTokens).toBe(compactionTokens);
  });

  test("an empty or unnamed compaction adds nothing", () => {
    const zero = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
    const { accumulator } = run([
      codexTurnContext({ effort: "high" }),
      codexUsageRecord({ responseId: "resp_empty", usage: zero }),
      codexCompacted("resp_empty"),
      codexCompacted(null),
    ], "codex");
    expect(accumulator.observedUsageTokens).toBe(0);
  });

  test("the response of an over-limit compacted line is read from its tail", () => {
    const line = codexCompacted("resp_tail", { padding: "x".repeat(10_000) });
    expect(oversizedCompactionId(line.slice(0, 1024), line.slice(-4096))).toBe("resp_tail");
    // A key quoted inside the history is escaped, so it cannot be mistaken for the item's own.
    const quoted = codexCompacted(null, { padding: "\"compaction_response_id\":\"resp_fake\"" });
    expect(oversizedCompactionId(quoted.slice(0, 1024), quoted.slice(-4096))).toBeNull();
    expect(oversizedCompactionId(codexMessage().slice(0, 1024), line.slice(-4096))).toBeNull();
  });
});

describe("prefilter equivalence", () => {
  const claudeLines = [
    claudeUser(),
    claudeAssistant({ effort: "high" }),
    claudeAssistant({ effort: null }),
    "{\"type\":\"assistant\", broken",
    "{ irrelevant broken",
  ];
  const codexLines = [
    codexMessage(),
    codexTurnContext({ effort: "medium" }),
    codexTokenCount({}),
    codexUsageRecord({ responseId: "resp_remote" }),
    codexCompacted("resp_remote"),
    "{\"type\":\"turn_context\", broken",
    "{ irrelevant broken",
    codexTokenCount({}),
    JSON.stringify({ type: "session_meta", payload: { id: "session" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "thread_rolled_back" } }),
    codexTokenCount({}),
  ];

  test("prefilter-on and prefilter-off produce identical aggregates and quality counters", () => {
    for (const [agent, lines] of [["claude", claudeLines], ["codex", codexLines]] as const) {
      const on = run([...lines], agent, true);
      const off = run([...lines], agent, false);
      expect(off.rows).toEqual(on.rows);
      expect(off.accumulator.parseErrors).toBe(on.accumulator.parseErrors);
      expect(off.accumulator.contextGaps).toBe(on.accumulator.contextGaps);
      expect(off.accumulator.observations).toBe(on.accumulator.observations);
      expect(off.accumulator.observedUsageTokens).toBe(on.accumulator.observedUsageTokens);
    }
  });

});

describe("reconciliation against pinned ccusage-style totals", () => {
  test("known plus unknown equals the eligible denominator", () => {
    const { accumulator } = run([
      claudeAssistant({ effort: "high" }),
      claudeAssistant({ effort: "low" }),
      claudeAssistant({ effort: null }),
    ], "claude");
    const eligibleTokens = accumulator.observedUsageTokens; // pinned ccusage total for the fixture
    const summary = foldEffort(
      [...accumulator.rows.values()].map((row) => ({ effort: row.effort, observations: row.observations, tokens: row.totalTokens })),
      { eligibleTokens, unknownObservations: accumulator.unknownObservations, quality: "ok" },
    );
    expect(summary.attributedTokens + (summary.unknownTokens ?? 0)).toBe(eligibleTokens);
    expect(summary.unknownTokens).toBe(135);
    expect(summary.observationCoverage).toBeCloseTo(2 / 3, 10);
    expect(summary.coverageState).toBe("partial");
    expect(summary.mixed).toBe(true);
  });

  test("a positive reconciliation delta degrades and suppresses every token share", () => {
    const summary = foldEffort([{ effort: "high", observations: 2, tokens: 500 }], { eligibleTokens: 400, unknownObservations: 0, quality: "ok" });
    expect(summary.reconciliationDeltaTokens).toBe(100);
    expect(summary.quality).toBe("degraded");
    expect(summary.unknownTokens).toBeNull();
    expect(summary.tokenCoverage).toBeNull();
    expect(summary.levels[0].tokenShare).toBeNull();
    expect(summary.dominantBasis).toBe("observations");
  });

  test("complete coverage requires no unknown tokens, no unknown observations, and ok quality", () => {
    const summary = foldEffort([{ effort: "high", observations: 3, tokens: 900 }], { eligibleTokens: 900, unknownObservations: 0, quality: "ok" });
    expect(summary.coverageState).toBe("complete");
    expect(summary.tokenCoverage).toBe(1);
    expect(summary.dominantBasis).toBe("tokens");
    expect(summary.mixed).toBe(false);
  });

  test("an empty scope is unavailable rather than a zero-filled chart", () => {
    const summary = foldEffort([], { eligibleTokens: 5_000, unknownObservations: 0, quality: "ok" });
    expect(summary.coverageState).toBe("unavailable");
    expect(summary.dominant).toBeNull();
    expect(summary.levels).toEqual([]);
  });

  test("display capping preserves totals", () => {
    const levels = ["a", "b", "c", "d", "e", "f", "g"].map((effort, index) => ({ effort, observations: index + 1, tokens: (index + 1) * 100 }));
    const capped = capEffortLevels(levels);
    expect(capped).toHaveLength(6);
    expect(capped.reduce((sum, level) => sum + level.tokens, 0)).toBe(levels.reduce((sum, level) => sum + level.tokens, 0));
    expect(capped.at(-1)).toMatchObject({ effort: "other", tokens: 300, observations: 3 });
  });
});

describe("provider identity", () => {
  test("one mapper covers the collector and insights vocabularies", () => {
    expect(providerFromAgent("claude")).toBe("anthropic");
    expect(providerFromAgent("claude-code")).toBe("anthropic");
    expect(providerFromAgent("Anthropic")).toBe("anthropic");
    expect(providerFromAgent("codex")).toBe("codex");
    expect(providerFromAgent("openai")).toBe("codex");
    expect(providerFromAgent("gemini")).toBeNull();
  });
});

describe("privacy traps", () => {
  test("no parsed row or counter carries transcript text", () => {
    const claude = run([claudeUser(), claudeAssistant({ effort: "high" })], "claude");
    const codex = run([codexMessage(), codexTurnContext({ effort: "high" }), codexTokenCount({})], "codex");
    for (const result of [claude, codex]) {
      expect(JSON.stringify(result.rows)).not.toContain(SENSITIVE_SENTINEL);
      expect(JSON.stringify(result.state)).not.toContain(SENSITIVE_SENTINEL);
    }
  });
});

describe("Claude repeated-response contract", () => {
  test("a contiguous repeat of one response is counted once", () => {
    const repeat = { effort: "high", requestId: "req_a", messageId: "msg_a" };
    const { accumulator, rows } = run([
      claudeAssistant(repeat),
      claudeAssistant(repeat),
      claudeAssistant(repeat),
    ], "claude");
    expect(rows).toHaveLength(1);
    expect(accumulator.observations).toBe(1);
    expect(accumulator.observedUsageTokens).toBe(135);
    expect(accumulator.attributedTokens).toBe(135);
  });

  test("distinct responses are all counted, including a later repeat of an earlier key", () => {
    const { accumulator } = run([
      claudeAssistant({ effort: "high", requestId: "req_a", messageId: "msg_a" }),
      claudeAssistant({ effort: "high", requestId: "req_b", messageId: "msg_b" }),
      // Claude only ever writes repeats contiguously, so a returning key is a real new response.
      claudeAssistant({ effort: "high", requestId: "req_a", messageId: "msg_a" }),
    ], "claude");
    expect(accumulator.observations).toBe(3);
    expect(accumulator.observedUsageTokens).toBe(405);
  });

  test("an event with no identifiers is never collapsed into its neighbour", () => {
    const { accumulator } = run([
      claudeAssistant({ effort: "high", requestId: "", messageId: "" }),
      claudeAssistant({ effort: "high", requestId: "", messageId: "" }),
    ], "claude");
    expect(accumulator.observations).toBe(2);
  });

  test("a parser gap forgets the dedupe key rather than dropping the next response", () => {
    const { accumulator } = run([
      claudeAssistant({ effort: "high", requestId: "req_a", messageId: "msg_a" }),
      "{\"type\":\"assistant\", broken",
      claudeAssistant({ effort: "high", requestId: "req_a", messageId: "msg_a" }),
    ], "claude");
    expect(accumulator.parseErrors).toBe(1);
    expect(accumulator.observations).toBe(2);
  });
});

describe("daily effort series", () => {
  const day = (date: string, levels: Array<[string, number, number]>, unknownTokens: number, delta = 0) => ({
    key: date,
    summary: {
      ...foldEffort(levels.map(([effort, observations, tokens]) => ({ effort, observations, tokens })), {
        eligibleTokens: levels.reduce((sum, [, , tokens]) => sum + tokens, 0) + unknownTokens,
        unknownObservations: 0,
        quality: "ok" as const,
      }),
      reconciliationDeltaTokens: delta,
    },
  });

  test("keeps one stable key set across the range, ordered by volume, rather than per day", () => {
    const { keys, points } = buildEffortDaySeries([
      day("2026-07-01", [["low", 1, 100]], 0),
      day("2026-07-02", [["high", 1, 900]], 0),
    ], "tokens");
    expect(keys).toEqual(["high", "low", "unknown"]);
    expect(points[0].values).toEqual({ low: 100, high: 0, unknown: 0 });
    expect(points[1].values).toEqual({ low: 0, high: 900, unknown: 0 });
  });

  test("capping collapses the remainder into Other and preserves the day total", () => {
    const levels = ["a", "b", "c", "d", "e", "f", "g"].map((effort, index): [string, number, number] => [effort, 1, (index + 1) * 100]);
    const { keys, points } = buildEffortDaySeries([day("2026-07-01", levels, 0)], "tokens");
    expect(keys).toContain("other");
    expect(keys.filter((key) => key !== "other" && key !== "unknown")).toHaveLength(5);
    expect(points[0].total).toBe(levels.reduce((sum, [, , tokens]) => sum + tokens, 0));
  });

  test("Unknown stays in the stack on the requested basis", () => {
    const tokens = buildEffortDaySeries([day("2026-07-01", [["high", 2, 700]], 300)], "tokens");
    expect(tokens.points[0].values.unknown).toBe(300);
    const observations = buildEffortDaySeries([{
      key: "2026-07-01",
      summary: foldEffort([{ effort: "high", observations: 2, tokens: 700 }], { eligibleTokens: 1_000, unknownObservations: 5, quality: "ok" }),
    }], "observations");
    expect(observations.points[0].values).toEqual({ high: 2, unknown: 5 });
  });

  test("a day whose reconciliation failed draws nothing and is counted", () => {
    const { points, suppressedDays } = buildEffortDaySeries([
      day("2026-07-01", [["high", 1, 500]], 0),
      day("2026-07-02", [["high", 1, 500]], 0, 250),
    ], "tokens");
    expect(suppressedDays).toBe(1);
    expect(points[1].suppressed).toBe(true);
    expect(points[1].total).toBe(0);
    // A suppressed day must not influence which values the range keeps either.
    expect(points[0].total).toBe(500);
  });

  test("an empty range yields no drawable points", () => {
    const { keys, points } = buildEffortDaySeries([], "tokens");
    expect(keys).toEqual(["unknown"]);
    expect(points).toEqual([]);
  });
});
