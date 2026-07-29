import type { SessionSource } from "./path-indexer";
import {
  PARSER_VERSION,
  MAX_LINE_BYTES,
  consumeEffortLine,
  createAccumulator,
  emptyState,
  recordParserGap,
  type Agent,
  type EffortAccumulator,
  type EffortParserState,
} from "./effort-parse";
import {
  commitEffortSpan,
  getEffortMeta,
  getEffortState,
  getEffortStates,
  markEffortIndexed,
  resetEffortSession,
  setEffortError,
  type EffortSessionState,
} from "./effort-store";

export const CHUNK_BYTES = 4 * 1024 * 1024;
export const TIME_SLICE_MS = 25;
export const RESUME_HASH_BYTES = 4096;
/** Sources touched inside this window are indexed before the older backlog, so the range the app
 * opens on becomes useful first. Indexing then continues until All time is complete. */
export const RECENT_WINDOW_DAYS = 120;

const newline = 0x0a;

/** Set once per process per session after the recorded resume boundary has been verified.
 * Without it a steady-state 60-second refresh would re-read a boundary for every transcript even
 * though size and mtime already prove the file is untouched. */
const verifiedBoundaries = new Set<string>();

let catalog: SessionSource[] = [];
let running: Promise<void> | null = null;
let indexingActive = false;

export function setEffortCatalog(sources: SessionSource[]) {
  catalog = sources;
}

export function getEffortCatalog() {
  return catalog;
}

export function isEffortIndexing() {
  return indexingActive;
}

async function hashBoundary(sourceFile: string, offset: number) {
  if (offset <= 0) return "";
  const start = Math.max(0, offset - RESUME_HASH_BYTES);
  const bytes = new Uint8Array(await Bun.file(sourceFile).slice(start, offset).arrayBuffer());
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return `${offset - start}:${hasher.digest("hex").slice(0, 32)}`;
}

type Work =
  | { kind: "skip" }
  | { kind: "rebuild"; reason: string }
  | { kind: "append" };

function classify(source: SessionSource, state: EffortSessionState | undefined): Work {
  if (!state) return { kind: "rebuild", reason: "new" };
  if (state.parserVersion !== PARSER_VERSION) return { kind: "rebuild", reason: "parser-version" };
  if (state.sourceIdentity && source.sourceIdentity && state.sourceIdentity !== source.sourceIdentity) {
    return { kind: "rebuild", reason: "source-identity" };
  }
  if (source.size < state.sourceSize) return { kind: "rebuild", reason: "shrink" };
  if (source.mtimeMs < state.sourceMtime) return { kind: "rebuild", reason: "mtime-backwards" };
  if (source.size === state.sourceSize && source.mtimeMs !== state.sourceMtime) {
    return { kind: "rebuild", reason: "rewritten-in-place" };
  }
  if (state.lastOffset < source.size) return { kind: "append" };
  return { kind: "skip" };
}

export type EffortBacklogEntry = { source: SessionSource; work: Work; pendingBytes: number };

export function buildBacklog(sources = catalog, states = getEffortStates()): EffortBacklogEntry[] {
  const recentCutoff = Date.now() - RECENT_WINDOW_DAYS * 86_400_000;
  const entries = sources.flatMap((source) => {
    const work = classify(source, states.get(source.sessionId));
    if (work.kind === "skip") return [];
    const pendingBytes = work.kind === "rebuild" ? source.size : source.size - (states.get(source.sessionId)?.lastOffset ?? 0);
    return [{ source, work, pendingBytes }];
  });
  return entries.sort((a, b) => {
    const aRecent = a.source.mtimeMs >= recentCutoff ? 0 : 1;
    const bRecent = b.source.mtimeMs >= recentCutoff ? 0 : 1;
    return aRecent - bRecent || b.source.mtimeMs - a.source.mtimeMs;
  });
}

export function effortProgress(sources = catalog, states = getEffortStates()) {
  const backlog = buildBacklog(sources, states);
  return {
    indexedSessions: states.size,
    pendingSessions: backlog.length,
    indexedBytes: [...states.values()].reduce((sum, state) => sum + state.lastOffset, 0),
    pendingBytes: backlog.reduce((sum, entry) => sum + Math.max(0, entry.pendingBytes), 0),
  };
}

function coverageOf(totals: { attributedTokens: number; unknownObservations: number; observedUsageTokens: number; parseErrors: number; contextGaps: number }) {
  if (totals.attributedTokens === 0) return "unavailable";
  const clean = totals.unknownObservations === 0 && totals.parseErrors === 0 && totals.contextGaps === 0
    && totals.attributedTokens === totals.observedUsageTokens;
  return clean ? "complete" : "partial";
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Parses one session's outstanding bytes. Returns once the file is caught up or the time slice
 * is spent; the scheduler decides whether to come back. Every committed span is atomic, so an
 * interruption anywhere here is safe to resume from. */
export async function indexOneSession(source: SessionSource, entry: Work, options: { budgetMs?: number; chunkBytes?: number } = {}) {
  const budgetMs = options.budgetMs ?? TIME_SLICE_MS;
  const chunkBytes = options.chunkBytes ?? CHUNK_BYTES;
  const agent = source.agent as Agent;
  if (entry.kind === "rebuild") resetEffortSession(source.sessionId);

  const prior = entry.kind === "append" ? getEffortState(source.sessionId) : null;
  if (entry.kind === "append" && prior) {
    // Never append onto a boundary we cannot prove is still the same bytes.
    const boundary = await hashBoundary(source.sourceFile, prior.lastOffset);
    if (boundary !== prior.resumeHash) {
      resetEffortSession(source.sessionId);
      return indexOneSession(source, { kind: "rebuild", reason: "resume-hash" }, options);
    }
  }

  const totals = {
    attributedTokens: prior?.attributedTokens ?? 0,
    unknownObservations: prior?.unknownObservations ?? 0,
    observedUsageTokens: prior?.observedUsageTokens ?? 0,
    parseErrors: prior?.parseErrors ?? 0,
    contextGaps: prior?.contextGaps ?? 0,
  };

  const state: EffortParserState = {
    ...emptyState(),
    ...(prior && prior.currentEffort !== null
      ? { effort: prior.currentEffort, model: prior.currentModel ?? "", active: true }
      : {}),
    lastUsageKey: prior?.lastUsageKey ?? null,
    codexSessionKey: prior?.codexSessionKey ?? null,
    codexReplaying: prior?.codexReplaying ?? false,
  };

  let cursor = entry.kind === "append" ? prior?.lastOffset ?? 0 : 0;
  let carry: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let skippingOversizedLine = false;
  const decoder = new TextDecoder();
  const started = Date.now();
  const size = source.size;
  let committed = false;
  const commit = async (accumulator: EffortAccumulator, at: number) => {
    committed = true;
    await commitSpan(source, accumulator, state, at, totals);
  };

  while (cursor + carry.length < size) {
    const readFrom = cursor + carry.length;
    const readTo = Math.min(size, readFrom + chunkBytes);
    const chunk = new Uint8Array(await Bun.file(source.sourceFile).slice(readFrom, readTo).arrayBuffer());
    if (chunk.length === 0) break;

    const accumulator = createAccumulator();
    let buffer: Uint8Array<ArrayBufferLike>;
    if (skippingOversizedLine) {
      const terminator = chunk.indexOf(newline);
      if (terminator < 0) {
        accumulator.skippedBytes += chunk.length;
        cursor = readFrom + chunk.length;
        await commit(accumulator, cursor);
        if (Date.now() - started >= budgetMs) return { done: false, offset: cursor };
        await yieldToLoop();
        continue;
      }
      accumulator.skippedBytes += terminator + 1;
      cursor = readFrom + terminator + 1;
      skippingOversizedLine = false;
      buffer = chunk.slice(terminator + 1);
    } else {
      buffer = carry.length ? concat(carry, chunk) : chunk;
    }

    const lastNewline = buffer.lastIndexOf(newline);
    if (lastNewline < 0) {
      // No complete line in the buffered span. Multi-byte UTF-8 is safe because nothing is
      // decoded until a terminator is seen.
      if (buffer.length > MAX_LINE_BYTES) {
        recordParserGap(accumulator, state, agent, buffer.length);
        skippingOversizedLine = true;
        carry = new Uint8Array(0);
        cursor = readFrom + chunk.length;
        await commit(accumulator, cursor);
      } else {
        carry = buffer;
      }
      if (Date.now() - started >= budgetMs) return { done: false, offset: cursor };
      await yieldToLoop();
      continue;
    }

    // `buffer` always begins exactly at `cursor`: either it is the carried bytes plus this chunk,
    // or the remainder after an oversized line was discarded up to and including its terminator.
    // Lines are located by byte scan and decoded individually, so the 4 MiB limit is enforced per
    // line rather than per buffer, and no multi-byte sequence is ever decoded across a boundary.
    let lineStart = 0;
    for (;;) {
      const terminator = buffer.indexOf(newline, lineStart);
      if (terminator < 0 || terminator > lastNewline) break;
      const length = terminator - lineStart;
      // An over-limit line is treated as a gap without decoding it: recovering a provider marker
      // would mean buffering the very bytes the limit exists to refuse.
      if (length > MAX_LINE_BYTES) recordParserGap(accumulator, state, agent, length);
      else consumeEffortLine(decoder.decode(buffer.subarray(lineStart, terminator)), agent, accumulator, state);
      lineStart = terminator + 1;
    }
    cursor += lastNewline + 1;
    carry = buffer.slice(lastNewline + 1);
    // An incomplete trailing fragment is never persisted; it is re-read from `cursor` next pass.
    if (carry.length > MAX_LINE_BYTES) {
      recordParserGap(accumulator, state, agent, carry.length);
      skippingOversizedLine = true;
      cursor += carry.length;
      carry = new Uint8Array(0);
    }
    await commit(accumulator, cursor);
    if (Date.now() - started >= budgetMs) return { done: false, offset: cursor };
    await yieldToLoop();
  }
  // An empty file, or a file whose only new bytes are an unterminated final line, still needs a
  // state row; without one the backlog would offer the same session forever.
  if (!committed) await commit(createAccumulator(), cursor);
  return { done: true, offset: cursor };
}

function concat(a: Uint8Array, b: Uint8Array) {
  const merged = new Uint8Array(a.length + b.length);
  merged.set(a, 0);
  merged.set(b, a.length);
  return merged;
}

async function commitSpan(
  source: SessionSource,
  accumulator: EffortAccumulator,
  state: EffortParserState,
  cursor: number,
  totals: { attributedTokens: number; unknownObservations: number; observedUsageTokens: number; parseErrors: number; contextGaps: number },
) {
  totals.attributedTokens += accumulator.attributedTokens;
  totals.unknownObservations += accumulator.unknownObservations;
  totals.observedUsageTokens += accumulator.observedUsageTokens;
  totals.parseErrors += accumulator.parseErrors;
  totals.contextGaps += accumulator.contextGaps;
  commitEffortSpan({
    sessionId: source.sessionId,
    parserVersion: PARSER_VERSION,
    sourceSize: source.size,
    sourceMtime: source.mtimeMs,
    sourceIdentity: source.sourceIdentity,
    lastOffset: cursor,
    resumeHash: await hashBoundary(source.sourceFile, cursor),
    currentEffort: state.active ? state.effort : null,
    currentModel: state.active ? state.model : null,
    lastUsageKey: state.lastUsageKey,
    codexSessionKey: state.codexSessionKey,
    codexReplaying: state.codexReplaying,
    rows: [...accumulator.rows.values()],
    observations: accumulator.observations,
    unknownObservations: accumulator.unknownObservations,
    observedUsageTokens: accumulator.observedUsageTokens,
    attributedTokens: accumulator.attributedTokens,
    parseErrors: accumulator.parseErrors,
    contextGaps: accumulator.contextGaps,
    skippedBytes: accumulator.skippedBytes,
    coverageState: coverageOf(totals),
  });
}

/** Verifies recorded boundaries for sessions the classifier wants to skip. Runs at most once per
 * session per process; a mismatch schedules a rebuild on the next pass. */
async function verifySkippedBoundaries(sources: SessionSource[], states: Map<string, EffortSessionState>) {
  for (const source of sources) {
    if (verifiedBoundaries.has(source.sessionId)) continue;
    const state = states.get(source.sessionId);
    if (!state || classify(source, state).kind !== "skip") continue;
    verifiedBoundaries.add(source.sessionId);
    const boundary = await hashBoundary(source.sourceFile, state.lastOffset);
    if (boundary !== state.resumeHash) resetEffortSession(source.sessionId);
    await yieldToLoop();
  }
}

async function drainBacklog() {
  indexingActive = true;
  try {
    // A session whose only outstanding bytes are an unterminated final line makes no progress.
    // It is normal, not an error: park it for this drain and let the next refresh retry.
    const stalled = new Set<string>();
    while (getEffortMeta().enabled) {
      const states = getEffortStates();
      await verifySkippedBoundaries(catalog, states);
      // Pending work is recomputed from catalog and state every pass rather than held in a
      // queue, so an append that lands mid-backfill is simply picked up.
      const backlog = buildBacklog(catalog, states).filter((entry) => !stalled.has(entry.source.sessionId));
      if (backlog.length === 0) break;
      const entry = backlog[0];
      const before = states.get(entry.source.sessionId)?.lastOffset ?? -1;
      const result = await indexOneSession(entry.source, entry.work);
      if (result.done && result.offset <= before) stalled.add(entry.source.sessionId);
      await yieldToLoop();
    }
    markEffortIndexed();
    setEffortError(null);
  } catch (error) {
    // A parser failure records the error; it must never invalidate the last good snapshot.
    setEffortError(error instanceof Error ? error.message : String(error));
  } finally {
    indexingActive = false;
  }
}

/** Single-flight. `refresh()` calls this after the dashboard snapshot and path catalog succeed;
 * no request handler ever awaits it. */
export function scheduleEffortIndexing() {
  if (!getEffortMeta().enabled) return null;
  if (running) return running;
  running = drainBacklog().finally(() => { running = null; });
  return running;
}

export function awaitEffortIndexing() {
  return running;
}

export function resetVerifiedBoundaries() {
  verifiedBoundaries.clear();
}
