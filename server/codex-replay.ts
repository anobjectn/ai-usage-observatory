import {
  CODEX_REPLAY_BURST_PAUSE_MS,
  MAX_LINE_BYTES,
  OVERSIZED_HEAD_BYTES,
  OVERSIZED_TAIL_BYTES,
  codexUsageDelta,
  oversizedCompactionId,
  type CodexCompactionState,
  type CodexPendingCompaction,
  type CodexRawUsage,
  type CodexReplayPlan,
  type CodexReplayProgress,
  type EffortParserState,
} from "./effort-parse";
import { db } from "./store";

/** A Codex fork or subagent rollout opens with the usage history of the rollout it came from,
 * rewritten to the fork instant. ccusage subtracts that history by matching it against the
 * parent log, and the effort index has to subtract the same records to reconcile with it. The
 * parser stays a pure line consumer; this module does the cross-file reading it cannot. */

const newline = 0x0a;

function join(left: Uint8Array, right: Uint8Array) {
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left);
  joined.set(right, left.length);
  return joined;
}

/** Decodes leniently: a multi-byte sequence cut at a window edge cannot form a key. */
export const lenient = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** The last `OVERSIZED_TAIL_BYTES` of `kept` followed by `next`. */
export function tailOf(kept: Uint8Array, next: Uint8Array) {
  if (next.length >= OVERSIZED_TAIL_BYTES) return next.slice(next.length - OVERSIZED_TAIL_BYTES);
  const joined = join(kept, next);
  return joined.slice(Math.max(0, joined.length - OVERSIZED_TAIL_BYTES));
}

/** Complete lines of a transcript, decoded one at a time. An over-limit line is a compaction
 * replay or an attachment, never a `session_meta` or `token_count` record; only its head and
 * tail are kept, where a `compacted` item states its type and its response. */
async function* transcriptLines(sourceFile: string): AsyncGenerator<string | { head: string; tail: string }> {
  const decoder = new TextDecoder();
  let carry: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let oversized: { head: string; tail: Uint8Array } | null = null;
  for await (const chunk of Bun.file(sourceFile).stream()) {
    let start = 0;
    for (;;) {
      const terminator = chunk.indexOf(newline, start);
      if (terminator < 0) break;
      const piece = chunk.subarray(start, terminator);
      if (oversized) {
        yield { head: oversized.head, tail: lenient(tailOf(oversized.tail, piece)) };
        oversized = null;
      } else if (carry.length + piece.length <= MAX_LINE_BYTES) {
        // Joined before decoding, so a multi-byte character split across chunks stays intact.
        yield decoder.decode(carry.length ? join(carry, piece) : piece);
      } else {
        const whole = join(carry, piece);
        yield { head: lenient(whole.subarray(0, OVERSIZED_HEAD_BYTES)), tail: lenient(tailOf(new Uint8Array(0), whole)) };
      }
      carry = new Uint8Array(0);
      start = terminator + 1;
    }
    const rest = chunk.subarray(start);
    if (oversized) {
      oversized.tail = tailOf(oversized.tail, rest);
    } else if (carry.length + rest.length > MAX_LINE_BYTES) {
      const whole = join(carry, rest);
      oversized = { head: lenient(whole.subarray(0, OVERSIZED_HEAD_BYTES)), tail: tailOf(new Uint8Array(0), whole) };
      carry = new Uint8Array(0);
    } else if (rest.length) {
      carry = join(carry, rest);
    }
  }
}

function parse(line: string): Record<string, unknown> | null {
  try {
    const row: unknown = JSON.parse(line);
    return row !== null && typeof row === "object" && !Array.isArray(row) ? row as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const object = (value: unknown) => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null);

const timestampOf = (row: Record<string, unknown>) => {
  const parsed = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : Number.NaN;
  return Number.isNaN(parsed) ? null : parsed;
};

type ForkHeader = { parentKey: string; forkedAt: number | null };

/** The first `session_meta` names the rollout this one forked from, under either spelling Codex
 * has used. Later `session_meta` records belong to embedded parent history. */
async function readForkHeader(sourceFile: string): Promise<ForkHeader | null> {
  for await (const line of transcriptLines(sourceFile)) {
    if (typeof line !== "string" || !line.includes("\"session_meta\"")) continue;
    const row = parse(line);
    if (row?.type !== "session_meta") continue;
    const payload = object(row.payload);
    const spawn = object(object(object(payload?.source)?.subagent)?.thread_spawn);
    const parentKey = [payload?.forked_from_id, spawn?.parent_thread_id].find((value) => typeof value === "string" && value !== "");
    return typeof parentKey === "string" ? { parentKey, forkedAt: timestampOf(row) } : null;
  }
  return null;
}

/** Usage records of a rollout in file order, by the same rule the parser applies. When
 * `compactions` is given it collects, with its first timestamp, every response that both has a
 * usage record and is named by a `compacted` item, including those a cumulative snapshot covered. */
async function* usageRecords(sourceFile: string, compactions?: Map<string, number | null>) {
  const state: Pick<EffortParserState, "codexPreviousTotals"> = { codexPreviousTotals: null };
  const recorded = new Map<string, number | null>();
  const compacted = new Set<string>();
  for await (const line of transcriptLines(sourceFile)) {
    if (typeof line !== "string") {
      const id = compactions ? oversizedCompactionId(line.head, line.tail) : null;
      if (id) compacted.add(id);
      continue;
    }
    if (compactions && (line.includes("token_usage_record") || line.includes("compaction_response_id"))) {
      const row = parse(line);
      const payload = object(row?.payload);
      if (row?.type === "compacted" && typeof payload?.compaction_response_id === "string" && payload.compaction_response_id.trim()) {
        compacted.add(payload.compaction_response_id.trim());
      } else if (row?.type === "token_usage_record" && typeof row.timestamp === "string" && typeof payload?.response_id === "string") {
        const id = payload.response_id.trim();
        const usage = object(payload.usage);
        const stated = usage && ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"]
          .some((field) => typeof usage[field] === "number" && usage[field] > 0);
        if (id && stated && !recorded.has(id)) recorded.set(id, timestampOf(row));
      }
      continue;
    }
    if (!line.includes("\"token_count\"")) continue;
    const row = parse(line);
    const payload = object(row?.payload);
    if (!row || row.type !== "event_msg" || payload?.type !== "token_count") continue;
    const info = object(payload.info);
    if (!info) continue;
    const usage = codexUsageDelta(info, state);
    yield { usage, timestamp: timestampOf(row), stated: object(info.last_token_usage) !== null || object(info.total_token_usage) !== null };
  }
  for (const [id, timestamp] of recorded) if (compacted.has(id)) compactions?.set(id, timestamp);
}

function parentSourceFile(parentKey: string, childFile: string) {
  const row = db.query("SELECT source_file AS sourceFile FROM session_paths WHERE agent = 'codex' AND native_session_key = ? AND source_file != ? ORDER BY source_file LIMIT 1")
    .get(parentKey, childFile) as { sourceFile: string } | null;
  return row?.sourceFile ?? null;
}

/** Null for a rollout that is not a fork. */
export async function planCodexReplay(sourceFile: string): Promise<CodexReplayPlan | null> {
  const header = await readForkHeader(sourceFile);
  if (!header) return null;

  const prefix: CodexRawUsage[] = [];
  const parentCompactions = new Map<string, number | null>();
  const parentFile = parentSourceFile(header.parentKey, sourceFile);
  if (parentFile) {
    try {
      let copying = true;
      // Read to the end: a compaction pair can complete after the fork instant even when its
      // request was made before it.
      for await (const record of usageRecords(parentFile, parentCompactions)) {
        // Usage the parent recorded after the fork was never copied, so it must not mask the
        // fork's own records.
        if (header.forkedAt !== null && record.timestamp !== null && record.timestamp > header.forkedAt) copying = false;
        if (copying && record.usage) prefix.push(record.usage);
      }
    } catch {
      prefix.length = 0;
      parentCompactions.clear();
    }
  }
  // A request the parent made after the fork stays countable in the child.
  const compactions = new Set([...parentCompactions]
    .filter(([, timestamp]) => header.forkedAt === null || timestamp === null || timestamp <= header.forkedAt)
    .map(([id]) => id));

  // A rollout that opens with two usage records written back to back copied a history it did
  // not spend; one that pauses between them was recording its own turns from the start.
  let first: number | null = null;
  let burstStart: number | null = null;
  for await (const record of usageRecords(sourceFile)) {
    if (!record.stated || record.timestamp === null) continue;
    if (first === null) {
      first = record.timestamp;
      continue;
    }
    const step = record.timestamp - first;
    if (step >= 0 && step <= CODEX_REPLAY_BURST_PAUSE_MS) burstStart = first;
    break;
  }
  return { prefix, burstStart, compactions };
}

type EncodedCompaction = {
  compacted: string[];
  pending: Array<[string, CodexPendingCompaction]>;
  emitted: string[];
  latest: string | null;
  parent: string[];
};

type CodexUsageState = { totals: CodexRawUsage | null; replay: CodexReplayProgress | null; compaction?: EncodedCompaction };

type PersistedCodexUsage = Pick<EffortParserState, "codexPreviousTotals" | "codexReplay" | "codexCompaction">;

export function encodeCodexUsageState(state: PersistedCodexUsage) {
  if (state.codexPreviousTotals === null && state.codexReplay === null && state.codexCompaction === null) return null;
  const compaction = state.codexCompaction;
  return JSON.stringify({
    totals: state.codexPreviousTotals,
    replay: state.codexReplay,
    ...(compaction
      ? {
          compaction: {
            compacted: [...compaction.compacted],
            pending: [...compaction.pending],
            emitted: [...compaction.emitted],
            latest: compaction.latest,
            parent: [...compaction.parent],
          },
        }
      : {}),
  } satisfies CodexUsageState);
}

function decodeCompaction(value: EncodedCompaction | undefined): CodexCompactionState | null {
  if (!value) return null;
  return {
    compacted: new Set(value.compacted),
    pending: new Map(value.pending),
    emitted: new Set(value.emitted),
    latest: value.latest,
    parent: new Set(value.parent),
  };
}

export function decodeCodexUsageState(encoded: string | null): PersistedCodexUsage {
  if (encoded === null) return { codexPreviousTotals: null, codexReplay: null, codexCompaction: null };
  try {
    const value = JSON.parse(encoded) as CodexUsageState;
    return { codexPreviousTotals: value.totals ?? null, codexReplay: value.replay ?? null, codexCompaction: decodeCompaction(value.compaction) };
  } catch {
    return { codexPreviousTotals: null, codexReplay: null, codexCompaction: null };
  }
}
