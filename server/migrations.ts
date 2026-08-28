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
  {
    id: 3,
    up(db) {
      // The existing stat sweep already knows every transcript's size; persisting it here lets the
      // effort backlog be computed from the catalog instead of a second glob pass.
      const columns = db.query("PRAGMA table_info(session_paths)").all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "source_size")) {
        db.exec("ALTER TABLE session_paths ADD COLUMN source_size INTEGER NOT NULL DEFAULT 0");
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS effort_index_meta (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
          index_version INTEGER NOT NULL DEFAULT 0,
          indexed_at TEXT,
          last_error TEXT
        );
        INSERT OR IGNORE INTO effort_index_meta(id) VALUES (1);
        CREATE TABLE IF NOT EXISTS session_effort_state (
          session_id TEXT PRIMARY KEY
            REFERENCES session_paths(session_id) ON DELETE CASCADE,
          parser_version INTEGER NOT NULL,
          source_size INTEGER NOT NULL,
          source_mtime REAL NOT NULL,
          source_identity TEXT,
          last_offset INTEGER NOT NULL,
          resume_hash TEXT NOT NULL,
          current_effort TEXT,
          current_model TEXT,
          last_usage_key TEXT,
          codex_session_key TEXT,
          codex_replaying INTEGER NOT NULL DEFAULT 0 CHECK (codex_replaying IN (0, 1)),
          observations INTEGER NOT NULL DEFAULT 0,
          unknown_observations INTEGER NOT NULL DEFAULT 0,
          observed_usage_tokens INTEGER NOT NULL DEFAULT 0,
          attributed_tokens INTEGER NOT NULL DEFAULT 0,
          parse_errors INTEGER NOT NULL DEFAULT 0,
          context_gaps INTEGER NOT NULL DEFAULT 0,
          skipped_bytes INTEGER NOT NULL DEFAULT 0,
          coverage_state TEXT NOT NULL,
          last_indexed_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS session_effort_usage (
          session_id TEXT NOT NULL
            REFERENCES session_effort_state(session_id) ON DELETE CASCADE,
          occurred_on TEXT NOT NULL,
          model TEXT NOT NULL,
          effort TEXT NOT NULL,
          observations INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
          reasoning_reported_events INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (session_id, occurred_on, model, effort)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS session_effort_usage_day
          ON session_effort_usage(occurred_on, effort);
        CREATE INDEX IF NOT EXISTS session_effort_usage_model
          ON session_effort_usage(model, effort);
      `);
    },
  },
  {
    id: 4,
    up(db) {
      // Verdict is a user's own rating of a session. It is never inferred, and the column is
      // added beside the existing annotation fields so one write can never clear the other.
      const columns = db.query("PRAGMA table_info(annotations)").all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "verdict")) {
        db.exec("ALTER TABLE annotations ADD COLUMN verdict TEXT CHECK (verdict IN ('good', 'mixed', 'bad'))");
      }
      // Annotation writes do not change `collectedAt` or the effort index version, so cached
      // snapshots and conditional responses need a revision of their own to invalidate against.
      db.exec(`
        CREATE TABLE IF NOT EXISTS annotation_meta (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          version INTEGER NOT NULL DEFAULT 0
        );
        INSERT OR IGNORE INTO annotation_meta(id) VALUES (1);
      `);
    },
  },
  {
    id: 5,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_evidence_meta (
          session_id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          source_identity TEXT,
          source_mtime REAL NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS session_activity_events (
          session_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          occurred_at INTEGER NOT NULL,
          PRIMARY KEY (session_id, provider, occurred_at)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS session_activity_events_provider_time
          ON session_activity_events(provider, occurred_at, session_id);
        CREATE TABLE IF NOT EXISTS session_quota_observations (
          session_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          observed_at INTEGER NOT NULL,
          resource_id TEXT NOT NULL,
          used_percent REAL NOT NULL,
          resets_at INTEGER,
          cycle_id TEXT NOT NULL,
          PRIMARY KEY (session_id, provider, observed_at, resource_id, cycle_id)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS session_quota_observations_provider_time
          ON session_quota_observations(provider, observed_at, session_id);
      `);
    },
  },
  {
    id: 6,
    up(db) {
      const columns = db.query("PRAGMA table_info(session_quota_observations)").all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "plan_id")) {
        db.exec("ALTER TABLE session_quota_observations ADD COLUMN plan_id TEXT");
      }
      if (!columns.some((column) => column.name === "plan_source")) {
        db.exec("ALTER TABLE session_quota_observations ADD COLUMN plan_source TEXT NOT NULL DEFAULT 'unknown'");
      }
    },
  },
];

export function runMigrations(db: Database, applied: Migration[] = migrations) {
  const current = Number((db.query("PRAGMA user_version").get() as { user_version?: number } | null)?.user_version ?? 0);
  for (const migration of applied) {
    if (migration.id <= current) continue;
    db.transaction(() => {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.id}`);
    })();
  }
}
