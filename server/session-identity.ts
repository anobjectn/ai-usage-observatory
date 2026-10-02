import type { Database } from "bun:sqlite";
import { basename, join } from "node:path";

export function stableSessionId(agent: string, sourceRelativePath: string, nativeSessionKey: string) {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(`${agent}\0${sourceRelativePath}\0${nativeSessionKey}`);
  return hash.digest("hex").slice(0, 24);
}

export function resolveSessionAlias(database: Database, sessionId: string) {
  const row = database.query("SELECT session_id FROM session_id_aliases WHERE old_id = ?").get(sessionId) as { session_id: string } | null;
  return row?.session_id ?? sessionId;
}

/** A recognized active/archive move keeps the existing ID and all its derived rows. */
export async function archivedSessionId(database: Database, root: string, relativePath: string, nativeKey: string) {
  const archived = relativePath.startsWith(".codex/archived_sessions/");
  const active = relativePath.startsWith(".codex/sessions/");
  if (!archived && !active) return null;
  const rows = database.query("SELECT session_id, source_file FROM session_paths WHERE agent = 'codex' AND native_session_key = ?")
    .all(nativeKey) as Array<{ session_id: string; source_file: string }>;
  const otherRoot = join(root, archived ? ".codex/sessions" : ".codex/archived_sessions") + "/";
  const candidates = rows.filter((row) => row.source_file.startsWith(otherRoot) && basename(row.source_file) === basename(relativePath));
  if (candidates.length !== 1 || await Bun.file(candidates[0].source_file).exists()) return null;
  return candidates[0].session_id;
}

/** Older scans pruned the active row, but its annotation survives. The dated rollout filename
 * reconstructs that old ID without guessing from a native key shared by a different file. */
export function recoverArchivedAnnotation(database: Database, relativePath: string, nativeKey: string, sessionId: string) {
  if (!relativePath.startsWith(".codex/archived_sessions/")) return;
  const filename = basename(relativePath);
  const date = /^rollout-(\d{4})-(\d{2})-(\d{2})T/.exec(filename);
  if (!date) return;
  const oldId = stableSessionId("codex", `.codex/sessions/${date[1]}/${date[2]}/${date[3]}/${filename}`, nativeKey);
  if (oldId === sessionId || database.query("SELECT 1 FROM session_paths WHERE session_id = ?").get(oldId)) return;
  const alias = database.query("SELECT session_id FROM session_id_aliases WHERE old_id = ?").get(oldId) as { session_id: string } | null;
  if (alias?.session_id === sessionId) return;
  type Row = { tags: string; note: string; verdict: string | null; updated_at: string };
  database.transaction(() => {
    const old = database.query("SELECT tags, note, verdict, updated_at FROM annotations WHERE session_id = ?").get(oldId) as Row | null;
    database.query("INSERT INTO session_id_aliases (old_id, session_id) VALUES (?, ?) ON CONFLICT(old_id) DO UPDATE SET session_id = excluded.session_id")
      .run(oldId, sessionId);
    if (!old) return;
    const current = database.query("SELECT tags, note, verdict, updated_at FROM annotations WHERE session_id = ?").get(sessionId) as Row | null;
    const tags = [...new Set([...JSON.parse(current?.tags ?? "[]"), ...JSON.parse(old.tags)])];
    const notes = [...new Set([current?.note, old.note].filter((note): note is string => Boolean(note)))];
    // Keep both user ratings as text when one scalar verdict cannot represent the conflict.
    if (current?.verdict && old.verdict && current.verdict !== old.verdict) notes.push(`Previous session verdict: ${old.verdict}.`);
    database.query(`INSERT INTO annotations (session_id, tags, note, verdict, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET tags = excluded.tags, note = excluded.note, verdict = excluded.verdict, updated_at = excluded.updated_at`)
      .run(sessionId, JSON.stringify(tags), notes.join("\n\n"), current?.verdict ?? old.verdict, [current?.updated_at ?? "", old.updated_at].sort().at(-1)!);
    database.query("DELETE FROM annotations WHERE session_id = ?").run(oldId);
    database.query("UPDATE annotation_meta SET version = version + 1 WHERE id = 1").run();
  })();
}
