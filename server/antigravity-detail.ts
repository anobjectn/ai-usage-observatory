import type { Database } from "bun:sqlite";
import { basename, dirname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DATABASE_CHANGED_WHILE_READ,
  antigravityFileSignature,
  antigravityRoots,
  antigravitySessionDatabase,
  readProviderDatabase,
  stepTimestampMs,
} from "./antigravity";
import { fileStatus, type FileChange, type FileStatus } from "./file-changes";
import { getSessionSource } from "./path-indexer";
import {
  detailOutputSampleCharacters,
  detailOutputSampleCount,
  detailPromptCharacters,
  detailPromptCount,
  type SessionDetail,
} from "./session-detail";
import { bytesOf, decodeText, fieldOf, fieldsOf, messageOf, textOf } from "./warp-protobuf";

/**
 * The on-demand session detail for one Antigravity conversation: the user's prompts, the final
 * reply text, tool-call names, and the paths edit and write tools changed. This is the only place
 * Antigravity conversation content is decoded. It runs only when a session's detail is requested,
 * opens only that conversation's database (through `readProviderDatabase`, never for writing),
 * and keeps nothing: the result is sent to the local browser and dropped.
 *
 * The field map was read off the wire, not from a published schema, so every decode is defensive
 * and fails closed: a renumbered or unexpected field yields an empty or unavailable detail, never
 * text from the wrong field.
 *
 * - Step type 14 (user input), payload field 19: repeated 19.3 items, each with its text in
 *   field 1. 19.2 (a concatenated copy that includes injected context) is never read.
 * - Step type 15 (model turn), payload field 20: 20.1 the final reply, mirrored in 20.8; repeated
 *   20.7 tool calls (2 name, 3 JSON arguments). 20.3 (thinking) and 20.14 are never decoded.
 * - Tool results and command output (step type 132) are never selected.
 */

/** The size cap is applied per row in SQL, so an oversized payload's bytes never leave SQLite. */
export const ANTIGRAVITY_DETAIL_SQL = "SELECT idx, step_type, CASE WHEN length(metadata) <= ? THEN metadata END AS metadata, CASE WHEN length(step_payload) <= ? THEN step_payload END AS step_payload FROM steps WHERE step_type IN (14, 15) ORDER BY idx";

export const MAX_STEP_PAYLOAD_BYTES = 8_000_000;
/** Step metadata only carries the step time here; an oversized one is not read and the step has
 * no time. */
export const MAX_STEP_METADATA_BYTES = 1_000_000;
/** Above this many user-input and model-turn steps the conversation is not read at all. */
export const MAX_DETAIL_STEPS = 20_000;
/** Every payload and metadata blob read for one detail together; past it the detail is unavailable rather than
 * a partial view. */
export const MAX_DETAIL_PAYLOAD_BYTES = 64 * 1024 * 1024;

const USER_INPUT_STEP = 14;
const MODEL_TURN_STEP = 15;

const sessionPrefix = "antigravity-";
const conversationIdPattern = /^[A-Za-z0-9._-]{1,200}$/;

/**
 * The conversation file behind a session, from the newest collection's choice, then the stored
 * session row. Opened only when it is `<conversation id>.db` directly inside a `conversations`
 * directory of a currently configured root, so a stale row from a root no longer configured, or
 * any other path, is never opened. Null means unavailable.
 */
export function antigravityDetailSource(sessionId: string): { sourceFile: string; cwd: string | null } | null {
  if (!sessionId.startsWith(sessionPrefix)) return null;
  const conversationId = sessionId.slice(sessionPrefix.length);
  if (!conversationIdPattern.test(conversationId) || conversationId.includes("..")) return null;
  let candidate = antigravitySessionDatabase(sessionId);
  if (!candidate) {
    const row = getSessionSource(sessionId);
    if (row?.agent === "antigravity") candidate = { sourceFile: row.sourceFile, cwd: row.cwd };
  }
  if (!candidate || basename(candidate.sourceFile) !== `${conversationId}.db`) return null;
  const sourceFile = resolve(candidate.sourceFile);
  const directory = dirname(sourceFile);
  const configured = antigravityRoots().some((root) => resolve(root.path, "conversations") === directory);
  return configured ? { sourceFile, cwd: candidate.cwd } : null;
}

/** Identity, main file, and `-wal`, or null when the file is missing or could not be checked. */
export { antigravityFileSignature };

type StepRow = { idx: number; step_type: number | null; metadata: unknown; step_payload: unknown };

const harnessTags = new Set(["runtime_info", "environment_context", "user_instructions"]);
const userRequestTag = "user_request";
const openTagAt = /<([A-Za-z_][\w-]*)(?:\s[^<>]*)?>/y;

type TagBlock = { name: string; start: number; end: number; inner: string };

/** The tag block that opens exactly at `start`, through its matching close (same-name tags nest),
 * or null when there is no well-formed block there. */
function tagBlockAt(text: string, start: number): TagBlock | null {
  openTagAt.lastIndex = start;
  const open = openTagAt.exec(text);
  if (!open) return null;
  const name = open[1]!;
  const sameName = new RegExp(`<(/?)${name}(?:\\s[^<>]*)?>`, "g");
  sameName.lastIndex = openTagAt.lastIndex;
  let depth = 1;
  for (let match = sameName.exec(text); match; match = sameName.exec(text)) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return { name, start, end: sameName.lastIndex, inner: text.slice(openTagAt.lastIndex, match.index) };
  }
  return null;
}

/** The item as a run of top-level tag blocks separated only by whitespace, or null when any other
 * text sits between, before, or after them. */
function topLevelBlocks(item: string): TagBlock[] | null {
  const blocks: TagBlock[] = [];
  let position = 0;
  while (position < item.length) {
    const next = item.slice(position).search(/\S/);
    if (next < 0) break;
    const block = tagBlockAt(item, position + next);
    if (!block) return null;
    blocks.push(block);
    position = block.end;
  }
  return blocks;
}

/** An item with known harness blocks removed from its start and end, top level only. */
function withoutHarnessEdges(item: string) {
  let text = item.trim();
  for (;;) {
    const leading = tagBlockAt(text, 0);
    if (leading && harnessTags.has(leading.name)) { text = text.slice(leading.end).trim(); continue; }
    break;
  }
  for (;;) {
    const close = text.match(/<\/([A-Za-z_][\w-]*)>$/);
    if (!close || !harnessTags.has(close[1]!)) break;
    const open = text.lastIndexOf(`<${close[1]}`);
    const block = open >= 0 ? tagBlockAt(text, open) : null;
    if (!block || block.end !== text.length) break;
    text = text.slice(0, open).trim();
  }
  return text;
}

/**
 * The user's own request out of one input step's items. Each item is read by its top-level
 * structure, never by searching inside it, so a tag nested in injected context or quoted in a
 * question is never mistaken for the request:
 *
 * - An item made only of tag blocks that include `<user_request>` is a wrapped turn: those blocks
 *   are the request, and every other block is injected context and is dropped.
 * - An item made only of other tag blocks is injected context and is dropped when every block is
 *   a known harness tag, or when the turn has more than one item.
 * - Any other item is the user's text, kept verbatim after known harness blocks are removed from
 *   its start and end, so a question that is itself markup stays as written.
 */
export function promptFromItems(items: string[]) {
  const parts: string[] = [];
  for (const raw of items) {
    const item = raw.trim();
    if (!item) continue;
    const blocks = topLevelBlocks(item);
    if (blocks?.some((block) => block.name === userRequestTag)) {
      for (const block of blocks) if (block.name === userRequestTag) parts.push(block.inner.trim());
      continue;
    }
    // Injected context: an item made only of tag blocks, when every block is a known harness tag
    // or the turn was sent as more than one item (the request then travels in its own item).
    if (blocks?.length && (blocks.every((block) => harnessTags.has(block.name)) || items.length > 1)) continue;
    parts.push(withoutHarnessEdges(item));
  }
  return parts.filter(Boolean).join("\n").trim();
}

function promptOf(payload: Uint8Array) {
  const top = messageOf(payload);
  const input = top ? bytesOf(top, 19) : null;
  const fields = input ? messageOf(input) : null;
  if (!fields) return null;
  const items: string[] = [];
  for (const item of fieldsOf(fields, 3)) {
    const itemFields = messageOf(item);
    const text = itemFields ? textOf(itemFields, 1) : null;
    if (text !== null) items.push(text);
  }
  return promptFromItems(items);
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}

type ToolCallArgs = { name: string; args: string | null };
type ModelTurn = { reply: string | null; calls: ToolCallArgs[] };

const toolNamePattern = /^[A-Za-z0-9_.:-]{1,128}$/;

function modelTurnOf(payload: Uint8Array): ModelTurn | null {
  const top = messageOf(payload);
  const turn = top ? bytesOf(top, 20) : null;
  const fields = turn ? messageOf(turn) : null;
  if (!fields) return null;
  // The reply is trusted only while its mirror is present and agrees (every surveyed reply has
  // one), so a renumbering that moved other text (the thinking) into field 1 yields no reply
  // rather than the wrong one.
  const reply = bytesOf(fields, 1);
  const mirror = fieldOf(fields, 8);
  const corroborated = reply !== null && mirror?.kind === "bytes" && sameBytes(reply, mirror.value);
  const calls: ToolCallArgs[] = [];
  for (const call of fieldsOf(fields, 7)) {
    const callFields = messageOf(call);
    const name = callFields ? textOf(callFields, 2) : null;
    if (!name || !toolNamePattern.test(name)) continue;
    calls.push({ name, args: textOf(callFields!, 3) });
  }
  return { reply: corroborated ? decodeText(reply) : null, calls };
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function lines(value: string) {
  if (value === "") return [];
  const split = value.split(/\r?\n/);
  if (split.at(-1) === "") split.pop();
  return split;
}

/** Lines in a written file: none for an empty one, and a trailing newline ends the last line. */
export function lineCount(value: string) {
  return lines(value).length;
}

const maxLcsCells = 250_000;

function lcsLength(left: string[], right: string[]) {
  let previous = new Uint32Array(right.length + 1);
  let current = new Uint32Array(right.length + 1);
  for (let row = 1; row <= left.length; row++) {
    for (let column = 1; column <= right.length; column++) {
      current[column] = left[row - 1] === right[column - 1]
        ? previous[column - 1]! + 1
        : Math.max(previous[column]!, current[column - 1]!);
    }
    [previous, current] = [current, previous];
  }
  return previous[right.length]!;
}

/** Line counts for one `edit_file` call: the lines the target and its replacement share at the
 * start and end are unchanged, and the rest is compared line by line (bounded; a core too large
 * to compare counts every core line). The call is counted once, whether it matched one occurrence,
 * several, or failed: tool results are never read. */
export function editLineCounts(target: string, replacement: string) {
  const before = lines(target);
  const after = lines(replacement);
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  const removed = before.slice(start, endBefore);
  const added = after.slice(start, endAfter);
  if (!removed.length || !added.length || removed.length * added.length > maxLcsCells) {
    return { additions: added.length, deletions: removed.length };
  }
  const kept = lcsLength(removed, added);
  return { additions: added.length - kept, deletions: removed.length - kept };
}

const maxPathCharacters = 4_096;

function pathOf(value: unknown) {
  if (typeof value !== "string" || !value || value.length > maxPathCharacters || value.includes("\0")) return null;
  if (!value.startsWith("file://")) return value;
  try { return fileURLToPath(value); } catch { return null; }
}

type LedgerEntry = FileChange & { countsUnknown: boolean };

/** Antigravity's tools record full paths, so files are keyed by the exact normalized path: two
 * files that share a name stay two rows, and each lookup is constant time. Once any change to a
 * path has unknown counts (an overwrite), that file's counts stay unknown. */
function recordFileChange(files: Map<string, LedgerEntry>, path: string, status: FileStatus, delta?: { additions: number; deletions: number }) {
  const key = normalize(path.replaceAll("\\", "/"));
  const existing = files.get(key);
  const countsUnknown = (existing?.countsUnknown ?? false) || delta === undefined;
  files.set(key, {
    path: existing?.path ?? path,
    status: fileStatus(existing?.status, status),
    countsUnknown,
    additions: countsUnknown ? null : (existing?.additions ?? 0) + delta!.additions,
    deletions: countsUnknown ? null : (existing?.deletions ?? 0) + delta!.deletions,
  });
}

/** Only `edit_file` and `write_file` change files. Reads, commands, and every other tool record
 * none, and nothing is read from disk. */
function applyFileChange(call: ToolCallArgs, files: Map<string, LedgerEntry>, counts: { additions: number; deletions: number }) {
  if ((call.name !== "edit_file" && call.name !== "write_file") || call.args === null) return;
  let args: unknown;
  try { args = JSON.parse(call.args); } catch { return; }
  if (!record(args)) return;
  const path = pathOf(args.Path);
  if (!path) return;
  if (call.name === "edit_file") {
    if (typeof args.Target !== "string" || typeof args.Replacement !== "string") return;
    const delta = editLineCounts(args.Target, args.Replacement);
    counts.additions += delta.additions;
    counts.deletions += delta.deletions;
    recordFileChange(files, path, "modified", delta);
    return;
  }
  if (typeof args.Content !== "string") return;
  if (args.Overwrite === true) {
    const key = normalize(path.replaceAll("\\", "/"));
    const existing = files.get(key);
    // A file this session created and has known counts for is still new: its lines are now the
    // overwrite's. Any other overwrite replaced content this reader never saw, so its counts are
    // unknown.
    if (existing?.status === "added" && !existing.countsUnknown) {
      const additions = lineCount(args.Content);
      counts.additions += additions;
      files.set(key, { ...existing, additions, deletions: 0 });
      return;
    }
    recordFileChange(files, path, "modified");
    return;
  }
  const additions = lineCount(args.Content);
  counts.additions += additions;
  recordFileChange(files, path, "added", { additions, deletions: 0 });
}

function timestampOf(metadata: unknown) {
  if (!(metadata instanceof Uint8Array)) return null;
  const fields = messageOf(metadata);
  const at = fields ? stepTimestampMs(fields, 1) : null;
  return at === null ? null : new Date(at).toISOString();
}

/** Decodes user-input and model-turn rows into a detail. Null when the conversation is past the
 * step or byte budget. A row that does not decode is skipped. */
export function decodeAntigravitySteps(rows: Iterable<StepRow>): SessionDetail | null {
  const prompts: SessionDetail["prompts"] = [];
  const outputs: SessionDetail["outputs"] = [];
  const seenPrompts = new Set<string>();
  const seenOutputs = new Set<string>();
  const tools = new Map<string, number>();
  const files = new Map<string, LedgerEntry>();
  const counts = { additions: 0, deletions: 0 };
  let steps = 0;
  let payloadBytes = 0;
  let eventsRead = 0;
  for (const row of rows) {
    if (++steps > MAX_DETAIL_STEPS) return null;
    const payload = row.step_payload;
    payloadBytes += (payload instanceof Uint8Array ? payload.length : 0) + (row.metadata instanceof Uint8Array ? row.metadata.length : 0);
    if (payloadBytes > MAX_DETAIL_PAYLOAD_BYTES) return null;
    // An oversized payload comes back as null from SQL; a non-blob value is not a payload.
    if (!(payload instanceof Uint8Array)) continue;
    const stepType = Number(row.step_type);
    if (stepType === USER_INPUT_STEP) {
      const prompt = promptOf(payload);
      if (prompt === null) continue;
      eventsRead++;
      if (prompt && !seenPrompts.has(prompt)) {
        seenPrompts.add(prompt);
        prompts.push({ text: prompt.slice(0, detailPromptCharacters), timestamp: timestampOf(row.metadata) });
      }
    } else if (stepType === MODEL_TURN_STEP) {
      const turn = modelTurnOf(payload);
      if (!turn) continue;
      eventsRead++;
      const reply = turn.reply?.trim();
      if (reply && !seenOutputs.has(reply)) {
        seenOutputs.add(reply);
        outputs.push({
          text: reply.slice(0, detailOutputSampleCharacters),
          timestamp: timestampOf(row.metadata),
          truncated: reply.length > detailOutputSampleCharacters,
        });
      }
      for (const call of turn.calls) {
        tools.set(call.name, (tools.get(call.name) ?? 0) + 1);
        applyFileChange(call, files, counts);
      }
    }
  }
  return {
    available: true,
    prompts: prompts.slice(-detailPromptCount),
    outputs: outputs.slice(-detailOutputSampleCount),
    tools: [...tools.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    files: [...files.values()].map(({ countsUnknown: _unknown, ...file }) => file).sort((a, b) => a.path.localeCompare(b.path)),
    additions: counts.additions,
    deletions: counts.deletions,
    eventsRead,
  };
}

const requiredColumns = ["idx", "step_type", "metadata", "step_payload"];

function readSteps(database: Database) {
  const tables = database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'steps'").all();
  if (!tables.length) return null;
  const columns = new Set((database.query("PRAGMA table_info(steps)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!requiredColumns.every((column) => columns.has(column))) return null;
  return decodeAntigravitySteps(database.query(ANTIGRAVITY_DETAIL_SQL).iterate(MAX_STEP_METADATA_BYTES, MAX_STEP_PAYLOAD_BYTES) as Iterable<StepRow>);
}

/** One conversation's detail, or null when it cannot be read safely right now (missing, a log
 * without its index, changed twice while read, past a budget, or not the expected schema). */
export function readAntigravityDetail(sourceFile: string, read: typeof readProviderDatabase = readProviderDatabase): SessionDetail | null {
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = read(sourceFile, readSteps);
      if (result.ok) return result.value;
      if (result.reason !== DATABASE_CHANGED_WHILE_READ) return null;
    }
  } catch { /* fails closed */ }
  return null;
}
