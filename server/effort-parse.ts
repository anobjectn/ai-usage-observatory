import { normalizeEffort } from "../src/effort-model";
import { dateKeyInTimeZone } from "../src/reporting-time";

/** Bumping this rebuilds every session from byte zero. The constant lives in code, never in the
 * database, so a checkout can never disagree with the rows it is reading. */
export const PARSER_VERSION = 8;

/** A single line is buffered only up to this size. Crossing it records a gap and a skipped-byte
 * count; no transcript fragment is ever persisted. */
export const MAX_LINE_BYTES = 4 * 1024 * 1024;

export type Agent = "claude" | "codex";

/** Internal empty-string sentinels ('' date / '' model / '' effort) stay inside the parser and
 * the store. `server/effort-store.ts` alone converts them to typed nulls at the boundary. */
export type EffortUsageRow = {
  occurredOn: string;
  model: string;
  effort: string;
  observations: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  reasoningReportedEvents: number;
  totalTokens: number;
};

export type EffortParserState = {
  effort: string | null;
  model: string | null;
  active: boolean;
  /** Both providers can repeat a usage event contiguously. Carrying the last provider-specific
   * key across chunks and spans keeps the effort totals aligned with ccusage. */
  lastUsageKey: string | null;
  /** The first Codex session_meta identifies the rollout being indexed. Forked rollouts can then
   * embed parent history under another id; those replayed events are not new billable activity. */
  codexSessionKey: string | null;
  codexReplaying: boolean;
  /** The last cumulative `total_token_usage` seen. Codex re-emits a `last_token_usage` snapshot
   * without advancing the cumulative total; ccusage counts such a snapshot once. */
  codexPreviousTotals: CodexRawUsage | null;
  /** Where a forked rollout stands in the usage it copied from its parent. Null for a rollout
   * that is not a fork, and again once the copied history has been passed. */
  codexReplay: CodexReplayProgress | null;
  /** Supplied by the indexer for a fork, never persisted: it is rebuilt from the parent log. */
  codexReplayPlan: CodexReplayPlan | null;
};

/** One Codex usage record exactly as the rollout states it, before input is split from cache. */
export type CodexRawUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

/** `prefix` is the usage the parent recorded up to the fork instant; empty when the parent log
 * is unavailable. `burstStart` is the timestamp of the rollout's first usage record when its
 * first two records were written within a second of each other, the mark of a rewritten replay. */
export type CodexReplayPlan = { prefix: CodexRawUsage[]; burstStart: number | null };

export type CodexReplayProgress = { phase: "matching"; index: number } | { phase: "burst"; last: number };

/** Longest pause inside a rewritten replay burst. Mirrors ccusage: bursts span tens of
 * milliseconds, while a fork's own first turn follows a pause of several seconds. */
export const CODEX_REPLAY_BURST_PAUSE_MS = 1_000;

export type EffortAccumulator = {
  rows: Map<string, EffortUsageRow>;
  observations: number;
  unknownObservations: number;
  observedUsageTokens: number;
  attributedTokens: number;
  parseErrors: number;
  contextGaps: number;
  skippedBytes: number;
  activityTimestamps: number[];
  quotaObservations: EmbeddedQuotaObservation[];
};

export type EmbeddedQuotaObservation = {
  observedAt: number;
  resourceId: "fiveHour" | "weekly";
  usedPercent: number;
  resetsAt: number | null;
  cycleId: string;
  planId: string | null;
  planSource: "provider" | "unknown";
};

export const emptyState = (): EffortParserState => ({
  effort: null,
  model: null,
  active: false,
  lastUsageKey: null,
  codexSessionKey: null,
  codexReplaying: false,
  codexPreviousTotals: null,
  codexReplay: null,
  codexReplayPlan: null,
});

export function createAccumulator(): EffortAccumulator {
  return {
    rows: new Map(),
    observations: 0,
    unknownObservations: 0,
    observedUsageTokens: 0,
    attributedTokens: 0,
    parseErrors: 0,
    contextGaps: 0,
    skippedBytes: 0,
    activityTimestamps: [],
    quotaObservations: [],
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function epochMs(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 100_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function recordActivity(accumulator: EffortAccumulator, row: Record<string, unknown>, payload?: Record<string, unknown>) {
  const timestamp = epochMs(row.timestamp ?? payload?.timestamp);
  if (timestamp !== null) accumulator.activityTimestamps.push(timestamp);
  return timestamp;
}

function bucket(accumulator: EffortAccumulator, occurredOn: string, model: string, effort: string) {
  const key = `${occurredOn}\0${model}\0${effort}`;
  const existing = accumulator.rows.get(key);
  if (existing) return existing;
  const created: EffortUsageRow = {
    occurredOn, model, effort,
    observations: 0, inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    outputTokens: 0, reasoningOutputTokens: 0, reasoningReportedEvents: 0, totalTokens: 0,
  };
  accumulator.rows.set(key, created);
  return created;
}

function addObservation(accumulator: EffortAccumulator, row: EffortUsageRow) {
  row.observations++;
  accumulator.observations++;
  if (row.effort === "") accumulator.unknownObservations++;
}

function addTokens(accumulator: EffortAccumulator, row: EffortUsageRow, tokens: Omit<EffortUsageRow, "occurredOn" | "model" | "effort" | "observations">) {
  row.inputTokens += tokens.inputTokens;
  row.cacheReadTokens += tokens.cacheReadTokens;
  row.cacheCreationTokens += tokens.cacheCreationTokens;
  row.outputTokens += tokens.outputTokens;
  row.reasoningOutputTokens += tokens.reasoningOutputTokens;
  row.reasoningReportedEvents += tokens.reasoningReportedEvents;
  row.totalTokens += tokens.totalTokens;
  accumulator.observedUsageTokens += tokens.totalTokens;
  if (row.effort !== "") accumulator.attributedTokens += tokens.totalTokens;
}

/** Cheap substring gate applied to the raw line before `JSON.parse`. It must stay a strict
 * superset of what the structured handlers accept, which the prefilter-equivalence test proves. */
export function hasProviderMarker(line: string, agent: Agent) {
  return agent === "claude"
    ? line.includes("\"assistant\"")
    : line.includes("session_meta")
      || line.includes("thread_rolled_back")
      || line.includes("turn_context")
      || line.includes("token_count");
}

/** A malformed or over-limit line carrying a provider marker is a parser gap, not a skip.
 * For Codex the active attribution is cleared so later token events cannot be credited to an
 * effort that the skipped line may have changed. */
export function recordParserGap(accumulator: EffortAccumulator, state: EffortParserState, agent: Agent, skippedBytes = 0) {
  accumulator.parseErrors++;
  accumulator.skippedBytes += skippedBytes;
  if (agent === "codex") {
    state.effort = null;
    state.model = null;
    state.active = false;
  }
  // A skipped Claude line may have been a new response; forget the dedupe key rather than risk
  // discarding the next real one.
  state.lastUsageKey = null;
}

/** Bytes of an over-limit line worth inspecting. Both providers name the event type inside the
 * first few hundred bytes; nothing past this point is ever decoded. */
export const OVERSIZED_HEAD_BYTES = 1024;

const boundaryMarkers = ["\"turn_context\"", "\"session_meta\"", "\"thread_rolled_back\""];

/** Classifies an over-limit line from its head alone. A `compacted` replay or an inline image
 * runs to many megabytes and carries no usage; treating it as a gap would clear a Codex
 * session's attribution for every token event until the next turn boundary. Only a line whose
 * head names an attribution boundary (or whose type cannot be read at all) still clears state. */
export function recordOversizedLine(accumulator: EffortAccumulator, state: EffortParserState, agent: Agent, length: number, head: string) {
  const typed = /"type"\s*:\s*"/.test(head);
  const relevant = agent === "claude"
    ? head.includes("\"assistant\"")
    : boundaryMarkers.some((marker) => head.includes(marker));
  if (typed && !relevant && !(agent === "codex" && head.includes("\"token_count\""))) {
    // Skipped by size, not by shape: the head proves the line could not have carried a boundary
    // or a usage record, so it is no more a parser gap than a prefiltered line would be.
    accumulator.skippedBytes += length;
    return;
  }
  if (agent === "codex" && typed && !relevant) {
    // A usage record too large to read loses its tokens, but it never changes which model and
    // effort the following records belong to.
    accumulator.parseErrors++;
    accumulator.skippedBytes += length;
    state.lastUsageKey = null;
    return;
  }
  recordParserGap(accumulator, state, agent, length);
}

function claudeLine(row: Record<string, unknown>, accumulator: EffortAccumulator, state: EffortParserState) {
  if (row.type !== "assistant" || !record(row.message)) return false;
  const usage = row.message.usage;
  if (!record(usage)) return false;
  const inputTokens = count(usage.input_tokens) ?? 0;
  const cacheReadTokens = count(usage.cache_read_input_tokens) ?? 0;
  const cacheCreationTokens = count(usage.cache_creation_input_tokens) ?? 0;
  const outputTokens = count(usage.output_tokens) ?? 0;
  const present = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"]
    .filter((field) => usage[field] !== undefined);
  if (present.length === 0) return false;
  if (present.some((field) => count(usage[field]) === null)) throw new Error("unsupported Claude usage shape");

  const requestId = typeof row.requestId === "string" ? row.requestId : "";
  const messageId = typeof row.message.id === "string" ? row.message.id : "";
  const usageKey = requestId || messageId ? `${requestId}|${messageId}` : "";
  // A repeat of the immediately preceding response is not a new observation and its tokens have
  // already been counted.
  if (usageKey !== "" && usageKey === state.lastUsageKey) return true;
  state.lastUsageKey = usageKey === "" ? null : usageKey;
  recordActivity(accumulator, row, row.message);

  const occurredOn = dateKeyInTimeZone(row.timestamp) ?? "";
  const model = typeof row.message.model === "string" ? row.message.model : "";
  const target = bucket(accumulator, occurredOn, model, normalizeEffort(row.effort));
  addObservation(accumulator, target);
  addTokens(accumulator, target, {
    inputTokens, cacheReadTokens, cacheCreationTokens, outputTokens,
    reasoningOutputTokens: 0, reasoningReportedEvents: 0,
    totalTokens: inputTokens + cacheReadTokens + cacheCreationTokens + outputTokens,
  });
  return true;
}

function codexTurnContext(row: Record<string, unknown>, payload: Record<string, unknown>, accumulator: EffortAccumulator, state: EffortParserState) {
  if (state.codexReplaying) return;
  recordActivity(accumulator, row, payload);
  state.effort = normalizeEffort(payload.effort);
  state.model = typeof payload.model === "string" ? payload.model : "";
  state.active = true;
  const occurredOn = dateKeyInTimeZone(row.timestamp) ?? dateKeyInTimeZone(payload.timestamp) ?? "";
  addObservation(accumulator, bucket(accumulator, occurredOn, state.model, state.effort));
}

const rawUsage = (value: Record<string, unknown>): CodexRawUsage => ({
  inputTokens: count(value.input_tokens) ?? 0,
  cachedInputTokens: count(value.cached_input_tokens) ?? 0,
  cacheCreationTokens: count(value.cache_write_input_tokens) ?? 0,
  outputTokens: count(value.output_tokens) ?? 0,
  reasoningOutputTokens: count(value.reasoning_output_tokens) ?? 0,
  totalTokens: count(value.total_tokens) ?? 0,
});

const rawUsageFields = ["inputTokens", "cachedInputTokens", "cacheCreationTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"] as const;

const sameUsage = (left: CodexRawUsage, right: CodexRawUsage) => rawUsageFields.every((field) => left[field] === right[field]);

/** The usage one `token_count` adds, by the rules ccusage applies, or null when it adds none.
 * `last_token_usage` is the record; a snapshot re-emitted without advancing the cumulative
 * `total_token_usage` is not new usage, and a record that carries only the cumulative total
 * contributes the growth since the previous one. Advances `previousTotals` as a side effect, so
 * every record of a rollout must pass through here in order. */
export function codexUsageDelta(info: Record<string, unknown>, state: Pick<EffortParserState, "codexPreviousTotals">): CodexRawUsage | null {
  const total = record(info.total_token_usage) ? rawUsage(info.total_token_usage) : null;
  const previous = state.codexPreviousTotals;
  const advanced = total === null || previous === null || !sameUsage(total, previous);
  let usage: CodexRawUsage | null = null;
  if (record(info.last_token_usage) && advanced) {
    usage = rawUsage(info.last_token_usage);
  } else if (total) {
    usage = { ...total };
    for (const field of rawUsageFields) usage[field] = Math.max(0, total[field] - (previous?.[field] ?? 0));
  }
  if (total) state.codexPreviousTotals = total;
  if (!usage) return null;
  // Empty usage sentinels keep a cumulative-looking nonzero total_tokens; importing it would
  // invent billable activity that never happened.
  if (usage.inputTokens === 0 && usage.cachedInputTokens === 0 && usage.cacheCreationTokens === 0 && usage.outputTokens === 0 && usage.reasoningOutputTokens === 0) return null;
  return usage;
}

/** True while `usage` is still history a fork copied from its parent. Mirrors ccusage: subtract
 * the exact parent prefix when it lines up; when nothing lines up, skip the burst Codex rewrote
 * to the fork instant, following the run for as long as records stay within a second of each
 * other and move forward. */
export function codexUsageIsReplayed(usage: CodexRawUsage, timestamp: number | null, state: Pick<EffortParserState, "codexReplay" | "codexReplayPlan">) {
  for (;;) {
    const replay = state.codexReplay;
    if (replay === null) return false;
    if (replay.phase === "matching") {
      const expected = state.codexReplayPlan?.prefix[replay.index];
      if (expected && sameUsage(expected, usage)) {
        state.codexReplay = { phase: "matching", index: replay.index + 1 };
        return true;
      }
      const burstStart = replay.index === 0 ? state.codexReplayPlan?.burstStart ?? null : null;
      state.codexReplay = burstStart === null ? null : { phase: "burst", last: burstStart };
      continue;
    }
    const step = timestamp === null ? -1 : timestamp - replay.last;
    if (timestamp !== null && step >= 0 && step <= CODEX_REPLAY_BURST_PAUSE_MS) {
      state.codexReplay = { phase: "burst", last: timestamp };
      return true;
    }
    state.codexReplay = null;
  }
}

function codexQuotaObservations(row: Record<string, unknown>, payload: Record<string, unknown>, accumulator: EffortAccumulator) {
  const observedAt = recordActivity(accumulator, row, payload);
  const rateLimits = record(payload.rate_limits) ? payload.rate_limits : null;
  if (observedAt !== null && rateLimits) {
    const planId = typeof rateLimits.plan_type === "string" && rateLimits.plan_type.trim()
      ? rateLimits.plan_type.trim()
      : null;
    for (const value of [rateLimits.primary, rateLimits.secondary]) {
      if (!record(value)) continue;
      const windowMinutes = count(value.window_minutes);
      const usedPercent = count(value.used_percent);
      if (windowMinutes === null || usedPercent === null || usedPercent > 100) continue;
      const resourceId = windowMinutes * 60 <= 6 * 60 * 60
        ? "fiveHour" as const
        : windowMinutes * 60 >= 3 * 24 * 60 * 60
          ? "weekly" as const
          : null;
      if (!resourceId) continue;
      const resetsAt = epochMs(value.resets_at);
      accumulator.quotaObservations.push({
        observedAt,
        resourceId,
        usedPercent,
        resetsAt,
        cycleId: resetsAt === null
          ? `observed:${observedAt}`
          : `reset:${Math.floor(resetsAt / 60_000) * 60_000}`,
        planId,
        planSource: planId ? "provider" : "unknown",
      });
    }
  }
}

function codexTokenCount(row: Record<string, unknown>, payload: Record<string, unknown>, accumulator: EffortAccumulator, state: EffortParserState) {
  const info = record(payload.info) ? payload.info : null;
  // Usage accounting follows ccusage even inside embedded parent history, so the cumulative
  // total and the fork replay position stay in step with what ccusage reads from the same file.
  const usage = info ? codexUsageDelta(info, state) : null;
  const stamp = typeof row.timestamp === "string" ? row.timestamp : typeof payload.timestamp === "string" ? payload.timestamp : "";
  const stampMs = stamp === "" ? Number.NaN : Date.parse(stamp);
  const replayed = usage !== null && codexUsageIsReplayed(usage, Number.isNaN(stampMs) ? null : stampMs, state);
  // Copied history carries rewritten timestamps: neither its activity nor its quota readings
  // describe this rollout.
  if (!replayed && !state.codexReplaying && state.codexReplay === null) codexQuotaObservations(row, payload, accumulator);
  if (usage === null || replayed) return;

  const reasoningSource = record(info?.last_token_usage) ? info.last_token_usage : record(info?.total_token_usage) ? info.total_token_usage : null;
  const rawInput = usage.inputTokens;
  const cacheReadTokens = usage.cachedInputTokens;
  const cacheCreationTokens = usage.cacheCreationTokens;
  const outputTokens = usage.outputTokens;
  const reasoningOutputTokens = usage.reasoningOutputTokens;
  const inputTokens = rawInput - cacheReadTokens - cacheCreationTokens;
  const totalTokens = inputTokens + cacheReadTokens + cacheCreationTokens + outputTokens;
  const reported = usage.totalTokens === 0 ? null : usage.totalTokens;
  if (inputTokens < 0 || reasoningOutputTokens > outputTokens || (reported !== null && reported !== totalTokens)) {
    throw new Error("unsupported Codex usage shape");
  }

  // Some older rollouts write the same token_count more than once. ccusage treats identical
  // timestamp + last-usage records as one event, so effort attribution must do the same.
  const usageKey = stamp === ""
    ? null
    : [
        stamp,
        rawInput,
        cacheReadTokens,
        cacheCreationTokens,
        outputTokens,
        reasoningOutputTokens,
        totalTokens,
      ].join("|");
  if (usageKey !== null && usageKey === state.lastUsageKey) return;
  state.lastUsageKey = usageKey;

  if (!state.active) accumulator.contextGaps++;
  const occurredOn = dateKeyInTimeZone(row.timestamp) ?? dateKeyInTimeZone(payload.timestamp) ?? "";
  const target = bucket(accumulator, occurredOn, state.active ? state.model ?? "" : "", state.active ? state.effort ?? "" : "");
  addTokens(accumulator, target, {
    inputTokens, cacheReadTokens, cacheCreationTokens, outputTokens, reasoningOutputTokens,
    reasoningReportedEvents: reasoningSource?.reasoning_output_tokens === undefined ? 0 : 1,
    totalTokens,
  });
}

function clearCodexAttribution(state: EffortParserState) {
  state.effort = null;
  state.model = null;
  state.active = false;
  state.lastUsageKey = null;
}

function codexSessionMeta(payload: Record<string, unknown>, state: EffortParserState) {
  const sessionKey = typeof payload.id === "string" ? payload.id : null;
  if (sessionKey === null) return;
  if (state.codexSessionKey === null) {
    state.codexSessionKey = sessionKey;
    state.codexReplaying = false;
    return;
  }
  const wasReplaying = state.codexReplaying;
  state.codexReplaying = sessionKey !== state.codexSessionKey;
  // Repeated metadata for the current rollout is not an attribution boundary. Crossing into or
  // out of embedded parent history is.
  if (wasReplaying || state.codexReplaying) clearCodexAttribution(state);
}

/** Parses one already-decoded transcript line. Returns false when the line was irrelevant.
 * Throws only for an unsupported shape; the caller turns that into a parser gap. */
export function parseEffortLine(line: string, agent: Agent, accumulator: EffortAccumulator, state: EffortParserState) {
  const row: unknown = JSON.parse(line);
  if (!record(row)) return false;
  if (agent === "claude") return claudeLine(row, accumulator, state);

  const payload = record(row.payload) ? row.payload : row;
  const type = String(payload.type ?? row.type ?? "");
  if (row.type === "session_meta") {
    codexSessionMeta(payload, state);
    return true;
  }
  if (type === "thread_rolled_back") {
    // A forked rollout may not repeat its own session_meta after the embedded parent history.
    // The rollback marker is the boundary after which events belong to the child rollout again.
    if (state.codexReplaying) {
      state.codexReplaying = false;
      clearCodexAttribution(state);
    }
    return true;
  }
  if (row.type === "turn_context" || type === "turn_context") {
    codexTurnContext(row, record(row.payload) ? row.payload : payload, accumulator, state);
    return true;
  }
  if (type === "token_count") {
    codexTokenCount(row, payload, accumulator, state);
    return true;
  }
  return false;
}

/** Feeds a decoded line through the prefilter and the structured handlers, converting an
 * unsupported shape into a recorded gap rather than a thrown error. */
export function consumeEffortLine(line: string, agent: Agent, accumulator: EffortAccumulator, state: EffortParserState, prefilter = true) {
  if (!line.trim()) return;
  if (prefilter && !hasProviderMarker(line, agent)) return;
  try {
    parseEffortLine(line, agent, accumulator, state);
  } catch {
    if (hasProviderMarker(line, agent)) recordParserGap(accumulator, state, agent);
    // A malformed line with no provider marker cannot have changed effort state; skipping it
    // silently keeps quality counters meaningful.
  }
}
