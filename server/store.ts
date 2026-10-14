import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolveDbPath } from "./db-path";
import { runMigrations } from "./migrations";
import { resolveSessionAlias } from "./session-identity";

export const dbPath = resolveDbPath();
mkdirSync(dirname(dbPath), { recursive: true });
export const db = new Database(dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
/** A database written by a newer build keeps working with this one; the update UI warns. */
export const migrationState = runMigrations(db);
if (migrationState.schemaAhead) {
  console.warn(`Database schema version ${migrationState.version} is newer than this build (${migrationState.known}). A pre-update backup is in .usage-observatory/backups.`);
}

// Default path rules are seeded by migration 8, once, so a user deleting every rule sticks.
if (!db.query("SELECT value FROM settings WHERE key = 'monthlyBudget'").get()) {
  db.query("INSERT INTO settings (key, value) VALUES ('monthlyBudget', '250')").run();
}

export type PathRule = { id: number; pattern: string; kind: "glob" | "regex"; tag: string; created_at: string };
/** A user's own rating of a session. It is never inferred from tokens, cost, or effort. */
export type Verdict = "good" | "mixed" | "bad";
export const verdicts: Verdict[] = ["good", "mixed", "bad"];
export const isVerdict = (value: unknown): value is Verdict => verdicts.includes(value as Verdict);
export type Annotation = { tags: string[]; note: string; verdict: Verdict | null; updatedAt?: string };
export const emptyAnnotation = (): Annotation => ({ tags: [], note: "", verdict: null });
export const resolveSessionId = (sessionId: string) => resolveSessionAlias(db, sessionId);

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

type AnnotationRow = { session_id: string; tags: string; note: string; verdict: string | null; updated_at: string };

const annotationOf = (row: AnnotationRow): Annotation => ({
  tags: JSON.parse(row.tags),
  note: row.note,
  verdict: isVerdict(row.verdict) ? row.verdict : null,
  updatedAt: row.updated_at,
});

export function getAnnotations(): Record<string, Annotation> {
  const rows = db.query("SELECT session_id, tags, note, verdict, updated_at FROM annotations").all() as AnnotationRow[];
  return Object.fromEntries(rows.map((row) => [row.session_id, annotationOf(row)]));
}

export function getAnnotation(sessionId: string): Annotation {
  sessionId = resolveSessionAlias(db, sessionId);
  const row = db.query("SELECT session_id, tags, note, verdict, updated_at FROM annotations WHERE session_id = ?").get(sessionId) as AnnotationRow | null;
  return row ? annotationOf(row) : emptyAnnotation();
}

/** Annotation writes change neither `collectedAt` nor the effort index version, so without this
 * revision a verdict edit would stay invisible behind a cached snapshot and a `304`. */
export function getAnnotationVersion() {
  return Number((db.query("SELECT version FROM annotation_meta WHERE id = 1").get() as { version?: number } | null)?.version ?? 0);
}

const bumpAnnotationVersion = () => db.query("UPDATE annotation_meta SET version = version + 1 WHERE id = 1").run();

/** Tags and note only. The two setters are field-preserving on purpose: a single replacement
 * setter would let a tag edit silently clear a verdict the user recorded. */
export const setAnnotationText = db.transaction((sessionId: string, annotation: Pick<Annotation, "tags" | "note">) => {
  sessionId = resolveSessionAlias(db, sessionId);
  db.query(`INSERT INTO annotations (session_id, tags, note, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(session_id) DO UPDATE SET tags = excluded.tags, note = excluded.note, updated_at = CURRENT_TIMESTAMP`)
    .run(sessionId, JSON.stringify(annotation.tags), annotation.note);
  bumpAnnotationVersion();
  return getAnnotation(sessionId);
});

/** Verdict only; `null` clears it. Tags and note are preserved. */
export const setVerdict = db.transaction((sessionId: string, verdict: Verdict | null) => {
  sessionId = resolveSessionAlias(db, sessionId);
  db.query(`INSERT INTO annotations (session_id, verdict, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(session_id) DO UPDATE SET verdict = excluded.verdict, updated_at = CURRENT_TIMESTAMP`)
    .run(sessionId, verdict);
  bumpAnnotationVersion();
  return getAnnotation(sessionId);
});

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

/** A snooze ends on its own: once `snoozed_until` has passed, the advice is active again.
 * `snoozed_until` is stored as UTC ISO text, so it compares correctly as a string. */
function wakeSnoozedAdvice(now: string) {
  db.query("UPDATE usage_advice SET state = 'active', snoozed_until = NULL WHERE state = 'snoozed' AND snoozed_until <= ?").run(now);
}

export function listAdvice(state?: string) {
  wakeSnoozedAdvice(new Date().toISOString());
  const sql = state ? "SELECT * FROM usage_advice WHERE state = ? ORDER BY last_seen_at DESC" : "SELECT * FROM usage_advice ORDER BY last_seen_at DESC";
  return (state ? db.query(sql).all(state) : db.query(sql).all()).map((row) => adviceRow(row as Record<string, unknown>));
}

/** A finding that fires again after it was resolved is active again. A dismissal or a snooze
 * that has not ended stays in place. */
export function upsertAdvice(input: Omit<StoredAdvice, "id" | "detectedAt" | "lastSeenAt" | "state" | "snoozedUntil" | "resolvedAt">) {
  const now = new Date().toISOString();
  wakeSnoozedAdvice(now);
  db.query(`INSERT INTO usage_advice (rule_id, dedupe_key, severity, scope_json, evidence_json, detected_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(rule_id, dedupe_key) DO UPDATE SET severity=excluded.severity, scope_json=excluded.scope_json, evidence_json=excluded.evidence_json, last_seen_at=excluded.last_seen_at,
      state = CASE WHEN usage_advice.state IN ('resolved', 'expired') THEN 'active' ELSE usage_advice.state END,
      resolved_at = CASE WHEN usage_advice.state IN ('resolved', 'expired') THEN NULL ELSE usage_advice.resolved_at END`).run(input.ruleId, input.dedupeKey, input.severity, JSON.stringify(input.scope), JSON.stringify(input.evidence), now, now);
  return adviceRow(db.query("SELECT * FROM usage_advice WHERE rule_id = ? AND dedupe_key = ?").get(input.ruleId, input.dedupeKey) as Record<string, unknown>);
}

/** Advice that was active or snoozed and that the latest evaluation did not produce is resolved.
 * `current` holds `rule_id\0dedupe_key` for every finding of that evaluation. */
export const resolveAdviceExcept = db.transaction((current: string[]) => {
  const now = new Date().toISOString();
  const open = db.query("SELECT id, rule_id, dedupe_key FROM usage_advice WHERE state IN ('active', 'snoozed')").all() as
    Array<{ id: number; rule_id: string; dedupe_key: string }>;
  const keep = new Set(current);
  for (const row of open) {
    if (keep.has(`${row.rule_id}\0${row.dedupe_key}`)) continue;
    db.query("UPDATE usage_advice SET state = 'resolved', snoozed_until = NULL, resolved_at = ? WHERE id = ?").run(now, row.id);
    db.query("INSERT INTO usage_advice_events (advice_id, event, metadata_json) VALUES (?, 'resolved', '{}')").run(row.id);
  }
});

/** Returns null, and records nothing, when no advice has this id. A snooze end time is stored as
 * UTC ISO text whatever offset it arrived with. */
export const updateAdviceState = db.transaction((id: number, state: StoredAdvice["state"], snoozedUntil: string | null = null) => {
  const now = new Date().toISOString();
  const until = snoozedUntil === null ? null : new Date(snoozedUntil).toISOString();
  const updated = db.query("UPDATE usage_advice SET state = ?, snoozed_until = ?, resolved_at = ? WHERE id = ?").run(state, until, state === "resolved" ? now : null, id);
  if (updated.changes === 0) return null;
  db.query("INSERT INTO usage_advice_events (advice_id, event, metadata_json) VALUES (?, ?, ?)").run(id, state, JSON.stringify(until ? { snoozedUntil: until } : {}));
  return adviceRow(db.query("SELECT * FROM usage_advice WHERE id = ?").get(id) as Record<string, unknown>);
});
