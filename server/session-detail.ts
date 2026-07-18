import { getSessionSource } from "./path-indexer";

type JsonRecord = Record<string, unknown>;
type ToolCall = { name: string; count: number };
type FileChange = { path: string; status: "added" | "modified" | "deleted" };

export type SessionDetail = {
  available: boolean;
  prompts: string[];
  tools: ToolCall[];
  files: FileChange[];
  additions: number;
  deletions: number;
  eventsRead: number;
};

const detailUnavailable: SessionDetail = { available: false, prompts: [], tools: [], files: [], additions: 0, deletions: 0, eventsRead: 0 };

function record(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join("\n");
  if (!record(value)) return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.message === "string") return value.message;
  if (typeof value.content === "string") return value.content;
  return text(value.content ?? value.message);
}

function promptFrom(row: JsonRecord) {
  const payload = record(row.payload) ? row.payload : row;
  const type = String(payload.type ?? row.type ?? "");
  if (type !== "user" && type !== "user_message") return "";
  return text(payload.message ?? payload.content).trim();
}

function walk(value: unknown, visit: (item: JsonRecord) => void) {
  if (Array.isArray(value)) value.forEach((item) => walk(item, visit));
  else if (record(value)) {
    visit(value);
    Object.values(value).forEach((item) => walk(item, visit));
  }
}

function patchSummary(value: string, files: Map<string, FileChange>, counts: { additions: number; deletions: number }) {
  const lines = value.split("\n");
  for (const line of lines) {
    const custom = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (custom) {
      const status = custom[1] === "Add" ? "added" : custom[1] === "Delete" ? "deleted" : "modified";
      files.set(custom[2], { path: custom[2], status });
    }
    const unified = line.match(/^\+\+\+ b\/(.+)$/) ?? line.match(/^--- a\/(.+)$/);
    if (unified && unified[1] !== "/dev/null") files.set(unified[1], { path: unified[1], status: "modified" });
    if (line.startsWith("+") && !line.startsWith("+++")) counts.additions++;
    if (line.startsWith("-") && !line.startsWith("---")) counts.deletions++;
  }
}

function toolName(item: JsonRecord) {
  const type = String(item.type ?? "");
  if (type !== "tool_use" && type !== "function_call" && type !== "custom_tool_call") return null;
  const nested = record(item.function) ? item.function : null;
  const name = item.name ?? nested?.name;
  return typeof name === "string" ? name : null;
}

function structuredChanges(item: JsonRecord, files: Map<string, FileChange>) {
  if (!record(item.changes)) return;
  for (const [path, change] of Object.entries(item.changes)) {
    if (!record(change)) continue;
    const type = change.type;
    const status = type === "add" ? "added" : type === "delete" ? "deleted" : type === "update" ? "modified" : null;
    if (status) files.set(path, { path, status });
  }
}

export async function getSessionDetail(sessionId: string): Promise<SessionDetail> {
  const source = getSessionSource(sessionId);
  if (!source || !await Bun.file(source.sourceFile).exists()) return detailUnavailable;

  const raw = await Bun.file(source.sourceFile).slice(0, 12_000_000).text();
  const prompts: string[] = [];
  const tools = new Map<string, number>();
  const files = new Map<string, FileChange>();
  const counts = { additions: 0, deletions: 0 };
  let eventsRead = 0;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as JsonRecord;
      eventsRead++;
      const prompt = promptFrom(row);
      if (prompt && !prompts.includes(prompt)) prompts.push(prompt.slice(0, 2_000));
      walk(row, (item) => {
        const name = toolName(item);
        if (name) tools.set(name, (tools.get(name) ?? 0) + 1);
        structuredChanges(item, files);
        for (const value of Object.values(item)) if (typeof value === "string" && (value.includes("*** Update File:") || value.includes("+++ b/") || value.includes("*** Add File:"))) patchSummary(value, files, counts);
      });
    } catch { /* incomplete JSONL lines are normal while a session is active */ }
  }
  return {
    available: true,
    prompts: prompts.slice(-8).reverse(),
    tools: [...tools.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    additions: counts.additions,
    deletions: counts.deletions,
    eventsRead,
  };
}
