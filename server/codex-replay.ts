import {
  CODEX_REPLAY_BURST_PAUSE_MS,
  MAX_LINE_BYTES,
  codexUsageDelta,
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

/** Complete lines of a transcript, decoded one at a time. An over-limit line is skipped: it is a
 * compaction replay or an attachment, never a `session_meta` or `token_count` record. */
async function* transcriptLines(sourceFile: string) {
  const decoder = new TextDecoder();
  let carry: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let skipping = false;
  for await (const chunk of Bun.file(sourceFile).stream()) {
    let start = 0;
    for (;;) {
      const terminator = chunk.indexOf(newline, start);
      if (terminator < 0) break;
      if (skipping) {
        skipping = false;
      } else {
        const tail = chunk.subarray(start, terminator);
        // Joined before decoding, so a multi-byte character split across chunks stays intact.
        if (carry.length + tail.length <= MAX_LINE_BYTES) yield decoder.decode(carry.length ? join(carry, tail) : tail);
      }
      carry = new Uint8Array(0);
      start = terminator + 1;
    }
    if (skipping) continue;
    const rest = chunk.subarray(start);
    if (carry.length + rest.length > MAX_LINE_BYTES) {
      skipping = true;
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
    if (!line.includes("\"session_meta\"")) continue;
    const row = parse(line);
    if (row?.type !== "session_meta") continue;
    const payload = object(row.payload);
    const spawn = object(object(object(payload?.source)?.subagent)?.thread_spawn);
    const parentKey = [payload?.forked_from_id, spawn?.parent_thread_id].find((value) => typeof value === "string" && value !== "");
    return typeof parentKey === "string" ? { parentKey, forkedAt: timestampOf(row) } : null;
  }
  return null;
}

/** Usage records of a rollout in file order, by the same rule the parser applies. */
async function* usageRecords(sourceFile: string) {
  const state: Pick<EffortParserState, "codexPreviousTotals"> = { codexPreviousTotals: null };
  for await (const line of transcriptLines(sourceFile)) {
    if (!line.includes("\"token_count\"")) continue;
    const row = parse(line);
    const payload = object(row?.payload);
    if (!row || row.type !== "event_msg" || payload?.type !== "token_count") continue;
    const info = object(payload.info);
    if (!info) continue;
    const usage = codexUsageDelta(info, state);
    yield { usage, timestamp: timestampOf(row), stated: object(info.last_token_usage) !== null || object(info.total_token_usage) !== null };
  }
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
  const parentFile = parentSourceFile(header.parentKey, sourceFile);
  if (parentFile) {
    try {
      for await (const record of usageRecords(parentFile)) {
        // Usage the parent recorded after the fork was never copied, so it must not mask the
        // fork's own records.
        if (header.forkedAt !== null && record.timestamp !== null && record.timestamp > header.forkedAt) break;
        if (record.usage) prefix.push(record.usage);
      }
    } catch {
      prefix.length = 0;
    }
  }

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
  return { prefix, burstStart };
}

type CodexUsageState = { totals: CodexRawUsage | null; replay: CodexReplayProgress | null };

export function encodeCodexUsageState(state: Pick<EffortParserState, "codexPreviousTotals" | "codexReplay">) {
  if (state.codexPreviousTotals === null && state.codexReplay === null) return null;
  return JSON.stringify({ totals: state.codexPreviousTotals, replay: state.codexReplay } satisfies CodexUsageState);
}

export function decodeCodexUsageState(encoded: string | null): Pick<EffortParserState, "codexPreviousTotals" | "codexReplay"> {
  if (encoded === null) return { codexPreviousTotals: null, codexReplay: null };
  try {
    const value = JSON.parse(encoded) as CodexUsageState;
    return { codexPreviousTotals: value.totals ?? null, codexReplay: value.replay ?? null };
  } catch {
    return { codexPreviousTotals: null, codexReplay: null };
  }
}
