import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { runMigrations } from "./migrations";

const dbPath = process.env.USAGE_OBSERVATORY_DB ?? join(process.cwd(), ".usage-observatory", "data.db");
mkdirSync(dirname(dbPath), { recursive: true });
export const db = new Database(dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
runMigrations(db);

// Seed defaults only into a brand-new database; a user deleting a seeded rule must stick.
const count = db.query("SELECT COUNT(*) AS count FROM path_rules").get() as { count: number };
if (count.count === 0) {
  db.query("INSERT INTO path_rules (pattern, kind, tag) VALUES (?, ?, ?)").run("**/quota-service*", "glob", "quota-service");
  db.query("INSERT INTO path_rules (pattern, kind, tag) VALUES (?, ?, ?)").run("**/ai-usage-observatory*", "glob", "ai-usage-observatory");
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

export type StoredAdvice = {
  id: number; ruleId: string; dedupeKey: string; severity: "notice" | "opportunity" | "urgent";
  scope: Record<string, string>; evidence: Record<string, number | string>;
  detectedAt: string; lastSeenAt: string; state: "active" | "dismissed" | "snoozed" | "resolved" | "expired";
  snoozedUntil: string | null; resolvedAt: string | null;
};

function adviceRow(row: Record<string, unknown>): StoredAdvice {
  return { id: Number(row.id), ruleId: String(row.rule_id), dedupeKey: String(row.dedupe_key), severity: row.severity as StoredAdvice["severity"], scope: JSON.parse(String(row.scope_json)), evidence: JSON.parse(String(row.evidence_json)), detectedAt: String(row.detected_at), lastSeenAt: String(row.last_seen_at), state: row.state as StoredAdvice["state"], snoozedUntil: row.snoozed_until ? String(row.snoozed_until) : null, resolvedAt: row.resolved_at ? String(row.resolved_at) : null };
}

export function listAdvice(state?: string) {
  const sql = state ? "SELECT * FROM usage_advice WHERE state = ? ORDER BY last_seen_at DESC" : "SELECT * FROM usage_advice ORDER BY last_seen_at DESC";
  return (state ? db.query(sql).all(state) : db.query(sql).all()).map((row) => adviceRow(row as Record<string, unknown>));
}

export function upsertAdvice(input: Omit<StoredAdvice, "id" | "detectedAt" | "lastSeenAt" | "state" | "snoozedUntil" | "resolvedAt">) {
  const now = new Date().toISOString();
  db.query(`INSERT INTO usage_advice (rule_id, dedupe_key, severity, scope_json, evidence_json, detected_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(rule_id, dedupe_key) DO UPDATE SET severity=excluded.severity, scope_json=excluded.scope_json, evidence_json=excluded.evidence_json, last_seen_at=excluded.last_seen_at`).run(input.ruleId, input.dedupeKey, input.severity, JSON.stringify(input.scope), JSON.stringify(input.evidence), now, now);
  return adviceRow(db.query("SELECT * FROM usage_advice WHERE rule_id = ? AND dedupe_key = ?").get(input.ruleId, input.dedupeKey) as Record<string, unknown>);
}

export function updateAdviceState(id: number, state: StoredAdvice["state"], snoozedUntil: string | null = null) {
  const now = new Date().toISOString();
  db.query("UPDATE usage_advice SET state = ?, snoozed_until = ?, resolved_at = ? WHERE id = ?").run(state, snoozedUntil, state === "resolved" ? now : null, id);
  db.query("INSERT INTO usage_advice_events (advice_id, event, metadata_json) VALUES (?, ?, ?)").run(id, state, JSON.stringify(snoozedUntil ? { snoozedUntil } : {}));
  const row = db.query("SELECT * FROM usage_advice WHERE id = ?").get(id);
  return row ? adviceRow(row as Record<string, unknown>) : null;
}
