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

// An early message can carry an inline attachment (a base64 screenshot, say) that runs
// hundreds of KB to a few MB on its own line. A tighter window would cut that line off
// mid-JSON and never reach the smaller lines after it — and since this always re-reads
// from byte zero, a session whose first real message is one of these stays unresolved
// (blank cwd) for as long as it exists, not just until the next scan.
const headScanBytes = 4_000_000;

export async function parseHead(file: string, agent: "claude" | "codex") {
  const text = await Bun.file(file).slice(0, headScanBytes).text();
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

/** One row per transcript that exists right now. The effort backlog is a left join of this
 * catalog against parser state, so a first enable finds work even when no path changed. */
export type SessionSource = {
  sessionId: string;
  agent: "claude" | "codex";
  sourceFile: string;
  mtimeMs: number;
  size: number;
  /** Device/inode where the platform exposes it; a change means the path was replaced, not
   * appended to, and the session must be rebuilt from byte zero. */
  sourceIdentity: string | null;
};

export type PathIndexResult = {
  catalog: SessionSource[];
  changed: SessionSource[];
  removedSessionIds: string[];
};

// Codex moves a session's transcript here once it ages the session out of
// `.codex/sessions/`, without renaming it — ccusage still reports it (by its
// bare `rollout-...` id, no date prefix) so a session must stay indexed after
// the move or it silently drops out of `session_paths` and looks gone.
const managedRoots = [".claude/projects/", ".codex/sessions/", ".codex/archived_sessions/"];

async function indexGlob(agent: "claude" | "codex", pattern: string) {
  const root = homedir();
  const glob = new Bun.Glob(pattern);
  const upsert = db.query(`INSERT INTO session_paths
    (session_id, agent, native_session_key, source_file, cwd, source_mtime, source_size, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(session_id) DO UPDATE SET cwd = excluded.cwd, source_mtime = excluded.source_mtime, source_size = excluded.source_size, indexed_at = CURRENT_TIMESTAMP`);
  const existingQuery = db.query("SELECT session_id, source_mtime, source_size, cwd FROM session_paths WHERE source_file = ?");
  const touchSize = db.query("UPDATE session_paths SET source_size = ? WHERE session_id = ?");
  const touchCwd = db.query("UPDATE session_paths SET cwd = ? WHERE session_id = ?");
  const catalog: SessionSource[] = [];
  const changed: SessionSource[] = [];
  for await (const sourceRelativePath of glob.scan({ cwd: root, absolute: false, onlyFiles: true, dot: true })) {
    const sourceFile = `${root}/${sourceRelativePath}`;
    const info = await stat(sourceFile);
    const identity = Number.isFinite(info.dev) && Number.isFinite(info.ino) ? `${info.dev}:${info.ino}` : null;
    const existing = existingQuery.get(sourceFile) as { session_id: string; source_mtime: number; source_size: number; cwd: string | null } | null;
    let sessionId = existing?.session_id ?? "";
    if (existing?.source_mtime === info.mtimeMs) {
      // Backfills the size column for databases migrated from before it existed.
      if (existing.source_size !== info.size) touchSize.run(info.size, existing.session_id);
      // A row can be left with cwd unresolved by a bug in an earlier version of the header
      // parse (an early line too big for the window it used, say) rather than by the
      // transcript genuinely never stating one. The mtime match above would otherwise skip
      // this file forever, so a null cwd always gets one more try — cheap once it resolves,
      // since this branch then stops running for it.
      if (existing.cwd === null) {
        const { cwd } = await parseHead(sourceFile, agent);
        if (cwd) touchCwd.run(cwd, existing.session_id);
      }
    } else {
      const { cwd, nativeKey } = await parseHead(sourceFile, agent);
      sessionId = stableSessionId(agent, sourceRelativePath, nativeKey);
      upsert.run(sessionId, agent, nativeKey, sourceFile, cwd, info.mtimeMs, info.size);
    }
    const source: SessionSource = { sessionId, agent, sourceFile, mtimeMs: info.mtimeMs, size: info.size, sourceIdentity: identity };
    catalog.push(source);
    if (existing?.source_mtime !== info.mtimeMs) changed.push(source);
  }
  return { catalog, changed };
}

export async function indexSessionPaths(): Promise<PathIndexResult & { indexed: number }> {
  // A partial or failed scan must never look like "these transcripts disappeared", so all globs
  // are awaited to completion before anything is pruned.
  const [claude, codex, codexArchived] = await Promise.all([
    indexGlob("claude", ".claude/projects/**/*.jsonl"),
    indexGlob("codex", ".codex/sessions/**/*.jsonl"),
    indexGlob("codex", ".codex/archived_sessions/**/*.jsonl"),
  ]);
  const catalog = [...claude.catalog, ...codex.catalog, ...codexArchived.catalog];
  const changed = [...claude.changed, ...codex.changed, ...codexArchived.changed];
  const seen = new Set(catalog.map((source) => source.sessionId));
  const root = homedir();
  const rows = db.query("SELECT session_id, source_file FROM session_paths").all() as Array<{ session_id: string; source_file: string }>;
  const removedSessionIds = rows
    .filter((row) => managedRoots.some((managed) => row.source_file.startsWith(`${root}/${managed}`)) && !seen.has(row.session_id))
    .map((row) => row.session_id);
  if (removedSessionIds.length) {
    const remove = db.query("DELETE FROM session_paths WHERE session_id = ?");
    db.transaction(() => removedSessionIds.forEach((sessionId) => remove.run(sessionId)))();
  }
  return { catalog, changed, removedSessionIds, indexed: changed.length };
}

function globRegex(pattern: string) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

/** Applies the user's path rules to any local working directory, including sources that do not
 * have a transcript row in `session_paths` (such as Warp's SQLite conversations). */
export function pathTagsForCwd(cwd: string | null) {
  if (!cwd) return [];
  const rules = listRules().flatMap((rule) => {
    try {
      return [{ tag: rule.tag, matcher: rule.kind === "regex" ? new RegExp(rule.pattern, "i") : globRegex(rule.pattern) }];
    } catch {
      return [];
    }
  });
  return rules.filter((rule) => rule.matcher.test(cwd)).map((rule) => rule.tag);
}

export function getPathIndex(): Record<string, IndexedPath & { tags: string[] }> {
  const rows = db.query("SELECT session_id, agent, native_session_key, cwd, source_file FROM session_paths").all() as Array<{session_id:string;agent:string;native_session_key:string;cwd:string|null;source_file:string}>;
  return Object.fromEntries(rows.flatMap((row) => {
    const tags = pathTagsForCwd(row.cwd);
    const value = { sessionId: row.session_id, agent: row.agent, nativeKey: row.native_session_key, cwd: row.cwd, sourceFile: relative(homedir(), row.source_file), tags };
    return sessionReportKeys(row.agent, row.native_session_key, row.source_file).map((key) => [`${row.agent}:${key}`, value]);
  }));
}

export function getSessionSource(sessionId: string) {
  const row = db.query("SELECT agent, source_file, cwd FROM session_paths WHERE session_id = ?").get(sessionId) as {agent:string;source_file:string;cwd:string|null} | null;
  return row ? { agent: row.agent, sourceFile: row.source_file, cwd: row.cwd } : null;
}

export function getNativeSessionKey(sessionId: string) {
  const row = db.query("SELECT native_session_key AS nativeKey FROM session_paths WHERE session_id = ?").get(sessionId) as { nativeKey: string } | null;
  return row?.nativeKey ?? null;
}
