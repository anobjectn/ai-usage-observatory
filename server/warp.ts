import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { dateKeyInTimeZone, systemTimeZone } from "../src/reporting-time";
import type { ModelBreakdown, Session, WarpData, WarpSessionStats } from "../src/types";

const defaultDatabasePath = join(
  homedir(),
  "Library/Group Containers/2BBY89MBSN.dev.warp/Library/Application Support/dev.warp.Warp-Stable/warp.sqlite",
);

/** The one place the Warp database is located, so the collector and the on-demand
 * prompt reader always open the same file (including under `WARP_DB_PATH`). */
export function warpDatabasePath() {
  return process.env.WARP_DB_PATH || defaultDatabasePath;
}
const requiredTables = ["agent_conversations", "agent_tasks", "ai_queries", "blocks"];

type JsonRecord = Record<string, unknown>;
type QueryRow = {
  conversation_id: string | null;
  start_ts: string | null;
  working_directory: string | null;
  output_status: string | null;
  model_id: string | null;
};
type ConversationRow = {
  conversation_id: string | null;
  last_modified_at: string | null;
  conversation_data: string | null;
};
type ConversationQueryStats = {
  turns: number;
  firstActivity: string | null;
  lastActivity: string | null;
  cwd: string | null;
  models: string[];
  completed: number;
  cancelled: number;
  pending: number;
  failed: number;
};
type BlockStats = {
  blockCount: number;
  failedCommands: number;
  cwd: string | null;
};

export type WarpCollection = WarpData & { sessions: Session[] };

function emptyData(sourceFile: string | null, error?: string): WarpCollection {
  return {
    available: false,
    sourceFile,
    observedAt: new Date().toISOString(),
    sessionCount: 0,
    queryCount: 0,
    linkedQueryCount: 0,
    queryCoverage: 0,
    totals: { sessions: 0, credits: 0, tokens: 0 },
    daily: [],
    schema: { required: requiredTables, missing: [] },
    ...(error ? { error } : {}),
    sessions: [],
  };
}

function record(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberValue(value: unknown, fallback = 0) {
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function optionalNumber(value: unknown) {
  const result = numberValue(value, Number.NaN);
  return Number.isFinite(result) ? result : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Warp's SQLite timestamps are local wall-clock strings. Converting them here keeps the
 * browser's existing date formatting and calendar grouping correct for the current machine. */
export function warpTimestamp(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value.trim().replace(" ", "T"));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function statusOf(row: QueryRow) {
  const value = jsonValue(row.output_status);
  if (record(value) && "Failed" in value) return "failed";
  const status = typeof value === "string" ? value.toLowerCase() : "";
  if (status.includes("fail")) return "failed";
  if (status.includes("cancel")) return "cancelled";
  if (status.includes("pending")) return "pending";
  return "completed";
}

function queryStats(rows: QueryRow[]) {
  const byConversation = new Map<string, ConversationQueryStats>();
  for (const row of rows) {
    const conversationId = stringValue(row.conversation_id);
    if (!conversationId) continue;
    const current = byConversation.get(conversationId) ?? {
      turns: 0,
      firstActivity: null,
      lastActivity: null,
      cwd: null,
      models: [],
      completed: 0,
      cancelled: 0,
      pending: 0,
      failed: 0,
    };
    current.turns += 1;
    current.cwd ??= stringValue(row.working_directory);
    const activity = warpTimestamp(row.start_ts);
    if (activity && (!current.firstActivity || activity < current.firstActivity)) current.firstActivity = activity;
    if (activity && (!current.lastActivity || activity > current.lastActivity)) current.lastActivity = activity;
    const model = stringValue(row.model_id);
    if (model && !current.models.includes(model)) current.models.push(model);
    const status = statusOf(row);
    current[status] += 1;
    byConversation.set(conversationId, current);
  }
  return byConversation;
}

function toolStats(metadata: unknown) {
  const toolUsage: Record<string, number> = {};
  let filesChanged = 0;
  let linesAdded = 0;
  let linesRemoved = 0;
  let commandsExecuted = 0;
  if (!record(metadata)) return { toolUsage, filesChanged, linesAdded, linesRemoved, commandsExecuted };
  for (const [key, value] of Object.entries(metadata)) {
    if (!record(value)) continue;
    const count = optionalNumber(value.count);
    if (count !== null) toolUsage[key] = count;
    if (key === "run_command_stats") commandsExecuted += numberValue(value.commands_executed, count ?? 0);
    if (key === "apply_file_diff_stats") {
      filesChanged += numberValue(value.files_changed);
      linesAdded += numberValue(value.lines_added);
      linesRemoved += numberValue(value.lines_removed);
    }
  }
  return { toolUsage, filesChanged, linesAdded, linesRemoved, commandsExecuted };
}

function tokenStats(metadata: unknown) {
  const byModel = new Map<string, { total: number; warp: number; byok: number; customEndpoint: number }>();
  const tokensByCategory: Record<string, number> = {};
  let total = 0;
  let warp = 0;
  let byok = 0;
  let customEndpoint = 0;
  if (!record(metadata) || !Array.isArray(metadata.token_usage)) {
    return { byModel, tokensByCategory, total, warp, byok, customEndpoint };
  }
  for (const entry of metadata.token_usage) {
    if (!record(entry)) continue;
    const entryWarp = numberValue(entry.warp_tokens);
    const entryByok = numberValue(entry.byok_tokens);
    const entryCustom = numberValue(entry.custom_endpoint_tokens);
    const entryTotal = numberValue(entry.total_tokens, entryWarp + entryByok + entryCustom);
    total += entryTotal;
    warp += entryWarp;
    byok += entryByok;
    customEndpoint += entryCustom;
    const model = stringValue(entry.model_id) ?? "Unknown model";
    const current = byModel.get(model) ?? { total: 0, warp: 0, byok: 0, customEndpoint: 0 };
    current.total += entryTotal;
    current.warp += entryWarp;
    current.byok += entryByok;
    current.customEndpoint += entryCustom;
    byModel.set(model, current);
    for (const source of ["warp", "byok", "custom_endpoint"] as const) {
      const categories = entry[`${source}_token_usage_by_category`];
      if (!record(categories)) continue;
      for (const [category, amount] of Object.entries(categories)) {
        const numeric = optionalNumber(amount);
        if (numeric !== null) tokensByCategory[category] = (tokensByCategory[category] ?? 0) + numeric;
      }
    }
  }
  return { byModel, tokensByCategory, total, warp, byok, customEndpoint };
}

function conversationStatus(stats: ConversationQueryStats) {
  if (stats.failed > 0) return "failed";
  if (stats.pending > 0 && stats.completed === 0 && stats.cancelled === 0) return "pending";
  if (stats.cancelled > 0 && stats.completed === 0) return "cancelled";
  return "completed";
}

function blockStats(db: Database, tables: Set<string>) {
  const result = new Map<string, BlockStats>();
  if (!tables.has("blocks")) return result;
  const rows = db.query("SELECT ai_metadata, pwd, exit_code, did_execute FROM blocks WHERE ai_metadata IS NOT NULL").all() as Array<{ ai_metadata: string | null; pwd: string | null; exit_code: number | string | null; did_execute: number | boolean | null }>;
  for (const row of rows) {
    const metadata = jsonValue(row.ai_metadata);
    if (!record(metadata)) continue;
    const conversationId = stringValue(metadata.conversation_id);
    if (!conversationId) continue;
    const current = result.get(conversationId) ?? { blockCount: 0, failedCommands: 0, cwd: null };
    current.blockCount += 1;
    current.cwd ??= stringValue(row.pwd);
    if (Boolean(row.did_execute) && optionalNumber(row.exit_code) !== null && numberValue(row.exit_code) !== 0) current.failedCommands += 1;
    result.set(conversationId, current);
  }
  return result;
}

function taskCounts(db: Database, tables: Set<string>) {
  const result = new Map<string, number>();
  if (!tables.has("agent_tasks")) return result;
  const rows = db.query("SELECT conversation_id FROM agent_tasks WHERE conversation_id IS NOT NULL").all() as Array<{ conversation_id: string | null }>;
  for (const row of rows) {
    const conversationId = stringValue(row.conversation_id);
    if (conversationId) result.set(conversationId, (result.get(conversationId) ?? 0) + 1);
  }
  return result;
}

function sessionFromConversation(
  row: ConversationRow,
  queries: ConversationQueryStats,
  blocks: BlockStats | undefined,
  tasks: number,
): Session | null {
  const conversationId = stringValue(row.conversation_id);
  if (!conversationId) return null;
  const data = jsonValue(row.conversation_data);
  const usage = record(data) ? data.conversation_usage_metadata : null;
  const token = tokenStats(usage);
  const tools = toolStats(record(usage) ? usage.tool_usage_metadata : null);
  const lastActivity = warpTimestamp(row.last_modified_at) ?? queries.lastActivity ?? queries.firstActivity;
  const models = [...token.byModel.keys()];
  for (const model of queries.models) if (!models.includes(model)) models.push(model);
  const modelBreakdowns: ModelBreakdown[] = models.map((modelName) => {
    const values = token.byModel.get(modelName);
    return {
      modelName,
      // Warp exposes a recorded token total, not the input/output/cache split used by ccusage.
      // Keep it in the neutral input slot so existing token aggregation remains complete; the
      // Warp-specific panel labels this value as recorded tokens.
      inputTokens: values?.total ?? 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cost: 0,
    };
  });
  const stats: WarpSessionStats = {
    conversationId,
    credits: numberValue(record(usage) ? usage.credits_spent : 0),
    lastTurnCredits: optionalNumber(record(usage) ? usage.credits_spent_for_last_block : null),
    contextWindowUsage: optionalNumber(record(usage) ? usage.context_window_usage : null),
    wasSummarized: Boolean(record(usage) ? usage.was_summarized : false),
    status: conversationStatus(queries),
    turns: queries.turns,
    tasks,
    blockCount: blocks?.blockCount ?? 0,
    failedCommands: blocks?.failedCommands ?? 0,
    filesChanged: tools.filesChanged,
    linesAdded: tools.linesAdded,
    linesRemoved: tools.linesRemoved,
    commandsExecuted: tools.commandsExecuted,
    toolUsage: tools.toolUsage,
    tokensBySource: { total: token.total, warp: token.warp, byok: token.byok, customEndpoint: token.customEndpoint },
    tokensByCategory: token.tokensByCategory,
  };
  const sourceDate = lastActivity ?? new Date().toISOString();
  return {
    agent: "warp",
    source: "warp",
    sessionId: `warp-${conversationId}`,
    period: sourceDate,
    cwd: queries.cwd ?? blocks?.cwd ?? null,
    pathTags: [],
    annotation: { tags: [], note: "", verdict: null },
    inputTokens: token.total,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: token.total,
    totalCost: 0,
    modelsUsed: models,
    modelBreakdowns,
    metadata: { lastActivity: sourceDate },
    warp: stats,
  };
}

function summaryOf(collection: WarpCollection, timeZone: string): WarpCollection {
  const days = new Map<string, { sessions: number; credits: number; tokens: number }>();
  for (const session of collection.sessions) {
    const date = dateKeyInTimeZone(session.metadata?.lastActivity, timeZone);
    if (!date || !session.warp) continue;
    const current = days.get(date) ?? { sessions: 0, credits: 0, tokens: 0 };
    current.sessions += 1;
    current.credits += session.warp.credits;
    current.tokens += session.totalTokens;
    days.set(date, current);
  }
  collection.daily = [...days.entries()]
    .map(([date, values]) => ({ date, ...values }))
    .sort((left, right) => left.date.localeCompare(right.date));
  collection.sessionCount = collection.sessions.length;
  collection.totals = {
    sessions: collection.sessions.length,
    credits: collection.sessions.reduce((sum, session) => sum + (session.warp?.credits ?? 0), 0),
    tokens: collection.sessions.reduce((sum, session) => sum + session.totalTokens, 0),
  };
  return collection;
}

export async function collectWarp(timeZone = systemTimeZone()): Promise<WarpCollection> {
  const databasePath = warpDatabasePath();
  const sourceFile = relative(homedir(), databasePath) || databasePath;
  if (!existsSync(databasePath)) return emptyData(sourceFile, "Warp's local session database was not found on this machine.");
  try {
    const database = new Database(databasePath, { readonly: true });
    try {
      const tableRows = database.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
      const tables = new Set(tableRows.map((row) => row.name));
      const missing = requiredTables.filter((table) => !tables.has(table));
      if (!tables.has("agent_conversations") || !tables.has("ai_queries")) {
        const result = emptyData(sourceFile, `Warp database schema is missing ${missing.join(", ") || "required tables"}.`);
        result.schema.missing = missing;
        return result;
      }
      const queries = database.query("SELECT conversation_id, start_ts, working_directory, output_status, model_id FROM ai_queries WHERE conversation_id IS NOT NULL").all() as QueryRow[];
      const queryByConversation = queryStats(queries);
      const conversations = database.query("SELECT conversation_id, last_modified_at, conversation_data FROM agent_conversations WHERE conversation_id IS NOT NULL AND conversation_data IS NOT NULL").all() as ConversationRow[];
      const latest = new Map<string, ConversationRow>();
      for (const row of conversations) {
        const id = stringValue(row.conversation_id);
        if (!id) continue;
        const current = latest.get(id);
        if (!current || String(row.last_modified_at ?? "") >= String(current.last_modified_at ?? "")) latest.set(id, row);
      }
      const blocks = blockStats(database, tables);
      const tasks = taskCounts(database, tables);
      const sessions = [...latest.values()]
        .map((row) => {
          const id = stringValue(row.conversation_id)!;
          const stats = queryByConversation.get(id) ?? { turns: 0, firstActivity: null, lastActivity: null, cwd: null, models: [], completed: 0, cancelled: 0, pending: 0, failed: 0 };
          return sessionFromConversation(row, stats, blocks.get(id), tasks.get(id) ?? 0);
        })
        .filter(Boolean) as Session[];
      const linkedQueryCount = queries.filter((row) => row.conversation_id && latest.has(row.conversation_id)).length;
      const modifiedAt = statSync(databasePath).mtime.toISOString();
      return summaryOf({
        available: true,
        sourceFile,
        observedAt: modifiedAt,
        sessionCount: 0,
        queryCount: queries.length,
        linkedQueryCount,
        queryCoverage: queries.length ? linkedQueryCount / queries.length : 1,
        totals: { sessions: 0, credits: 0, tokens: 0 },
        daily: [],
        schema: { required: requiredTables, missing },
        sessions,
      }, timeZone);
    } finally {
      database.close();
    }
  } catch (error) {
    return emptyData(sourceFile, error instanceof Error ? `Warp database could not be read: ${error.message}` : `Warp database could not be read: ${String(error)}`);
  }
}
