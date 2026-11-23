import { Database, constants } from "bun:sqlite";
import { existsSync, readdirSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalModelName } from "../src/model-name";
import { dateKeyInTimeZone, systemTimeZone } from "../src/reporting-time";
import type { AntigravityData, AntigravitySessionStats } from "../src/types";
import type { EffortUsageRow } from "./effort-parse";
import { getSessionProvider, mergeActivityEpisodes, saveLocalEvidence } from "./session-evidence";
import { db } from "./store";
import { bytesOf, fieldOf, messageOf, textOf, type WireField } from "./warp-protobuf";

/**
 * Google Antigravity keeps one SQLite database per conversation, written by T3 Code's Antigravity
 * driver and by the Antigravity IDE. Every read here is metadata only: the step and generation
 * tables also hold prompts, replies, and tool payloads, so only the columns and protobuf fields
 * named below are ever selected or decoded, and no byte of anything else is kept.
 *
 * The field numbers come from bytes observed on the wire, not from a published schema, so every
 * decode is defensive: a renumbered field yields nothing rather than a wrong number.
 */

/** Only these summary columns are read. The table also holds `title`, `preview`, and
 * `raw_summary`, and full-text tables hold prompt text; none of them is ever selected. */
const summaryColumns = ["conversation_id", "workspace_uris", "last_modified_time", "status", "parent_conversation_id", "nesting_depth", "step_count"] as const;
export const ANTIGRAVITY_STEPS_SQL = "SELECT idx, step_type, status, metadata FROM steps ORDER BY idx";
/** The same read for a `steps` table without a `status` column. */
export const ANTIGRAVITY_STEPS_NO_STATUS_SQL = "SELECT idx, step_type, NULL AS status, metadata FROM steps ORDER BY idx";
export const ANTIGRAVITY_GENERATION_MAX_SQL = "SELECT COALESCE(MAX(idx), -1) AS maxIdx FROM gen_metadata";
/** The size cap is applied per row in SQL so an oversized row's bytes never leave SQLite. The
 * lower bound is inclusive, so the newest row already read is read again (see `readGenerations`). */
export const ANTIGRAVITY_GENERATION_SQL = "SELECT idx, CASE WHEN length(data) <= ? THEN data END AS data FROM gen_metadata WHERE idx >= ? ORDER BY idx";
export function antigravitySummarySql(columns: readonly string[]) {
  return `SELECT ${columns.join(", ")} FROM conversation_summaries`;
}
/** Every SQL text this module can send, for the privacy test. */
export const ANTIGRAVITY_SQL = [ANTIGRAVITY_STEPS_SQL, ANTIGRAVITY_STEPS_NO_STATUS_SQL, ANTIGRAVITY_GENERATION_MAX_SQL, ANTIGRAVITY_GENERATION_SQL, antigravitySummarySql(summaryColumns)];

const MAX_GENERATION_BYTES = 16 * 1024 * 1024;
/** A step whose `step_type` is a model turn. Other usage-bearing steps (context compaction, 23)
 * are real model calls with their own message ids, so they count too. */
const TURN_STEP_TYPE = 15;
/** `steps.status` of a finished step. A turn still being written (observed as 8) has not recorded
 * its usage yet. */
const STEP_DONE = 3;
const BUSY_TIMEOUT_MS = 250;

export type AntigravityRootKind = AntigravitySessionStats["root"];
export type AntigravityRoot = { path: string; kind: AntigravityRootKind };

/** Where ccusage looks for Antigravity data on its own. The Observatory reads the same places, so
 * the metadata it joins to ccusage's sessions covers every conversation ccusage can report. */
const defaultRoots = [".gemini/antigravity", ".gemini/antigravity-cli", ".gemini/antigravity-ide", ".gemini/antigravity-backup", ".gemini/antigravity-acp", ".config/antigravity"];

/** T3 Code names its driver directory `antigravity-acp`; ccusage's `~/.gemini/antigravity-acp`
 * default is not T3's. */
function isT3Root(path: string) {
  return path.includes("antigravity-acp") && !/[\\/]\.gemini[\\/]antigravity-acp/.test(path);
}

/** T3 Code's driver keeps one data directory per install hash, which ccusage never finds by
 * itself; the IDE and CLI keep ccusage's default directories. A path in `ANTIGRAVITY_DATA_DIRS`
 * (path-delimited) replaces all of them, for this reader and for ccusage, which is how tests stay
 * off real data. ccusage takes its list comma-separated, so a path holding a comma reaches only
 * this reader; `collectAntigravity` notes it in source health. A missing T3 installs directory
 * (ENOENT) means no T3 install; any other error listing it says nothing about which installs
 * exist, so it is passed to `onUnchecked`, which `collectAntigravity` counts as a data directory
 * that could not be checked. */
export function antigravityRoots(home = homedir(), onUnchecked?: () => void): AntigravityRoot[] {
  const override = process.env.ANTIGRAVITY_DATA_DIRS;
  if (override !== undefined) {
    return override.split(delimiter).map((path) => path.trim()).filter(Boolean)
      .map((path) => ({ path, kind: isT3Root(path) ? "t3" as const : "ide" as const }));
  }
  const roots: AntigravityRoot[] = [];
  const t3 = join(home, ".t3/userdata/providers/antigravity");
  try {
    for (const install of readdirSync(t3).sort()) roots.push({ path: join(t3, install, "antigravity-acp"), kind: "t3" });
  } catch (error) {
    if (errorCode(error) !== "ENOENT") onUnchecked?.();
  }
  for (const root of defaultRoots) roots.push({ path: join(home, root), kind: "ide" });
  return roots;
}

/** The value for ccusage's `ANTIGRAVITY_DATA_DIR`: every root, comma-separated. Setting it
 * replaces ccusage's own search, so every root is passed explicitly. An override is passed as
 * given, missing directories included, so ccusage never falls back to the real defaults. A path
 * holding a comma cannot be expressed in ccusage's list and is left out. Undefined when there is
 * nothing to read, which leaves ccusage's own (equally empty) search in place. */
export function antigravityCcusageDataDir(home = homedir()) {
  const override = process.env.ANTIGRAVITY_DATA_DIRS !== undefined;
  const roots = antigravityRoots(home).map((root) => root.path)
    .filter((path) => !ccusageCannotRead(path))
    .filter((path) => override || existsSync(path));
  // An override naming nothing must still keep ccusage off the defaults: a path that does not
  // exist reads as no data.
  if (override) return roots.length ? roots.join(",") : join(home, ".usage-observatory-no-antigravity-data");
  return roots.length ? roots.join(",") : undefined;
}

/** ccusage splits `ANTIGRAVITY_DATA_DIR` on commas, so it cannot be given a path that holds one. */
function ccusageCannotRead(path: string) {
  return path.includes(",");
}

/** Each conversation database and its `-wal`, with the stats that decide whether ccusage has to
 * run again. A write that lands only in the log still changes the `-wal` entry. Stats only: no
 * database is opened here. */
export function antigravityDatabaseFiles(home = homedir()) {
  const files: Array<{ sourceFile: string; mtimeMs: number; size: number }> = [];
  for (const root of antigravityRoots(home)) {
    const listing = listConversations(root.path);
    if (!listing.ok) continue;
    for (const { path } of listing.conversations) {
      for (const file of [path, `${path}-wal`]) {
        const stats = statOrNull(file);
        if (stats) files.push({ sourceFile: file, mtimeMs: stats.mtimeMs, size: stats.size });
      }
    }
  }
  return files;
}

type FileState = { mtimeMs: number; size: number };
type Sidecars = { main: FileState; wal: FileState | null; shm: boolean; identity: string };

function fileState(stats: Stats | undefined): FileState | null {
  return stats ? { mtimeMs: stats.mtimeMs, size: stats.size } : null;
}

function statOrNull(path: string) {
  try { return statSync(path); } catch { return undefined; }
}

/** A path's stats, `"absent"` when it does not exist (ENOENT), or `"error"` when it could not be
 * checked: a permission error on it or an ancestor, or an I/O error. Only `"absent"` means the
 * path is missing; `"error"` says nothing either way, so callers count and note it. */
type Probe = Stats | "absent" | "error";

function probe(path: string): Probe {
  try {
    return statSync(path);
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "absent" : "error";
  }
}

/** The main file's state plus its sidecars; the main file's probe result when it cannot be
 * stat'ed; or `"error"` when its `-wal` could not be checked, which says nothing about the log. */
function sidecars(path: string): Sidecars | "absent" | "error" {
  const main = probe(path);
  if (typeof main === "string") return main;
  const wal = probe(`${path}-wal`);
  if (wal === "error") return "error";
  return {
    main: fileState(main)!,
    wal: wal === "absent" ? null : fileState(wal),
    shm: existsSync(`${path}-shm`),
    identity: `${main.dev}:${main.ino}`,
  };
}

/** Main file and `-wal` together: a write that lands only in the log still changes this. */
/** Which file this is (device and inode) and how it last changed. The identity is part of the
 * signature, so a replacement that keeps the size and mtime still reads as a change everywhere a
 * signature is compared: the parse cache, the effort rows, and the activity evidence. */
export function databaseSignature(state: Pick<Sidecars, "main" | "wal" | "identity">) {
  return `${state.identity}:${state.main.mtimeMs}:${state.main.size}:${state.wal?.mtimeMs ?? 0}:${state.wal?.size ?? 0}`;
}

export type ReadResult<T> =
  | { ok: true; value: T; mode: "plain" | "immutable"; signature: string; identity: string; mtimeMs: number; size: number }
  | { ok: false; reason: string };

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
}

/**
 * Opens a provider database strictly read-only and runs `read` against it. A provider file is
 * never written, checkpointed, or copied, and the reader creates no `-wal` or `-shm` beside it,
 * with one narrow exception described below.
 *
 * - A database with no `-wal`, or an empty one, has no log to miss, so it is always read with
 *   `immutable=1`, whether or not a `-shm` exists. That read takes no lock and opens neither
 *   sidecar, and its result is kept only when the file (identity, size, mtime) and the absence of a
 *   non-empty `-wal` look the same after the read as before it; otherwise it fails closed.
 * - A read-only connection creates a missing `-shm` when a `-wal` exists, so a non-empty `-wal`
 *   without a `-shm` cannot be read safely at all and is refused.
 * - Only a non-empty `-wal` beside a `-shm` (a live writer) gets the plain read-only open.
 *
 * The exception: that plain open recreates the `-shm` if a process other than SQLite deletes it
 * between the probe and the first query. SQLite itself removes the two files only when the last
 * connection closes, while it holds an exclusive lock that this reader waits for. The worst case
 * is a `-shm` left beside the database, holding SQLite's index of the log and no conversation
 * data; the database and its `-wal` are unchanged.
 */
export function readProviderDatabase<T>(path: string, read: (database: Database) => T): ReadResult<T> {
  const before = sidecars(path);
  if (typeof before === "string") return { ok: false, reason: before === "absent" ? "missing" : "the file could not be checked" };
  const success = (value: T, mode: "plain" | "immutable", state: Sidecars) => ({
    ok: true as const, value, mode, signature: databaseSignature(state), identity: state.identity,
    mtimeMs: state.main.mtimeMs, size: state.main.size,
  });
  const immutable = (): ReadResult<T> => {
    let value: T;
    try {
      const database = new Database(`${pathToFileURL(path).href}?immutable=1`, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI);
      try { value = read(database); } finally { database.close(); }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    const after = sidecars(path);
    if (typeof after === "string" || databaseSignature(after) !== databaseSignature(before) || (after.wal?.size ?? 0) > 0) {
      return { ok: false, reason: "the database changed while it was read" };
    }
    return success(value, "immutable", before);
  };
  if (!before.wal || before.wal.size === 0) return immutable();
  if (before.wal && !before.shm) return { ok: false, reason: "write-ahead log without shared memory" };
  try {
    const database = new Database(path, { readonly: true });
    try {
      database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      return success(read(database), "plain", before);
    } finally {
      database.close();
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

type Summary = {
  conversationId: string;
  cwd: string | null;
  lastModified: string | null;
  parentConversationId: string | null;
  nestingDepth: number;
  stepCount: number;
};

/** Antigravity writes the Go zero time (`0001-01-01`) for a time it never set, and microseconds
 * that `Date` would otherwise read inconsistently. */
export function antigravityTime(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.trim().replace(" ", "T").replace(/(\.\d{3})\d+/, "$1");
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed) || new Date(parsed).getUTCFullYear() < 2000) return null;
  return new Date(parsed).toISOString();
}

/** The first `file://` workspace, as a path. Anything else (a remote URI, malformed JSON) is no
 * working directory rather than a guessed one. */
export function antigravityCwd(value: unknown) {
  if (typeof value !== "string") return null;
  let uris: unknown;
  try { uris = JSON.parse(value); } catch { return null; }
  if (!Array.isArray(uris)) return null;
  const uri = uris.find((entry): entry is string => typeof entry === "string" && entry.startsWith("file://"));
  if (!uri) return null;
  try { return fileURLToPath(uri).replace(/\/+$/, "") || "/"; } catch { return null; }
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readSummaries(database: Database) {
  const tables = database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversation_summaries'").all();
  if (!tables.length) return { summaries: new Map<string, Summary>(), drift: true };
  const present = new Set((database.query("PRAGMA table_info(conversation_summaries)").all() as Array<{ name: string }>).map((column) => column.name));
  const columns = summaryColumns.filter((column) => present.has(column));
  if (!present.has("conversation_id")) return { summaries: new Map<string, Summary>(), drift: true };
  const rows = database.query(antigravitySummarySql(columns)).all() as Array<Record<string, unknown>>;
  const summaries = new Map<string, Summary>();
  for (const row of rows) {
    const conversationId = stringOrNull(row.conversation_id);
    if (!conversationId) continue;
    summaries.set(conversationId, {
      conversationId,
      cwd: antigravityCwd(row.workspace_uris),
      lastModified: antigravityTime(row.last_modified_time),
      parentConversationId: stringOrNull(row.parent_conversation_id),
      nestingDepth: Number(row.nesting_depth) || 0,
      stepCount: Number(row.step_count) || 0,
    });
  }
  return { summaries, drift: columns.length < summaryColumns.length };
}

function varintOf(fields: WireField[], field: number) {
  const found = fieldOf(fields, field);
  if (found?.kind !== "varint") return null;
  const value = Number(found.value);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** A `google.protobuf.Timestamp` (seconds in field 1, nanos in field 2) as epoch milliseconds.
 * Antigravity's step times are true UTC, unlike Warp's. */
function timestampMs(fields: WireField[], field: number) {
  const bytes = bytesOf(fields, field);
  const message = bytes ? messageOf(bytes) : null;
  if (!message) return null;
  const seconds = varintOf(message, 1);
  if (seconds === null || seconds <= 0) return null;
  const nanos = varintOf(message, 2) ?? 0;
  const value = seconds * 1000 + Math.floor(nanos / 1_000_000);
  return new Date(value).getUTCFullYear() >= 2000 ? value : null;
}

/** One usage record: `steps.metadata` field 9, repeated in `gen_metadata` at 1.4.
 * f1 model enum, f2 uncached input, f3 output, f4 cache write (never observed; read defensively),
 * f5 cache read, f7 message id. f9 + f10 = f3; f9 is inferred to be thinking, because it carries
 * the large share on long reasoning turns, so it is counted as reasoning only while it fits
 * inside output. */
export type UsageRecord = {
  modelEnum: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  reasoningOutputTokens: number;
  reasoningReported: boolean;
  messageId: string | null;
};

export function decodeUsage(bytes: Uint8Array | null): UsageRecord | null {
  const fields = bytes ? messageOf(bytes) : null;
  if (!fields) return null;
  const modelEnum = varintOf(fields, 1);
  const input = varintOf(fields, 2);
  const output = varintOf(fields, 3);
  const cacheRead = varintOf(fields, 5);
  if (modelEnum === null || (input === null && output === null && cacheRead === null)) return null;
  const outputTokens = output ?? 0;
  const thinking = varintOf(fields, 9);
  const reasoningReported = thinking !== null && thinking <= outputTokens;
  return {
    modelEnum,
    inputTokens: input ?? 0,
    outputTokens,
    cacheWriteTokens: varintOf(fields, 4) ?? 0,
    cacheReadTokens: cacheRead ?? 0,
    reasoningOutputTokens: reasoningReported ? thinking : 0,
    reasoningReported,
    messageId: textOf(fields, 7),
  };
}

const effortLabels = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

/** The provider-recorded effort in a model label's trailing parentheses ("Gemini 4 Neon (High)").
 * Only the known vocabulary counts; anything else is unknown, never a guess, and the model id is
 * never read for an effort. */
export function effortFromLabel(label: string | null | undefined) {
  const match = typeof label === "string" ? label.match(/\(([^()]*)\)\s*$/) : null;
  if (!match) return "";
  const value = match[1]!.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  const normalized = value === "extra high" ? "xhigh" : value;
  return effortLabels.has(normalized) ? normalized : "";
}

type ModelLabel = { modelId: string | null; label: string | null };
/** What the generation rows say, for looking up each usage step's model and label. */
type GenerationLookup = {
  byMessage: Map<string, ModelLabel>;
  byEnum: Map<number, { modelId: string | null; labels: Set<string> }>;
  oversized: number;
};
/** One decoded `gen_metadata` row: its message id, model enum, and model label, or an oversized
 * row whose bytes were never read. */
type GenerationRow = { oversized: true } | { oversized: false; messageId: string | null; modelEnum: number | null; entry: ModelLabel };
/** `gen_metadata` scanned so far for one conversation file.
 *
 * The contract, as observed: rows are appended, and only the newest row can still be completed in
 * place (a generation's metadata is written before the turn ends). So `settled` holds every row
 * below `lastIdx`, read once, and `tail` holds the row at `lastIdx`, which the next pass reads
 * again. A change to an older row is not seen until the file is replaced. */
type GenerationIndex = {
  identity: string;
  lastIdx: number;
  settled: GenerationLookup;
  tail: GenerationRow | null;
};

function emptyLookup(): GenerationLookup {
  return { byMessage: new Map(), byEnum: new Map(), oversized: 0 };
}

function emptyGenerationIndex(identity: string): GenerationIndex {
  return { identity, lastIdx: -1, settled: emptyLookup(), tail: null };
}

function cloneLookup(lookup: GenerationLookup): GenerationLookup {
  return {
    byMessage: new Map(lookup.byMessage),
    byEnum: new Map([...lookup.byEnum].map(([key, value]) => [key, { modelId: value.modelId, labels: new Set(value.labels) }])),
    oversized: lookup.oversized,
  };
}

/** Reads only 1.19 (model id), 1.21 (label), and the usage record at 1.4 from one generation.
 * The same row also embeds prompt content in other fields; those bytes are skipped by length and
 * never decoded. */
function decodeGeneration(data: Uint8Array | null): GenerationRow | null {
  if (data === null) return { oversized: true };
  const top = messageOf(data);
  const generation = top ? bytesOf(top, 1) : null;
  const fields = generation ? messageOf(generation) : null;
  if (!fields) return null;
  const usage = bytesOf(fields, 4);
  const usageFields = usage ? messageOf(usage) : null;
  return {
    oversized: false,
    messageId: usageFields ? textOf(usageFields, 7) : null,
    modelEnum: (usageFields ? varintOf(usageFields, 1) : null) ?? varintOf(fields, 3),
    entry: { modelId: stringOrNull(textOf(fields, 19)), label: stringOrNull(textOf(fields, 21)) },
  };
}

function applyGeneration(lookup: GenerationLookup, row: GenerationRow) {
  if (row.oversized) {
    lookup.oversized++;
    return;
  }
  const { messageId, modelEnum, entry } = row;
  if (messageId) lookup.byMessage.set(messageId, entry);
  if (modelEnum !== null) {
    const known = lookup.byEnum.get(modelEnum) ?? { modelId: entry.modelId, labels: new Set<string>() };
    known.modelId ??= entry.modelId;
    if (entry.label) known.labels.add(entry.label);
    lookup.byEnum.set(modelEnum, known);
  }
}

/** The settled rows plus the newest one. */
function lookupOf(index: GenerationIndex) {
  const lookup = cloneLookup(index.settled);
  if (index.tail) applyGeneration(lookup, index.tail);
  return lookup;
}

const generationIndexes = new Map<string, GenerationIndex>();

function readGenerations(database: Database, path: string, identity: string, tables: Set<string>) {
  if (!tables.has("gen_metadata")) return emptyGenerationIndex(identity);
  const maxIdx = Number((database.query(ANTIGRAVITY_GENERATION_MAX_SQL).get() as { maxIdx: number }).maxIdx);
  const prior = generationIndexes.get(path);
  // A replaced file, or one whose rows moved backwards, cannot be appended to.
  const resume = prior && prior.identity === identity && maxIdx >= prior.lastIdx;
  // The previous tail is dropped: its row is read again, as it may have been completed in place.
  const next: GenerationIndex = resume
    ? { identity, lastIdx: prior.lastIdx, settled: cloneLookup(prior.settled), tail: null }
    : emptyGenerationIndex(identity);
  for (const row of database.query(ANTIGRAVITY_GENERATION_SQL).iterate(MAX_GENERATION_BYTES, next.lastIdx) as Iterable<{ idx: number; data: Uint8Array | null }>) {
    readStats.generationRows++;
    if (next.tail) applyGeneration(next.settled, next.tail);
    next.tail = decodeGeneration(row.data);
    next.lastIdx = Math.max(next.lastIdx, Number(row.idx));
  }
  return next;
}

export type UsageCall = UsageRecord & {
  stepIdx: number;
  stepType: number;
  at: number | null;
  modelId: string | null;
  label: string | null;
};

export type ConversationParse = {
  calls: UsageCall[];
  activity: number[];
  stepsNotUnderstood: number;
  turnsWithoutUsage: number;
  oversizedGenerations: number;
  drift: boolean;
};

function readConversation(database: Database, path: string, identity: string): { parse: ConversationParse; generations: GenerationIndex } {
  const tables = new Set((database.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
  const stepColumns = tables.has("steps")
    ? new Set((database.query("PRAGMA table_info(steps)").all() as Array<{ name: string }>).map((column) => column.name))
    : new Set<string>();
  if (!["idx", "step_type", "metadata"].every((column) => stepColumns.has(column))) {
    return { parse: { calls: [], activity: [], stepsNotUnderstood: 0, turnsWithoutUsage: 0, oversizedGenerations: 0, drift: true }, generations: emptyGenerationIndex(identity) };
  }
  const generations = readGenerations(database, path, identity, tables);
  const lookup = lookupOf(generations);
  const calls: UsageCall[] = [];
  const seen = new Set<string>();
  const activity: number[] = [];
  let stepsNotUnderstood = 0;
  let turnsWithoutUsage = 0;
  const stepsSql = stepColumns.has("status") ? ANTIGRAVITY_STEPS_SQL : ANTIGRAVITY_STEPS_NO_STATUS_SQL;
  for (const row of database.query(stepsSql).iterate() as Iterable<{ idx: number; step_type: number | null; status: number | null; metadata: Uint8Array | null }>) {
    if (!row.metadata) continue;
    const fields = messageOf(row.metadata);
    if (!fields) {
      stepsNotUnderstood++;
      continue;
    }
    const at = timestampMs(fields, 1);
    if (at !== null) activity.push(at);
    const finished = timestampMs(fields, 8);
    if (finished !== null) activity.push(finished);
    const usage = decodeUsage(bytesOf(fields, 9));
    if (!usage) {
      // A turn still running has not written its usage yet; only a finished one is expected to.
      // Without a status column every turn is taken as finished.
      const finishedTurn = row.status === null || Number(row.status) === STEP_DONE;
      if (Number(row.step_type) === TURN_STEP_TYPE && finishedTurn) turnsWithoutUsage++;
      continue;
    }
    const key = usage.messageId ? `message:${usage.messageId}` : `step:${row.idx}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const byMessage = usage.messageId ? lookup.byMessage.get(usage.messageId) : undefined;
    const byEnum = lookup.byEnum.get(usage.modelEnum);
    // A step absent from `gen_metadata` (a compaction call) takes its model from the enum, and its
    // label only when that enum ran under exactly one label in this conversation.
    const model: ModelLabel = byMessage ?? {
      modelId: byEnum?.modelId ?? null,
      label: byEnum && byEnum.labels.size === 1 ? [...byEnum.labels][0]! : null,
    };
    calls.push({ ...usage, stepIdx: Number(row.idx), stepType: Number(row.step_type), at, modelId: model.modelId, label: model.label });
  }
  return { parse: { calls, activity, stepsNotUnderstood, turnsWithoutUsage, oversizedGenerations: lookup.oversized, drift: false }, generations };
}

type CachedConversation = { signature: string; parse: ConversationParse; identity: string; mtimeMs: number; size: number };
const conversationCache = new Map<string, CachedConversation>();
type CachedSummaries = { signature: string; identity: string; summaries: Map<string, Summary>; drift: boolean };
const summaryCache = new Map<string, CachedSummaries>();
/** Conversations whose activity evidence was saved for this signature, so evidence is rewritten
 * only when the conversation changed or its rows were deleted. */
const evidenceSaved = new Map<string, string>();

const readStats = { conversationReads: 0, generationRows: 0, summaryReads: 0 };

/** Test hook: how much work the caches saved. */
export function antigravityReadStats() {
  return { ...readStats };
}

/** Test hook: forget every cached parse. */
export function resetAntigravityCache() {
  conversationCache.clear();
  summaryCache.clear();
  generationIndexes.clear();
  evidenceSaved.clear();
  sessionModels.clear();
  readStats.conversationReads = 0;
  readStats.generationRows = 0;
  readStats.summaryReads = 0;
}

/** Everything the effort sync needs for one session, computed with the collection. */
export type AntigravityEffortSource = {
  sessionId: string;
  conversationId: string;
  sourceFile: string;
  cwd: string | null;
  signature: string;
  identity: string;
  mtimeMs: number;
  size: number;
  /** The reporting time zone the rows' `occurredOn` days were computed in. */
  timeZone: string;
  rows: EffortUsageRow[];
  activityTimestamps: number[];
  observations: number;
  unknownObservations: number;
  tokens: number;
  attributedTokens: number;
};

/** The facts ccusage does not report about one conversation. ccusage owns the session's tokens,
 * cost, and calendar rows; the collector joins these onto its session by conversation id. */
export type AntigravityConversation = {
  conversationId: string;
  sessionId: string;
  cwd: string | null;
  lastActivity: string;
  models: string[];
  stats: AntigravitySessionStats;
  activityIntervals: Array<{ startAt: number; endAt: number }>;
  /** Input + output + cache read + cache write from the usage records. Output already holds the
   * thinking tokens here, so this is comparable with ccusage's `totalTokens`. Used only to
   * reconcile the two readers, never added to a total. */
  tokens: number;
};

export type AntigravityCollection = AntigravityData & {
  conversations: AntigravityConversation[];
  effortSources: AntigravityEffortSource[];
  /** Stored sessions whose own database file is gone (ENOENT). Only these are pruned. */
  missingSessionIds: string[];
};

/** The one session id for a conversation, root-independent like Warp's `warp-<id>`. ccusage
 * reports the conversation id as the session's `period`, so both readers produce the same id, and
 * the session-detail and quota-context prefix checks keep working. */
export function antigravitySessionId(conversationId: string) {
  return `antigravity-${conversationId}`;
}

type Candidate = {
  conversationId: string;
  root: AntigravityRoot;
  path: string;
  summary: Summary | undefined;
  parse: ConversationParse;
  fresh: boolean;
  identity: string;
  signature: string;
  mtimeMs: number;
  size: number;
};

function tokensOf(call: Pick<UsageRecord, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">) {
  return call.inputTokens + call.outputTokens + call.cacheReadTokens + call.cacheWriteTokens;
}

function modelOf(call: UsageCall) {
  return call.modelId ? canonicalModelName(call.modelId) || "Unknown model" : "Unknown model";
}

function prefer(left: Candidate, right: Candidate) {
  if (left.fresh !== right.fresh) return left.fresh ? left : right;
  const leftTime = left.summary?.lastModified ?? "";
  const rightTime = right.summary?.lastModified ?? "";
  if (leftTime !== rightTime) return leftTime > rightTime ? left : right;
  return right.parse.calls.length > left.parse.calls.length ? right : left;
}

function conversationOf(candidate: Candidate): AntigravityConversation {
  const { conversationId, parse, summary } = candidate;
  const models = new Map<string, number>();
  let reasoning = 0;
  let tokens = 0;
  for (const call of parse.calls) {
    const model = modelOf(call);
    models.set(model, (models.get(model) ?? 0) + tokensOf(call));
    reasoning += call.reasoningOutputTokens;
    tokens += tokensOf(call);
  }
  const latest = parse.activity.length ? new Date(Math.max(...parse.activity)).toISOString() : null;
  return {
    conversationId,
    sessionId: antigravitySessionId(conversationId),
    cwd: summary?.cwd ?? null,
    lastActivity: latest ?? summary?.lastModified ?? new Date(candidate.mtimeMs).toISOString(),
    models: [...models.entries()].sort((left, right) => right[1] - left[1]).map(([model]) => model),
    stats: {
      conversationId,
      generations: parse.calls.length,
      reasoningOutputTokens: reasoning,
      parentConversationId: summary?.parentConversationId ?? null,
      root: candidate.root.kind,
    },
    activityIntervals: mergeActivityEpisodes(parse.activity),
    tokens,
  };
}

function effortSourceOf(candidate: Candidate, conversation: AntigravityConversation, timeZone: string): AntigravityEffortSource {
  const rows = new Map<string, EffortUsageRow>();
  let unknownObservations = 0;
  let attributedTokens = 0;
  for (const call of candidate.parse.calls) {
    const occurredOn = dateKeyInTimeZone(call.at === null ? conversation.lastActivity : new Date(call.at), timeZone) ?? "";
    const model = modelOf(call);
    const effort = effortFromLabel(call.label);
    const key = `${occurredOn}\0${model}\0${effort}`;
    const row = rows.get(key) ?? {
      occurredOn, model, effort, observations: 0, inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      outputTokens: 0, reasoningOutputTokens: 0, reasoningReportedEvents: 0, totalTokens: 0,
    };
    row.observations += 1;
    row.inputTokens += call.inputTokens;
    row.cacheReadTokens += call.cacheReadTokens;
    row.cacheCreationTokens += call.cacheWriteTokens;
    row.outputTokens += call.outputTokens;
    row.reasoningOutputTokens += call.reasoningOutputTokens;
    if (call.reasoningReported) row.reasoningReportedEvents += 1;
    row.totalTokens += tokensOf(call);
    rows.set(key, row);
    if (effort) attributedTokens += tokensOf(call);
    else unknownObservations += 1;
  }
  return {
    sessionId: conversation.sessionId,
    conversationId: candidate.conversationId,
    sourceFile: candidate.path,
    cwd: conversation.cwd,
    signature: candidate.signature,
    identity: candidate.identity,
    mtimeMs: candidate.mtimeMs,
    size: candidate.size,
    timeZone,
    rows: [...rows.values()],
    activityTimestamps: [...new Set(candidate.parse.activity)].sort((a, b) => a - b),
    observations: candidate.parse.calls.length,
    unknownObservations,
    tokens: conversation.tokens,
    attributedTokens,
  };
}

function displayPath(path: string) {
  return relative(homedir(), path) || path;
}

type ConversationListing =
  | { ok: true; conversations: Array<{ conversationId: string; path: string }> }
  | { ok: false; reason: string };

/** A missing `conversations` directory is a root with no conversations: an empty, complete
 * listing. Any other failure (permissions, I/O) says nothing about which conversations exist. */
function listConversations(root: string): ConversationListing {
  try {
    const conversations = readdirSync(join(root, "conversations"))
      .filter((name) => name.endsWith(".db"))
      .map((name) => ({ conversationId: name.slice(0, -".db".length), path: join(root, "conversations", name) }))
      .sort((left, right) => left.conversationId.localeCompare(right.conversationId));
    return { ok: true, conversations };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { ok: true, conversations: [] };
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Stored Antigravity sessions this collection did not produce, checked one by one against their
 * own database file. Only ENOENT on that file means the conversation is gone. Anything else (a
 * permission error on the file or an ancestor, an I/O error, a file that is there but could not
 * be read or understood this time, or a file under a root that is no longer configured) says
 * nothing about whether it still exists, so its row and effort rows are kept and counted as not
 * read this time. A file in `alreadyNoted` was listed and counted as unreadable by the collection,
 * so it is kept without being counted again.
 */
function checkStoredSessions(seen: ReadonlySet<string>, alreadyNoted: ReadonlySet<string>) {
  const rows = db.query("SELECT session_id AS sessionId, source_file AS sourceFile FROM session_paths WHERE agent = 'antigravity'")
    .all() as Array<{ sessionId: string; sourceFile: string }>;
  const missing: string[] = [];
  let unchecked = 0;
  for (const row of rows) {
    if (seen.has(row.sessionId) || alreadyNoted.has(row.sourceFile)) continue;
    try {
      statSync(row.sourceFile);
      unchecked++;
    } catch (error) {
      if (errorCode(error) === "ENOENT") missing.push(row.sessionId);
      else unchecked++;
    }
  }
  return { missing, unchecked };
}

/** Models each session recorded, from the newest collection. Quota context reads it to tell which
 * model windows can have moved for a session. */
const sessionModels = new Map<string, string[]>();

export function antigravitySessionModels(sessionId: string) {
  return sessionModels.get(sessionId) ?? null;
}

/**
 * Reads the conversation metadata ccusage does not report: working directory, effort labels, the
 * thinking split, step times, and source health. Tokens and cost are ccusage's; this reader's
 * token sum is kept only to reconcile against ccusage's, and it emits no session, row, or total.
 */
export function collectAntigravity(timeZone = systemTimeZone()): AntigravityCollection {
  const observedAt = new Date().toISOString();
  const notes = new Set<string>();
  // A root that is absent has nothing to read. One that could not be checked (a permission error
  // on an ancestor, an I/O error) is not missing: it is counted and noted, and its stored rows are
  // kept by the per-row check below.
  let uncheckedRoots = 0;
  const roots = antigravityRoots(homedir(), () => uncheckedRoots++).filter((root) => {
    const state = probe(root.path);
    if (state === "error") uncheckedRoots++;
    return typeof state !== "string";
  });
  let unlisted = 0;
  let unreadable = 0;
  let drift = 0;
  let stepsNotUnderstood = 0;
  let oversizedGenerations = 0;
  let turnsWithoutUsage = 0;
  const candidates = new Map<string, Candidate>();
  const present = new Set<string>();
  // Listed conversation files already counted as unreadable, so the stored-row check below does
  // not count them a second time.
  const notedUnreadable = new Set<string>();

  for (const root of roots) {
    const summaryPath = join(root.path, "conversation_summaries.db");
    let summaries = new Map<string, Summary>();
    const summaryState = sidecars(summaryPath);
    if (summaryState === "error") {
      unreadable++;
      // Unlike a conversation's cached parse, cached summary metadata is kept through a stat
      // error: it only labels sessions (working directory, subagent links) that ccusage already
      // reports, and supplies no session, token, or cost of its own.
      const cached = summaryCache.get(summaryPath);
      if (cached) {
        summaries = cached.summaries;
        if (cached.drift) drift++;
      }
    } else if (summaryState !== "absent") {
      const cached = summaryCache.get(summaryPath);
      if (cached && cached.signature === databaseSignature(summaryState) && cached.identity === summaryState.identity) {
        summaries = cached.summaries;
        if (cached.drift) drift++;
      } else {
        readStats.summaryReads++;
        const read = readProviderDatabase(summaryPath, readSummaries);
        if (read.ok) {
          summaries = read.value.summaries;
          if (read.value.drift) drift++;
          summaryCache.set(summaryPath, { signature: read.signature, identity: read.identity, summaries, drift: read.value.drift });
        } else {
          unreadable++;
          if (cached) {
            summaries = cached.summaries;
            if (cached.drift) drift++;
          }
        }
      }
    }
    const listing = listConversations(root.path);
    if (!listing.ok) {
      // No cached parse is served for this root: ccusage cannot list it either and reports none of
      // its sessions, and its files leave the ccusage fingerprint, so there is no session to join
      // metadata onto. Its stored effort rows are kept by the per-row check below.
      unlisted++;
      continue;
    }
    for (const { conversationId, path } of listing.conversations) {
      present.add(path);
      const state = sidecars(path);
      // Listed a moment ago and gone now: nothing to read. A file that could not be checked is
      // not missing, so it is counted; its stored rows are kept by the per-row check below.
      if (state === "absent") continue;
      if (state === "error") {
        unreadable++;
        notedUnreadable.add(path);
        continue;
      }
      const cached = conversationCache.get(path);
      let parse: ConversationParse;
      let fresh = true;
      let identity = state.identity;
      let signature = databaseSignature(state);
      let mtimeMs = state.main.mtimeMs;
      let size = state.main.size;
      if (cached && cached.signature === signature && cached.identity === identity) {
        parse = cached.parse;
      } else {
        readStats.conversationReads++;
        const read = readProviderDatabase(path, (database) => readConversation(database, path, state.identity));
        if (read.ok) {
          parse = read.value.parse;
          generationIndexes.set(path, read.value.generations);
          ({ identity, signature, mtimeMs, size } = read);
          conversationCache.set(path, { signature, parse, identity, mtimeMs, size });
        } else if (cached) {
          // Keep the last good parse rather than dropping a session over one unsafe read.
          unreadable++;
          parse = cached.parse;
          fresh = false;
          ({ identity, signature, mtimeMs, size } = cached);
        } else {
          unreadable++;
          notedUnreadable.add(path);
          continue;
        }
      }
      if (parse.drift) drift++;
      stepsNotUnderstood += parse.stepsNotUnderstood;
      oversizedGenerations += parse.oversizedGenerations;
      turnsWithoutUsage += parse.turnsWithoutUsage;
      // Placeholder conversations (created, never prompted) carry no usage and are not sessions.
      if (!parse.calls.length) continue;
      const candidate: Candidate = { conversationId, root, path, summary: summaries.get(conversationId), parse, fresh, identity, signature, mtimeMs, size };
      const existing = candidates.get(conversationId);
      candidates.set(conversationId, existing ? prefer(existing, candidate) : candidate);
    }
  }
  for (const path of conversationCache.keys()) {
    if (!present.has(path)) {
      conversationCache.delete(path);
      generationIndexes.delete(path);
    }
  }

  const chosen = [...candidates.values()];
  const conversationsById = new Map<string, AntigravityConversation>();
  for (const candidate of chosen) conversationsById.set(candidate.conversationId, conversationOf(candidate));
  const conversations = [...conversationsById.values()];
  sessionModels.clear();
  for (const conversation of conversations) sessionModels.set(conversation.sessionId, conversation.models);
  const effortSources = chosen.map((candidate) => effortSourceOf(candidate, conversationsById.get(candidate.conversationId)!, timeZone));
  const stored = checkStoredSessions(new Set(effortSources.map((source) => source.sessionId)), notedUnreadable);

  for (const source of effortSources) {
    // Step times are the only activity evidence. A summary's modified time can order sessions but
    // never stands in for when work happened.
    if (!source.activityTimestamps.length) continue;
    if (evidenceSaved.get(source.sessionId) === source.signature && getSessionProvider(source.sessionId) === "antigravity") continue;
    saveLocalEvidence({
      sessionId: source.sessionId,
      provider: "antigravity",
      sourceIdentity: source.identity,
      sourceMtime: source.mtimeMs,
      activityTimestamps: source.activityTimestamps,
    });
    evidenceSaved.set(source.sessionId, source.signature);
  }

  const calls = chosen.flatMap((candidate) => candidate.parse.calls);
  const auxiliaryCalls = calls.filter((call) => call.stepType !== TURN_STEP_TYPE).length;
  const unknownEffort = effortSources.reduce((sum, source) => sum + source.unknownObservations, 0);
  const commaRoots = roots.filter((root) => ccusageCannotRead(root.path)).length;
  const subagentConversations = chosen.filter((candidate) => candidate.summary?.parentConversationId || (candidate.summary?.nestingDepth ?? 0) > 0).length;
  if (uncheckedRoots) notes.add(`${plural(uncheckedRoots, "data directory", "data directories")} could not be checked; ${uncheckedRoots === 1 ? "its" : "their"} sessions are left out`);
  if (unlisted) notes.add(`${plural(unlisted, "conversations directory", "conversations directories")} could not be listed; ${unlisted === 1 ? "its" : "their"} sessions are left out`);
  if (commaRoots) notes.add(`${plural(commaRoots, "data directory", "data directories")} with a comma in the path cannot be passed to ccusage, which reports no usage from ${commaRoots === 1 ? "it" : "them"}`);
  if (unreadable) notes.add(`${plural(unreadable, "database")} could not be read this time`);
  if (drift) notes.add(`${plural(drift, "database")} did not match the expected schema`);
  if (stepsNotUnderstood) notes.add(`${plural(stepsNotUnderstood, "step")} could not be decoded`);
  // A finished model turn always records its usage, so one without it means the field moved.
  if (turnsWithoutUsage) notes.add(`${plural(turnsWithoutUsage, "model turn")} carried no readable usage record`);
  if (oversizedGenerations) notes.add(`${plural(oversizedGenerations, "generation record")} over 16 MiB skipped`);
  if (unknownEffort) notes.add(`${plural(unknownEffort, "model call")} without a recognized effort label`);
  if (stored.unchecked) {
    const one = stored.unchecked === 1;
    notes.add(`${plural(stored.unchecked, "stored conversation")} ${one ? "was" : "were"} not read this time; ${one ? "its" : "their"} effort rows are kept until ${one ? "its" : "their"} database file is deleted`);
  }
  if (subagentConversations) notes.add(`${plural(subagentConversations, "subagent conversation")} counted as separate sessions`);

  const days = new Map<string, { generations: number; tokens: number }>();
  for (const candidate of chosen) {
    const conversation = conversationsById.get(candidate.conversationId)!;
    for (const call of candidate.parse.calls) {
      const date = dateKeyInTimeZone(call.at === null ? conversation.lastActivity : new Date(call.at), timeZone);
      if (!date) continue;
      const day = days.get(date) ?? { generations: 0, tokens: 0 };
      day.generations += 1;
      day.tokens += tokensOf(call);
      days.set(date, day);
    }
  }
  return {
    available: roots.length > 0,
    roots: roots.map((root) => displayPath(root.path)),
    observedAt,
    sessionCount: conversations.length,
    generationCount: calls.length,
    auxiliaryCalls,
    totals: {
      sessions: conversations.length,
      generations: calls.length,
      tokens: conversations.reduce((sum, conversation) => sum + conversation.tokens, 0),
      reasoningOutputTokens: conversations.reduce((sum, conversation) => sum + conversation.stats.reasoningOutputTokens, 0),
    },
    daily: [...days.entries()].map(([date, values]) => ({ date, ...values })).sort((left, right) => left.date.localeCompare(right.date)),
    notes: [...notes],
    subagentConversations,
    ...(roots.length ? {} : {
      error: uncheckedRoots ? "No Antigravity data directory could be read on this machine." : "No Antigravity data directory was found on this machine.",
    }),
    conversations,
    effortSources,
    missingSessionIds: stored.missing,
  };
}
