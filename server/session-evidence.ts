import { db } from "./store";

export type ActivityEpisode = { startAt: number; endAt: number };
export type StoredQuotaObservation = {
  sessionId: string;
  provider: "anthropic" | "codex";
  observedAt: number;
  resourceId: "fiveHour" | "weekly" | string;
  usedPercent: number;
  resetsAt: number | null;
  cycleId: string;
  planId: string | null;
  planSource: "provider" | "unknown";
};

export const SESSION_IDLE_GAP_MS = 30 * 60_000;

export function mergeActivityEpisodes(
  timestamps: number[],
  idleGapMs = SESSION_IDLE_GAP_MS,
): ActivityEpisode[] {
  const sorted = [...new Set(timestamps.filter(Number.isFinite))].sort((a, b) => a - b);
  const episodes: ActivityEpisode[] = [];
  for (const timestamp of sorted) {
    const active = episodes.at(-1);
    if (!active || timestamp - active.endAt > idleGapMs) {
      episodes.push({ startAt: timestamp, endAt: timestamp });
    } else {
      active.endAt = timestamp;
    }
  }
  return episodes;
}

export const saveWarpEvidence = db.transaction((input: {
  sessionId: string;
  sourceIdentity: string;
  sourceMtime: number;
  activityTimestamps: number[];
}) => {
  db.query(`INSERT INTO session_evidence_meta
    (session_id, provider, source_identity, source_mtime, updated_at)
    VALUES (?, 'warp', ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(session_id) DO UPDATE SET
      provider = 'warp', source_identity = excluded.source_identity,
      source_mtime = excluded.source_mtime, updated_at = CURRENT_TIMESTAMP`)
    .run(input.sessionId, input.sourceIdentity, input.sourceMtime);
  const insert = db.query(`INSERT OR IGNORE INTO session_activity_events
    (session_id, provider, occurred_at) VALUES (?, 'warp', ?)`);
  for (const occurredAt of new Set(input.activityTimestamps)) insert.run(input.sessionId, occurredAt);
});

export function getSessionEpisodes(sessionId: string): ActivityEpisode[] {
  const rows = db.query(
    "SELECT occurred_at AS occurredAt FROM session_activity_events WHERE session_id = ? ORDER BY occurred_at",
  ).all(sessionId) as Array<{ occurredAt: number }>;
  return mergeActivityEpisodes(rows.map((row) => Number(row.occurredAt)));
}

export function getSessionProvider(sessionId: string): "anthropic" | "codex" | "warp" | null {
  const row = db.query("SELECT provider FROM session_evidence_meta WHERE session_id = ?").get(sessionId) as { provider?: string } | null;
  return row?.provider === "anthropic" || row?.provider === "codex" || row?.provider === "warp"
    ? row.provider
    : null;
}

export function listEvidenceSessionIds() {
  return (db.query("SELECT session_id AS sessionId FROM session_evidence_meta ORDER BY session_id").all() as Array<{ sessionId: string }>)
    .map((row) => row.sessionId);
}

export function getEmbeddedQuotaObservations(sessionId: string): StoredQuotaObservation[] {
  return db.query(`SELECT session_id AS sessionId, provider, observed_at AS observedAt,
      resource_id AS resourceId, used_percent AS usedPercent, resets_at AS resetsAt, cycle_id AS cycleId,
      plan_id AS planId, plan_source AS planSource
    FROM session_quota_observations WHERE session_id = ? ORDER BY observed_at, resource_id`)
    .all(sessionId) as StoredQuotaObservation[];
}

export function getEpisodesOverlapping(from: number, to: number): Array<{
  sessionId: string;
  provider: "anthropic" | "codex" | "warp";
  episodes: ActivityEpisode[];
}> {
  const rows = db.query(`SELECT session_id AS sessionId, provider, occurred_at AS occurredAt
    FROM session_activity_events
    WHERE occurred_at BETWEEN ? AND ?
    ORDER BY session_id, occurred_at`).all(from - SESSION_IDLE_GAP_MS, to + SESSION_IDLE_GAP_MS) as Array<{
      sessionId: string;
      provider: "anthropic" | "codex" | "warp";
      occurredAt: number;
    }>;
  const grouped = new Map<string, { provider: "anthropic" | "codex" | "warp"; timestamps: number[] }>();
  for (const row of rows) {
    const current = grouped.get(row.sessionId) ?? { provider: row.provider, timestamps: [] };
    current.timestamps.push(Number(row.occurredAt));
    grouped.set(row.sessionId, current);
  }
  return [...grouped.entries()].map(([sessionId, value]) => ({
    sessionId,
    provider: value.provider,
    episodes: mergeActivityEpisodes(value.timestamps).filter((episode) => episode.endAt >= from && episode.startAt <= to),
  }));
}
