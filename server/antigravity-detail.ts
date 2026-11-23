import type { Database } from "bun:sqlite";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DATABASE_CHANGED_WHILE_READ,
  antigravityFileSignature,
  antigravityRoots,
  antigravitySessionDatabase,
  readProviderDatabase,
  stepTimestampMs,
} from "./antigravity";
import { upsertFile, type FileChange } from "./file-changes";
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
export const ANTIGRAVITY_DETAIL_SQL = "SELECT idx, step_type, metadata, CASE WHEN length(step_payload) <= ? THEN step_payload END AS step_payload FROM steps WHERE step_type IN (14, 15) ORDER BY idx";

export const MAX_STEP_PAYLOAD_BYTES = 8_000_000;
/** Above this many user-input and model-turn steps the conversation is not read at all. */
export const MAX_DETAIL_STEPS = 20_000;
/** Every payload decoded for one detail together; past it the detail is unavailable rather than
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
export function antigravityDetailSignature(sourceFile: string) {
  return antigravityFileSignature(sourceFile);
}

type StepRow = { idx: number; step_type: number | null; metadata: unknown; step_payload: unknown };

const harnessTags = new Set(["runtime_info", "environment_context", "user_instructions"]);
const wholeTagBlock = /^<([A-Za-z_][\w-]*)>[\s\S]*<\/\1>$/;
const userRequestOpen = "<user_request>";
const userRequestClose = "</user_request>";

/**
 * The user's own request out of one input step's items. An item that wraps the request in
 * `<user_request>` gives the text between the first opening and the last closing tag. An item
 * that is one whole tag block is injected context and is dropped: always for a known harness tag,
 * and for any tag when the turn was sent as more than one item. Plain items are kept verbatim.
 */
export function promptFromItems(items: string[]) {
  const present = items.map((item) => item.trim()).filter(Boolean);
  const parts: string[] = [];
  for (const item of present) {
    const open = item.indexOf(userRequestOpen);
    const close = item.lastIndexOf(userRequestClose);
    if (open >= 0 && close > open) {
      parts.push(item.slice(open + userRequestOpen.length, close).trim());
      continue;
    }
    const block = item.match(wholeTagBlock);
    if (block && (harnessTags.has(block[1]!) || present.length > 1)) continue;
    parts.push(item);
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
  // The reply is trusted only while its mirror agrees, so a renumbering that moved other text
  // (the thinking) into field 1 yields no reply rather than the wrong one.
  const reply = bytesOf(fields, 1);
  const mirror = fieldOf(fields, 8);
  const corroborated = reply !== null && (mirror === undefined || (mirror.kind === "bytes" && sameBytes(reply, mirror.value)));
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

/** Only `edit_file` and `write_file` change files. Reads, commands, and every other tool record
 * none, and nothing is read from disk. */
function applyFileChange(call: ToolCallArgs, files: Map<string, FileChange>, counts: { additions: number; deletions: number }) {
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
    upsertFile(files, path, "modified", delta);
    return;
  }
  if (typeof args.Content !== "string") return;
  // An overwrite replaced content this reader never saw, so its counts are unknown.
  if (args.Overwrite === true) {
    upsertFile(files, path, "modified");
    return;
  }
  const additions = lineCount(args.Content);
  counts.additions += additions;
  upsertFile(files, path, "added", { additions, deletions: 0 });
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
  const files = new Map<string, FileChange>();
  const counts = { additions: 0, deletions: 0 };
  let steps = 0;
  let payloadBytes = 0;
  let eventsRead = 0;
  for (const row of rows) {
    if (++steps > MAX_DETAIL_STEPS) return null;
    const payload = row.step_payload;
    // An oversized payload comes back as null from SQL; a non-blob value is not a payload.
    if (!(payload instanceof Uint8Array)) continue;
    payloadBytes += payload.length;
    if (payloadBytes > MAX_DETAIL_PAYLOAD_BYTES) return null;
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
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
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
  return decodeAntigravitySteps(database.query(ANTIGRAVITY_DETAIL_SQL).iterate(MAX_STEP_PAYLOAD_BYTES) as Iterable<StepRow>);
}

/** One conversation's detail, or null when it cannot be read safely right now (missing, a log
 * without its index, changed twice while read, past a budget, or not the expected schema). */
export function readAntigravityDetail(sourceFile: string): SessionDetail | null {
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const read = readProviderDatabase(sourceFile, readSteps);
      if (read.ok) return read.value;
      if (read.reason !== DATABASE_CHANGED_WHILE_READ) return null;
    }
  } catch { /* fails closed */ }
  return null;
}
