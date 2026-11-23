import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bytesField, message, textField, varintField } from "./warp-fixture";

/**
 * Test-only builder for synthetic Antigravity data directories. Messages are encoded the way the
 * producer writes them (see `server/antigravity.ts` for the field map), and every content column
 * the collector must never read is filled, so a privacy test can plant a canary in each one.
 */

export type FixtureUsage = {
  modelEnum?: number;
  input?: number;
  output?: number;
  cacheWrite?: number;
  cacheRead?: number;
  /** Thinking share of output (f9); f10 is the rest. */
  thinking?: number;
  messageId?: string | null;
};

export function usageMessage(usage: FixtureUsage) {
  const output = usage.output ?? 0;
  const thinking = usage.thinking ?? 0;
  return message(
    varintField(1, usage.modelEnum ?? 1532),
    usage.input === undefined ? [] : varintField(2, usage.input),
    varintField(3, output),
    usage.cacheWrite === undefined ? [] : varintField(4, usage.cacheWrite),
    usage.cacheRead === undefined ? [] : varintField(5, usage.cacheRead),
    varintField(6, 24),
    usage.messageId === null ? [] : textField(7, usage.messageId ?? "message"),
    usage.thinking === undefined ? [] : varintField(9, thinking),
    usage.thinking === undefined ? [] : varintField(10, Math.max(0, output - thinking)),
  );
}

function timestamp(field: number, ms: number) {
  return bytesField(field, message(varintField(1, Math.floor(ms / 1000)), varintField(2, (ms % 1000) * 1_000_000)));
}

export function stepMetadata({ at, finishedAt, usage }: { at: number; finishedAt?: number; usage?: FixtureUsage }) {
  return new Uint8Array(message(
    timestamp(1, at),
    varintField(3, 1),
    finishedAt === undefined ? [] : timestamp(8, finishedAt),
    usage ? bytesField(9, usageMessage(usage)) : [],
  ));
}

export type FixtureGeneration = { usage: FixtureUsage; modelId: string; label: string; filler?: string };

export function generationData({ usage, modelId, label, filler = "" }: FixtureGeneration) {
  const keyValue = (key: string, value: string) => bytesField(20, message(textField(1, key), textField(2, value)));
  return new Uint8Array(message(
    bytesField(1, message(
      varintField(3, usage.modelEnum ?? 1532),
      bytesField(4, usageMessage(usage)),
      textField(19, modelId),
      keyValue("model_enum", "MODEL_PLACEHOLDER_M532"),
      keyValue("used_claude", "false"),
      textField(21, label),
    )),
    // Real rows embed the prompt in other top-level fields; this stands in for it.
    textField(8, filler),
  ));
}

export type FixtureStep = {
  idx: number;
  stepType?: number;
  at: number;
  finishedAt?: number;
  usage?: FixtureUsage;
  /** `steps.status`: 3 (finished, the default) or the in-progress value 8. */
  status?: number;
  /** Raw metadata bytes, for undecodable-step tests. */
  metadata?: Uint8Array | null;
  payload?: string;
};

export type FixtureConversation = {
  steps: FixtureStep[];
  generations?: Array<FixtureGeneration & { idx: number }>;
  /** Omit `steps` or `gen_metadata` columns to simulate schema drift. */
  withoutGenerations?: boolean;
  stepColumns?: string[];
};

export function conversationPath(root: string, conversationId: string) {
  return join(root, "conversations", `${conversationId}.db`);
}

/** Removes the sidecars Bun leaves behind on macOS, the state a writer leaves when it closes. */
export function removeSidecars(path: string) {
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
}

function fill(database: Database, conversation: FixtureConversation) {
  const columns = conversation.stepColumns ?? ["idx INTEGER", "step_type INTEGER", "status INTEGER", "metadata BLOB", "step_payload BLOB"];
  database.exec(`CREATE TABLE IF NOT EXISTS steps (${columns.join(", ")})`);
  database.exec("CREATE TABLE IF NOT EXISTS trajectory_meta (trajectory_id TEXT, cascade_id TEXT)");
  if (!conversation.withoutGenerations) database.exec("CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER, data BLOB, size INTEGER)");
  const names = columns.map((column) => column.split(" ")[0]!);
  const insertStep = database.query(`INSERT INTO steps (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`);
  for (const step of conversation.steps) {
    const metadata = step.metadata !== undefined ? step.metadata : stepMetadata(step);
    const values: Record<string, unknown> = {
      idx: step.idx, step_type: step.stepType ?? (step.usage ? 15 : 14), status: step.status ?? 3, metadata,
      step_payload: new TextEncoder().encode(step.payload ?? ""),
    };
    insertStep.run(...names.map((name) => values[name] as never));
  }
  if (conversation.withoutGenerations) return;
  const insertGeneration = database.query("INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)");
  for (const generation of conversation.generations ?? []) {
    const data = generationData(generation);
    insertGeneration.run(generation.idx, data, data.length);
  }
}

/** A conversation database as a closed writer leaves it: WAL mode, no sidecars. */
export function writeConversation(root: string, conversationId: string, conversation: FixtureConversation) {
  mkdirSync(join(root, "conversations"), { recursive: true });
  const path = conversationPath(root, conversationId);
  const database = new Database(path, { create: true });
  database.exec("PRAGMA journal_mode = WAL");
  fill(database, conversation);
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  database.close();
  removeSidecars(path);
  return path;
}

/** Appends to an existing conversation through a short-lived writer, then closes it cleanly. */
export function appendConversation(path: string, conversation: FixtureConversation) {
  const database = new Database(path);
  fill(database, conversation);
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  database.close();
  removeSidecars(path);
}

/** A writer that is still open, with its newest rows only in the `-wal`. Close it when done. */
export function openLiveWriter(path: string, conversation: FixtureConversation) {
  const database = new Database(path);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
  fill(database, conversation);
  return database;
}

/** A non-empty `-wal` with no `-shm` beside it: a log copied or restored without its index. */
export function writeOrphanWal(root: string, conversationId: string, base: FixtureConversation, inLog: FixtureConversation) {
  const path = writeConversation(root, conversationId, base);
  const scratch = join(root, `.scratch-${conversationId}.db`);
  copyFileSync(path, scratch);
  const writer = openLiveWriter(scratch, inLog);
  copyFileSync(`${scratch}-wal`, `${path}-wal`);
  writer.close();
  rmSync(scratch, { force: true });
  removeSidecars(scratch);
  return path;
}

/** The state a crashed or still-running writer can leave after a checkpoint: an empty `-wal`
 * beside a `-shm`. */
export function leaveEmptySidecars(path: string) {
  const database = new Database(path);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  database.close();
}

export type FixtureSummary = {
  conversationId: string;
  workspaceUris?: unknown;
  lastModified?: string;
  stepCount?: number;
  parentConversationId?: string;
  nestingDepth?: number;
  title?: string;
  preview?: string;
  rawSummary?: string;
};

export function writeSummaries(root: string, rows: FixtureSummary[], options: { columns?: string[] } = {}) {
  mkdirSync(root, { recursive: true });
  const path = join(root, "conversation_summaries.db");
  rmSync(path, { force: true });
  removeSidecars(path);
  const database = new Database(path, { create: true });
  database.exec("PRAGMA journal_mode = WAL");
  const columns = options.columns ?? [
    "conversation_id TEXT", "title TEXT", "preview TEXT", "step_count INTEGER", "last_modified_time datetime",
    "workspace_uris TEXT", "status TEXT", "parent_conversation_id TEXT", "nesting_depth INTEGER", "raw_summary BLOB",
  ];
  database.exec(`CREATE TABLE conversation_summaries (${columns.join(", ")})`);
  database.exec("CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(body)");
  const names = columns.map((column) => column.split(" ")[0]!);
  const insert = database.query(`INSERT INTO conversation_summaries (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`);
  const ftsInsert = database.query("INSERT INTO conversation_fts (body) VALUES (?)");
  for (const row of rows) {
    const values: Record<string, unknown> = {
      conversation_id: row.conversationId,
      title: row.title ?? "",
      preview: row.preview ?? "",
      step_count: row.stepCount ?? 1,
      last_modified_time: row.lastModified ?? "2026-11-21 20:28:41.836392+00:00",
      workspace_uris: typeof row.workspaceUris === "string" ? row.workspaceUris : JSON.stringify(row.workspaceUris ?? []),
      status: "CASCADE_RUN_STATUS_IDLE",
      parent_conversation_id: row.parentConversationId ?? "",
      nesting_depth: row.nestingDepth ?? 0,
      raw_summary: new TextEncoder().encode(row.rawSummary ?? ""),
    };
    insert.run(...names.map((name) => values[name] as never));
    ftsInsert.run(`${row.title ?? ""} ${row.preview ?? ""}`);
  }
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  database.close();
  removeSidecars(path);
  return path;
}

export function fileUri(path: string) {
  return pathToFileURL(path).href;
}
