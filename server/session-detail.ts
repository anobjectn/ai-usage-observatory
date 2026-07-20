import { getSessionSource } from "./path-indexer";
import { stat } from "node:fs/promises";

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
const detailCache = new Map<string, { mtimeMs: number; detail: Promise<SessionDetail> }>();

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

function contentItemsText(content: unknown, textTypes: string[]) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is JsonRecord => record(item) && textTypes.includes(String(item.type)) && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
}

const syntheticPromptWrappers = [/^<environment_context>/, /^<user_instructions>/];

function promptFrom(row: JsonRecord) {
  const payload = record(row.payload) ? row.payload : row;
  const type = String(payload.type ?? row.type ?? "");
  let prompt = "";
  if (type === "user" && record(row.message)) {
    // Claude Code stuffs tool_result payloads into "user" rows too; only "text" items are real prompts.
    prompt = contentItemsText(row.message.content, ["text"]);
  } else if (type === "user_message") {
    prompt = text(payload.message ?? payload.content);
  } else if (type === "message" && payload.role === "user") {
    prompt = contentItemsText(payload.content, ["input_text", "text"]);
  }
  prompt = prompt.trim();
  return syntheticPromptWrappers.some((wrapper) => wrapper.test(prompt)) ? "" : prompt;
}

function walk(value: unknown, visit: (item: JsonRecord) => void) {
  if (Array.isArray(value)) value.forEach((item) => walk(item, visit));
  else if (record(value)) {
    visit(value);
    Object.values(value).forEach((item) => walk(item, visit));
  }
}

const beginPatchMarker = "*** Begin Patch";
const endPatchMarker = "*** End Patch";

// Some Codex tool-calling variants ("apply_patch" directly, or a generic "exec" that runs JS
// source calling `tools.apply_patch(patch)`) don't line-break the patch text itself: the source
// carries it as a JS string literal with escaped "\n"s instead of real newlines. Only unescape
// when the extracted span has no real newline of its own, so a genuine multi-line patch (which
// already has real line breaks) is never touched.
function unescapeJsStringLiteral(value: string) {
  return value.replace(/\\(n|"|\\)/g, (_, escaped: string) => (escaped === "n" ? "\n" : escaped));
}

// Codex's apply_patch carries its own custom patch format (not unified diff) in a single string
// argument. This only runs on the bounded Begin/End Patch span of a tool call's own argument,
// never on arbitrary transcript strings, so a `git diff` a model prints to the user inside a
// shell result can't be mistaken for a real edit.
function applyPatchSummary(value: string, files: Map<string, FileChange>, counts: { additions: number; deletions: number }) {
  const begin = value.indexOf(beginPatchMarker);
  const end = value.indexOf(endPatchMarker, begin);
  if (begin < 0 || end < 0) return;
  const span = value.slice(begin, end + endPatchMarker.length);
  const body = span.includes("\n") ? span : unescapeJsStringLiteral(span);
  for (const line of body.split("\n")) {
    const custom = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (custom) {
      const status = custom[1] === "Add" ? "added" : custom[1] === "Delete" ? "deleted" : "modified";
      files.set(custom[2], { path: custom[2], status });
      continue;
    }
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

function codexApplyPatch(item: JsonRecord, files: Map<string, FileChange>, counts: { additions: number; deletions: number }) {
  if (toolName(item) === null) return;
  const nested = record(item.function) ? item.function : null;
  const input = typeof item.input === "string" ? item.input : typeof nested?.arguments === "string" ? nested.arguments : null;
  if (input && input.includes(beginPatchMarker)) applyPatchSummary(input, files, counts);
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

// Claude Code's Edit/Write tool results (toolUseResult) are visited directly by walk(); they sit
// alongside the tool_use call rather than inside it, so this checks the shape rather than a name.
function claudeEditPatch(item: JsonRecord, files: Map<string, FileChange>, counts: { additions: number; deletions: number }) {
  const filePath = item.filePath;
  if (typeof filePath !== "string") return;
  if (item.type === "create" && typeof item.content === "string") {
    counts.additions += item.content === "" ? 0 : item.content.split("\n").length;
    files.set(filePath, { path: filePath, status: "added" });
    return;
  }
  if (!Array.isArray(item.structuredPatch)) return;
  for (const hunk of item.structuredPatch) {
    if (!record(hunk) || !Array.isArray(hunk.lines)) continue;
    for (const line of hunk.lines) {
      if (typeof line !== "string") continue;
      if (line.startsWith("+")) counts.additions++;
      else if (line.startsWith("-")) counts.deletions++;
    }
  }
  const existing = files.get(filePath);
  files.set(filePath, { path: filePath, status: existing?.status === "added" ? "added" : "modified" });
}

async function readSessionDetail(sessionId: string): Promise<SessionDetail> {
  const source = getSessionSource(sessionId);
  if (!source || !await Bun.file(source.sourceFile).exists()) return detailUnavailable;

  const raw = await Bun.file(source.sourceFile).slice(0, 12_000_000).text();
  const prompts: string[] = [];
  const seenPrompts = new Set<string>();
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
      if (prompt && !seenPrompts.has(prompt)) { seenPrompts.add(prompt); prompts.push(prompt.slice(0, 2_000)); }
      walk(row, (item) => {
        const name = toolName(item);
        if (name) tools.set(name, (tools.get(name) ?? 0) + 1);
        codexApplyPatch(item, files, counts);
        structuredChanges(item, files);
        claudeEditPatch(item, files, counts);
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

export async function getSessionDetail(sessionId: string): Promise<SessionDetail> {
  const source = getSessionSource(sessionId);
  if (!source) return detailUnavailable;

  let mtimeMs: number;
  try {
    mtimeMs = (await stat(source.sourceFile)).mtimeMs;
  } catch {
    return detailUnavailable;
  }
  const cached = detailCache.get(sessionId);
  if (cached?.mtimeMs === mtimeMs) return cached.detail;

  const detail = readSessionDetail(sessionId);
  detailCache.set(sessionId, { mtimeMs, detail });
  void detail.catch(() => {
    if (detailCache.get(sessionId)?.detail === detail) detailCache.delete(sessionId);
  });
  return detail;
}
