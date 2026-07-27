import type { Database } from "bun:sqlite";

export type Migration = { id: number; up: (db: Database) => void };

export const migrations: Migration[] = [
  {
    id: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS path_rules (
          id INTEGER PRIMARY KEY AUTOINCREMENT, pattern TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('glob','regex')), tag TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS session_paths (
          session_id TEXT PRIMARY KEY, agent TEXT NOT NULL, native_session_key TEXT NOT NULL,
          source_file TEXT NOT NULL, cwd TEXT, source_mtime REAL NOT NULL,
          indexed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS session_paths_native ON session_paths(agent, native_session_key);
        CREATE TABLE IF NOT EXISTS annotations (
          session_id TEXT PRIMARY KEY, tags TEXT NOT NULL DEFAULT '[]',
          note TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `);
    },
  },
  {
    id: 2,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS usage_advice (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          rule_id TEXT NOT NULL, dedupe_key TEXT NOT NULL, severity TEXT NOT NULL,
          scope_json TEXT NOT NULL, evidence_json TEXT NOT NULL,
          detected_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'active', snoozed_until TEXT, resolved_at TEXT,
          UNIQUE(rule_id, dedupe_key)
        );
        CREATE TABLE IF NOT EXISTS usage_advice_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, advice_id INTEGER NOT NULL,
          event TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          FOREIGN KEY(advice_id) REFERENCES usage_advice(id) ON DELETE CASCADE
        );
      `);
    },
  },
];

export function runMigrations(db: Database) {
  const current = Number((db.query("PRAGMA user_version").get() as { user_version?: number } | null)?.user_version ?? 0);
  for (const migration of migrations) {
    if (migration.id <= current) continue;
    db.transaction(() => {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.id}`);
    })();
  }
}
