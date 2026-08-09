import { db } from "./store";
import type { EffortUsageRow } from "./effort-parse";

/** This module is the only place internal empty-string sentinels ('' date / '' model / ''
 * effort) become typed nulls. Nothing above it should ever compare against ''. */
export type EffortSessionState = {
  sessionId: string;
  parserVersion: number;
  sourceSize: number;
  sourceMtime: number;
  sourceIdentity: string | null;
  lastOffset: number;
  resumeHash: string;
  currentEffort: string | null;
  currentModel: string | null;
  lastUsageKey: string | null;
  codexSessionKey: string | null;
  codexReplaying: boolean;
  observations: number;
  unknownObservations: number;
  observedUsageTokens: number;
  attributedTokens: number;
  parseErrors: number;
  contextGaps: number;
  skippedBytes: number;
  coverageState: string;
  lastIndexedAt: string;
};

export type EffortMeta = {
  enabled: boolean;
  indexVersion: number;
  indexedAt: string | null;
  lastError: string | null;
};

export type EffortGroup = "total" | "day" | "project" | "model" | "provider";

export type EffortQuery = {
  group: EffortGroup;
  /** null means "every indexed session"; an empty array means "no session matched". */
  sessionIds: string[] | null;
  /** Inclusive lower bound on calendar activity; only used by the timeline basis. */
  fromDate: string | null;
  /** Inclusive upper bound on calendar activity; only used by the timeline basis. */
  toDate: string | null;
  agents: Array<"claude" | "codex"> | null;
  project: string | null;
  model: string | null;
};

export type EffortGroupedRow = { key: string; effort: string | null; observations: number; tokens: number };

/** The bundled SQLite must expose `json_each`; without it the only alternative is interpolating
 * an `IN (...)` list into SQL text, which this codebase does not do. */
export function assertJsonEachSupport(database = db) {
  const row = database.query("SELECT COUNT(*) AS count FROM json_each(?)").get(JSON.stringify(["a", "b"])) as { count: number };
  if (row.count !== 2) throw new Error("SQLite json_each() is unavailable; effort scoping cannot be bound safely");
  return true;
}

export function getEffortMeta(): EffortMeta {
  const row = db.query("SELECT enabled, index_version, indexed_at, last_error FROM effort_index_meta WHERE id = 1").get() as
    { enabled: number; index_version: number; indexed_at: string | null; last_error: string | null } | null;
  return {
    enabled: Boolean(row?.enabled),
    indexVersion: Number(row?.index_version ?? 0),
    indexedAt: row?.indexed_at ?? null,
    lastError: row?.last_error ?? null,
  };
}

export function setEffortEnabled(enabled: boolean) {
  db.query("UPDATE effort_index_meta SET enabled = ?, index_version = index_version + 1, last_error = NULL WHERE id = 1").run(enabled ? 1 : 0);
  return getEffortMeta();
}

export function setEffortError(error: string | null) {
  db.query("UPDATE effort_index_meta SET last_error = ? WHERE id = 1").run(error);
}

export function markEffortIndexed() {
  db.query("UPDATE effort_index_meta SET indexed_at = CURRENT_TIMESTAMP WHERE id = 1").run();
}

function stateRow(row: Record<string, unknown>): EffortSessionState {
  return {
    sessionId: String(row.session_id),
    parserVersion: Number(row.parser_version),
    sourceSize: Number(row.source_size),
    sourceMtime: Number(row.source_mtime),
    sourceIdentity: row.source_identity === null ? null : String(row.source_identity),
    lastOffset: Number(row.last_offset),
    resumeHash: String(row.resume_hash),
    currentEffort: row.current_effort === null ? null : String(row.current_effort),
    currentModel: row.current_model === null ? null : String(row.current_model),
    lastUsageKey: row.last_usage_key === null || row.last_usage_key === undefined ? null : String(row.last_usage_key),
    codexSessionKey: row.codex_session_key === null || row.codex_session_key === undefined ? null : String(row.codex_session_key),
    codexReplaying: Boolean(row.codex_replaying),
    observations: Number(row.observations),
    unknownObservations: Number(row.unknown_observations),
    observedUsageTokens: Number(row.observed_usage_tokens),
    attributedTokens: Number(row.attributed_tokens),
    parseErrors: Number(row.parse_errors),
    contextGaps: Number(row.context_gaps),
    skippedBytes: Number(row.skipped_bytes),
    coverageState: String(row.coverage_state),
    lastIndexedAt: String(row.last_indexed_at),
  };
}

export function getEffortStates(): Map<string, EffortSessionState> {
  const rows = db.query("SELECT * FROM session_effort_state").all() as Array<Record<string, unknown>>;
  return new Map(rows.map((row) => [String(row.session_id), stateRow(row)]));
}

export function getEffortState(sessionId: string): EffortSessionState | null {
  const row = db.query("SELECT * FROM session_effort_state WHERE session_id = ?").get(sessionId) as Record<string, unknown> | null;
  return row ? stateRow(row) : null;
}

export function getEffortCounters() {
  const row = db.query(`SELECT COUNT(*) AS sessions,
      COALESCE(SUM(parse_errors), 0) AS parse_errors,
      COALESCE(SUM(context_gaps), 0) AS context_gaps,
      COALESCE(SUM(skipped_bytes), 0) AS skipped_bytes,
      COALESCE(SUM(last_offset), 0) AS indexed_bytes
    FROM session_effort_state`).get() as Record<string, number>;
  return {
    indexedSessions: Number(row.sessions),
    parseErrors: Number(row.parse_errors),
    contextGaps: Number(row.context_gaps),
    skippedBytes: Number(row.skipped_bytes),
    indexedBytes: Number(row.indexed_bytes),
  };
}

const upsertUsage = db.query(`INSERT INTO session_effort_usage
  (session_id, occurred_on, model, effort, observations, input_tokens, cache_read_tokens, cache_creation_tokens, output_tokens, reasoning_output_tokens, reasoning_reported_events, total_tokens)
  VALUES ($session, $occurredOn, $model, $effort, $observations, $input, $cacheRead, $cacheCreation, $output, $reasoning, $reasoningEvents, $total)
  ON CONFLICT(session_id, occurred_on, model, effort) DO UPDATE SET
    observations = session_effort_usage.observations + excluded.observations,
    input_tokens = session_effort_usage.input_tokens + excluded.input_tokens,
    cache_read_tokens = session_effort_usage.cache_read_tokens + excluded.cache_read_tokens,
    cache_creation_tokens = session_effort_usage.cache_creation_tokens + excluded.cache_creation_tokens,
    output_tokens = session_effort_usage.output_tokens + excluded.output_tokens,
    reasoning_output_tokens = session_effort_usage.reasoning_output_tokens + excluded.reasoning_output_tokens,
    reasoning_reported_events = session_effort_usage.reasoning_reported_events + excluded.reasoning_reported_events,
    total_tokens = session_effort_usage.total_tokens + excluded.total_tokens`);

const upsertState = db.query(`INSERT INTO session_effort_state
  (session_id, parser_version, source_size, source_mtime, source_identity, last_offset, resume_hash,
   current_effort, current_model, last_usage_key, codex_session_key, codex_replaying,
   observations, unknown_observations, observed_usage_tokens, attributed_tokens,
   parse_errors, context_gaps, skipped_bytes, coverage_state, last_indexed_at)
  VALUES ($session, $parserVersion, $sourceSize, $sourceMtime, $sourceIdentity, $lastOffset, $resumeHash,
   $currentEffort, $currentModel, $lastUsageKey, $codexSessionKey, $codexReplaying,
   $observations, $unknownObservations, $observedUsageTokens, $attributedTokens,
   $parseErrors, $contextGaps, $skippedBytes, $coverageState, CURRENT_TIMESTAMP)
  ON CONFLICT(session_id) DO UPDATE SET
    parser_version = excluded.parser_version,
    source_size = excluded.source_size,
    source_mtime = excluded.source_mtime,
    source_identity = excluded.source_identity,
    last_offset = excluded.last_offset,
    resume_hash = excluded.resume_hash,
    current_effort = excluded.current_effort,
    current_model = excluded.current_model,
    last_usage_key = excluded.last_usage_key,
    codex_session_key = excluded.codex_session_key,
    codex_replaying = excluded.codex_replaying,
    observations = session_effort_state.observations + excluded.observations,
    unknown_observations = session_effort_state.unknown_observations + excluded.unknown_observations,
    observed_usage_tokens = session_effort_state.observed_usage_tokens + excluded.observed_usage_tokens,
    attributed_tokens = session_effort_state.attributed_tokens + excluded.attributed_tokens,
    parse_errors = session_effort_state.parse_errors + excluded.parse_errors,
    context_gaps = session_effort_state.context_gaps + excluded.context_gaps,
    skipped_bytes = session_effort_state.skipped_bytes + excluded.skipped_bytes,
    coverage_state = excluded.coverage_state,
    last_indexed_at = CURRENT_TIMESTAMP`);

export type EffortSpanCommit = {
  sessionId: string;
  parserVersion: number;
  sourceSize: number;
  sourceMtime: number;
  sourceIdentity: string | null;
  lastOffset: number;
  resumeHash: string;
  currentEffort: string | null;
  currentModel: string | null;
  lastUsageKey: string | null;
  codexSessionKey: string | null;
  codexReplaying: boolean;
  rows: EffortUsageRow[];
  observations: number;
  unknownObservations: number;
  observedUsageTokens: number;
  attributedTokens: number;
  parseErrors: number;
  contextGaps: number;
  skippedBytes: number;
  coverageState: string;
};

/** One parsed byte span becomes exactly one transaction: grouped rows, counters, resume hash,
 * next offset, and the index-version bump. A crash before it re-reads the span; a crash after it
 * resumes past the committed offset. Neither path double-counts. */
export const commitEffortSpan = db.transaction((commit: EffortSpanCommit) => {
  upsertState.run({
    $session: commit.sessionId,
    $parserVersion: commit.parserVersion,
    $sourceSize: commit.sourceSize,
    $sourceMtime: commit.sourceMtime,
    $sourceIdentity: commit.sourceIdentity,
    $lastOffset: commit.lastOffset,
    $resumeHash: commit.resumeHash,
    $currentEffort: commit.currentEffort,
    $currentModel: commit.currentModel,
    $lastUsageKey: commit.lastUsageKey,
    $codexSessionKey: commit.codexSessionKey,
    $codexReplaying: commit.codexReplaying ? 1 : 0,
    $observations: commit.observations,
    $unknownObservations: commit.unknownObservations,
    $observedUsageTokens: commit.observedUsageTokens,
    $attributedTokens: commit.attributedTokens,
    $parseErrors: commit.parseErrors,
    $contextGaps: commit.contextGaps,
    $skippedBytes: commit.skippedBytes,
    $coverageState: commit.coverageState,
  });
  for (const row of commit.rows) {
    upsertUsage.run({
      $session: commit.sessionId,
      $occurredOn: row.occurredOn,
      $model: row.model,
      $effort: row.effort,
      $observations: row.observations,
      $input: row.inputTokens,
      $cacheRead: row.cacheReadTokens,
      $cacheCreation: row.cacheCreationTokens,
      $output: row.outputTokens,
      $reasoning: row.reasoningOutputTokens,
      $reasoningEvents: row.reasoningReportedEvents,
      $total: row.totalTokens,
    });
  }
  db.query("UPDATE effort_index_meta SET index_version = index_version + 1 WHERE id = 1").run();
});

/** A rebuild clears one session's derived rows and state in the same transaction that precedes
 * reading it again from byte zero. */
export const resetEffortSession = db.transaction((sessionId: string) => {
  db.query("DELETE FROM session_effort_usage WHERE session_id = ?").run(sessionId);
  db.query("DELETE FROM session_effort_state WHERE session_id = ?").run(sessionId);
  db.query("UPDATE effort_index_meta SET index_version = index_version + 1 WHERE id = 1").run();
});

/** Removes every derived row. Transcripts, path metadata, annotations, and usage snapshots are
 * untouched. */
export const deleteEffortDerived = db.transaction(() => {
  db.query("DELETE FROM session_effort_usage").run();
  db.query("DELETE FROM session_effort_state").run();
  db.query("UPDATE effort_index_meta SET enabled = 0, index_version = index_version + 1, indexed_at = NULL, last_error = NULL WHERE id = 1").run();
});

const groupExpressions: Record<EffortGroup, string> = {
  total: "''",
  day: "u.occurred_on",
  project: "rtrim(COALESCE(p.cwd, ''), '/')",
  model: "u.model",
  provider: "p.agent",
};

const filters = `
  WHERE ($allSessions = 1 OR u.session_id IN (SELECT value FROM json_each($sessionIds)))
    AND ($fromDate IS NULL OR (u.occurred_on <> '' AND u.occurred_on >= $fromDate))
    AND ($toDate IS NULL OR (u.occurred_on <> '' AND u.occurred_on <= $toDate))
    AND ($allAgents = 1 OR p.agent IN (SELECT value FROM json_each($agents)))
    AND ($project IS NULL OR rtrim(COALESCE(p.cwd, ''), '/') = $project)
    AND ($model IS NULL OR u.model = $model)`;

// SQL text stays constant per grouping; every scope value arrives as a bound parameter.
const groupedQueries = Object.fromEntries(
  (Object.keys(groupExpressions) as EffortGroup[]).map((group) => [
    group,
    db.query(`SELECT ${groupExpressions[group]} AS key, u.effort AS effort,
        SUM(u.observations) AS observations, SUM(u.total_tokens) AS tokens
      FROM session_effort_usage u
      JOIN session_paths p ON p.session_id = u.session_id
      ${filters}
      GROUP BY key, u.effort`),
  ]),
) as Record<EffortGroup, ReturnType<typeof db.query>>;

function bindings(query: EffortQuery) {
  return {
    $allSessions: query.sessionIds === null ? 1 : 0,
    $sessionIds: JSON.stringify(query.sessionIds ?? []),
    $fromDate: query.fromDate,
    $toDate: query.toDate,
    $allAgents: query.agents === null ? 1 : 0,
    $agents: JSON.stringify(query.agents ?? []),
    $project: query.project,
    $model: query.model,
  };
}

export function queryEffortGrouped(query: EffortQuery): EffortGroupedRow[] {
  const rows = groupedQueries[query.group].all(bindings(query)) as Array<{ key: string; effort: string; observations: number; tokens: number }>;
  return rows.map((row) => ({
    key: row.key,
    effort: row.effort === "" ? null : row.effort,
    observations: Number(row.observations),
    tokens: Number(row.tokens),
  }));
}

const sessionDigestQuery = db.query(`SELECT u.session_id AS key, u.effort AS effort,
    SUM(u.observations) AS observations, SUM(u.total_tokens) AS tokens
  FROM session_effort_usage u
  JOIN session_paths p ON p.session_id = u.session_id
  ${filters}
  GROUP BY u.session_id, u.effort`);

export function queryEffortBySession(query: Omit<EffortQuery, "group">): EffortGroupedRow[] {
  const rows = sessionDigestQuery.all(bindings({ ...query, group: "total" })) as Array<{ key: string; effort: string; observations: number; tokens: number }>;
  return rows.map((row) => ({
    key: row.key,
    effort: row.effort === "" ? null : row.effort,
    observations: Number(row.observations),
    tokens: Number(row.tokens),
  }));
}

const sessionUnknownObservationsQuery = db.query(`SELECT u.session_id AS key, SUM(u.observations) AS observations
  FROM session_effort_usage u WHERE u.effort = '' GROUP BY u.session_id`);

export function queryUnknownObservationsBySession(): Map<string, number> {
  const rows = sessionUnknownObservationsQuery.all() as Array<{ key: string; observations: number }>;
  return new Map(rows.map((row) => [row.key, Number(row.observations)]));
}
