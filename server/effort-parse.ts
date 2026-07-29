import { localDate, normalizeEffort } from "../src/effort-model";

/** Bumping this rebuilds every session from byte zero. The constant lives in code, never in the
 * database, so a checkout can never disagree with the rows it is reading. */
export const PARSER_VERSION = 3;

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
};

export type EffortAccumulator = {
  rows: Map<string, EffortUsageRow>;
  observations: number;
  unknownObservations: number;
  observedUsageTokens: number;
  attributedTokens: number;
  parseErrors: number;
  contextGaps: number;
  skippedBytes: number;
};

export const emptyState = (): EffortParserState => ({
  effort: null,
  model: null,
  active: false,
  lastUsageKey: null,
  codexSessionKey: null,
  codexReplaying: false,
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
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
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

  const occurredOn = localDate(row.timestamp) ?? "";
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
  state.effort = normalizeEffort(payload.effort);
  state.model = typeof payload.model === "string" ? payload.model : "";
  state.active = true;
  const occurredOn = localDate(row.timestamp) ?? localDate(payload.timestamp) ?? "";
  addObservation(accumulator, bucket(accumulator, occurredOn, state.model, state.effort));
}

function codexTokenCount(row: Record<string, unknown>, payload: Record<string, unknown>, accumulator: EffortAccumulator, state: EffortParserState) {
  if (state.codexReplaying) return;
  const info = payload.info;
  if (!record(info)) return;
  // Never `total_token_usage`: it is cumulative and would multiply every session's totals.
  const last = info.last_token_usage;
  if (!record(last)) return;

  const rawInput = count(last.input_tokens) ?? 0;
  const cacheReadTokens = count(last.cached_input_tokens) ?? 0;
  const cacheCreationTokens = count(last.cache_write_input_tokens) ?? 0;
  const outputTokens = count(last.output_tokens) ?? 0;
  const reasoningOutputTokens = count(last.reasoning_output_tokens) ?? 0;
  // Empty usage sentinels keep a cumulative-looking nonzero total_tokens; importing it would
  // invent billable activity that never happened.
  if (rawInput === 0 && cacheReadTokens === 0 && cacheCreationTokens === 0 && outputTokens === 0 && reasoningOutputTokens === 0) return;

  const inputTokens = rawInput - cacheReadTokens - cacheCreationTokens;
  const totalTokens = inputTokens + cacheReadTokens + cacheCreationTokens + outputTokens;
  const reported = count(last.total_tokens);
  if (inputTokens < 0 || reasoningOutputTokens > outputTokens || (reported !== null && reported !== totalTokens)) {
    throw new Error("unsupported Codex usage shape");
  }

  // Some older rollouts write the same token_count more than once. ccusage treats identical
  // timestamp + last-usage records as one event, so effort attribution must do the same.
  const timestamp = typeof row.timestamp === "string"
    ? row.timestamp
    : typeof payload.timestamp === "string"
      ? payload.timestamp
      : "";
  const usageKey = timestamp === ""
    ? null
    : [
        timestamp,
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
  const occurredOn = localDate(row.timestamp) ?? localDate(payload.timestamp) ?? "";
  const target = bucket(accumulator, occurredOn, state.active ? state.model ?? "" : "", state.active ? state.effort ?? "" : "");
  addTokens(accumulator, target, {
    inputTokens, cacheReadTokens, cacheCreationTokens, outputTokens, reasoningOutputTokens,
    reasoningReportedEvents: last.reasoning_output_tokens === undefined ? 0 : 1,
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
