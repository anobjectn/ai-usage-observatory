import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const dbPath = process.env.USAGE_OBSERVATORY_DB ?? join(process.cwd(), ".usage-observatory", "data.db");
mkdirSync(dirname(dbPath), { recursive: true });
export const db = new Database(dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
db.exec(`
  CREATE TABLE IF NOT EXISTS path_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('glob','regex')),
    tag TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS session_paths (
    session_id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    native_session_key TEXT NOT NULL,
    source_file TEXT NOT NULL,
    cwd TEXT,
    source_mtime REAL NOT NULL,
    indexed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS session_paths_native ON session_paths(agent, native_session_key);
  CREATE TABLE IF NOT EXISTS annotations (
    session_id TEXT PRIMARY KEY,
    tags TEXT NOT NULL DEFAULT '[]',
    note TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const count = db.query("SELECT COUNT(*) AS count FROM path_rules").get() as { count: number };
if (count.count === 0) {
  db.query("INSERT INTO path_rules (pattern, kind, tag) VALUES (?, ?, ?)").run("**/quota-service*", "glob", "quota-service");
  db.query("INSERT INTO path_rules (pattern, kind, tag) VALUES (?, ?, ?)").run("**/usage-observatory*", "glob", "usage-observatory");
}
if (!db.query("SELECT value FROM settings WHERE key = 'monthlyBudget'").get()) {
  db.query("INSERT INTO settings (key, value) VALUES ('monthlyBudget', '250')").run();
}

export type PathRule = { id: number; pattern: string; kind: "glob" | "regex"; tag: string; created_at: string };
export type Annotation = { tags: string[]; note: string; updatedAt?: string };

export function listRules(): PathRule[] {
  return db.query("SELECT * FROM path_rules ORDER BY tag, pattern").all() as PathRule[];
}

export function createRule(input: Omit<PathRule, "id" | "created_at">): PathRule {
  const result = db.query("INSERT INTO path_rules (pattern, kind, tag) VALUES (?, ?, ?)").run(input.pattern, input.kind, input.tag);
  return db.query("SELECT * FROM path_rules WHERE id = ?").get(result.lastInsertRowid) as PathRule;
}

export function updateRule(id: number, input: Omit<PathRule, "id" | "created_at">): PathRule | null {
  db.query("UPDATE path_rules SET pattern = ?, kind = ?, tag = ? WHERE id = ?").run(input.pattern, input.kind, input.tag, id);
  return db.query("SELECT * FROM path_rules WHERE id = ?").get(id) as PathRule | null;
}

export function deleteRule(id: number) {
  db.query("DELETE FROM path_rules WHERE id = ?").run(id);
}

export function getAnnotations(): Record<string, Annotation> {
  const rows = db.query("SELECT session_id, tags, note, updated_at FROM annotations").all() as Array<{session_id:string;tags:string;note:string;updated_at:string}>;
  return Object.fromEntries(rows.map((row) => [row.session_id, { tags: JSON.parse(row.tags), note: row.note, updatedAt: row.updated_at }]));
}

export function setAnnotation(sessionId: string, annotation: Annotation) {
  db.query(`INSERT INTO annotations (session_id, tags, note, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(session_id) DO UPDATE SET tags = excluded.tags, note = excluded.note, updated_at = CURRENT_TIMESTAMP`)
    .run(sessionId, JSON.stringify(annotation.tags), annotation.note);
}

export function getSettings() {
  const rows = db.query("SELECT key, value FROM settings").all() as Array<{key:string;value:string}>;
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export function setSettings(settings: Record<string, string | number | boolean>) {
  const query = db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  db.transaction(() => Object.entries(settings).forEach(([key, value]) => query.run(key, String(value))))();
}
