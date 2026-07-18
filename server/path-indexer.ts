import { homedir } from "node:os";
import { basename, relative } from "node:path";
import { stat } from "node:fs/promises";
import { db, listRules } from "./store";

type IndexedPath = { sessionId: string; agent: string; nativeKey: string; cwd: string | null; sourceFile: string };

export function stableSessionId(agent: string, sourceRelativePath: string, nativeSessionKey: string) {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(`${agent}\0${sourceRelativePath}\0${nativeSessionKey}`);
  return hash.digest("hex").slice(0, 24);
}

export function sessionReportKeys(agent: string, nativeKey: string, sourceFile: string) {
  const keys = new Set([nativeKey, basename(sourceFile, ".jsonl")]);
  if (agent === "codex") {
    const normalized = sourceFile.replaceAll("\\", "/");
    const marker = "/.codex/sessions/";
    const markerIndex = normalized.indexOf(marker);
    if (markerIndex >= 0) keys.add(normalized.slice(markerIndex + marker.length).replace(/\.jsonl$/, ""));
  }
  return [...keys];
}

async function parseHead(file: string, agent: "claude" | "codex") {
  const text = await Bun.file(file).slice(0, 96_000).text();
  const lines = text.split("\n").slice(0, 80);
  let cwd: string | null = null;
  let nativeKey = basename(file, ".jsonl");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (agent === "codex") {
        const payload = row.type === "session_meta" ? row.payload : row;
        cwd ??= typeof payload?.cwd === "string" ? payload.cwd : null;
        nativeKey = typeof payload?.id === "string" ? payload.id : nativeKey;
      } else {
        cwd ??= typeof row.cwd === "string" ? row.cwd : null;
        nativeKey = typeof row.sessionId === "string" ? row.sessionId : nativeKey;
      }
      if (cwd) break;
    } catch { /* malformed or partial line */ }
  }
  return { cwd, nativeKey };
}

async function indexGlob(agent: "claude" | "codex", pattern: string) {
  const root = homedir();
  const glob = new Bun.Glob(pattern);
  const upsert = db.query(`INSERT INTO session_paths
    (session_id, agent, native_session_key, source_file, cwd, source_mtime, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(session_id) DO UPDATE SET cwd = excluded.cwd, source_mtime = excluded.source_mtime, indexed_at = CURRENT_TIMESTAMP`);
  let indexed = 0;
  for await (const sourceRelativePath of glob.scan({ cwd: root, absolute: false, onlyFiles: true, dot: true })) {
    const sourceFile = `${root}/${sourceRelativePath}`;
    const info = await stat(sourceFile);
    const existing = db.query("SELECT source_mtime FROM session_paths WHERE source_file = ?").get(sourceFile) as {source_mtime:number} | null;
    if (existing?.source_mtime === info.mtimeMs) continue;
    const { cwd, nativeKey } = await parseHead(sourceFile, agent);
    const sessionId = stableSessionId(agent, sourceRelativePath, nativeKey);
    upsert.run(sessionId, agent, nativeKey, sourceFile, cwd, info.mtimeMs);
    indexed++;
  }
  return indexed;
}

export async function indexSessionPaths() {
  const [claude, codex] = await Promise.all([
    indexGlob("claude", ".claude/projects/**/*.jsonl"),
    indexGlob("codex", ".codex/sessions/**/*.jsonl"),
  ]);
  return { indexed: claude + codex };
}

function globRegex(pattern: string) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

export function getPathIndex(): Record<string, IndexedPath & { tags: string[] }> {
  const rows = db.query("SELECT session_id, agent, native_session_key, cwd, source_file FROM session_paths").all() as Array<{session_id:string;agent:string;native_session_key:string;cwd:string|null;source_file:string}>;
  const rules = listRules();
  return Object.fromEntries(rows.flatMap((row) => {
    const tags = row.cwd ? rules.filter((rule) => {
      try { return (rule.kind === "regex" ? new RegExp(rule.pattern, "i") : globRegex(rule.pattern)).test(row.cwd!); }
      catch { return false; }
    }).map((rule) => rule.tag) : [];
    const value = { sessionId: row.session_id, agent: row.agent, nativeKey: row.native_session_key, cwd: row.cwd, sourceFile: relative(homedir(), row.source_file), tags };
    return sessionReportKeys(row.agent, row.native_session_key, row.source_file).map((key) => [`${row.agent}:${key}`, value]);
  }));
}

export function getSessionSource(sessionId: string) {
  const row = db.query("SELECT agent, source_file FROM session_paths WHERE session_id = ?").get(sessionId) as {agent:string;source_file:string} | null;
  return row ? { agent: row.agent, sourceFile: row.source_file } : null;
}
