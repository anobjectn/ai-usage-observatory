import type { AntigravityCollection } from "./antigravity";
import { commitEffortSpan, effortGeneration, getEffortMeta, getEffortState, resetEffortSession } from "./effort-store";
import { removeLocalSessionPaths, upsertLocalSessionPath } from "./path-indexer";
import { db } from "./store";

/** Antigravity effort rows are computed by the collector, not by the byte-offset transcript
 * index, so they carry their own version. Bump it when the rows a conversation yields change. */
export const ANTIGRAVITY_EFFORT_VERSION = 1;

class StaleGeneration extends Error {}

/** Writes one collection's effort rows into the opt-in effort store.
 *
 * Every session gets a `session_paths` row, so its derived rows can be scoped by project and are
 * removed with it. Rows are written only while the effort index is enabled, and only for a
 * session whose database signature or reporting time zone changed: the old rows are replaced in
 * the same transaction, so a change never double-counts. A pass that began before derived data was deleted writes
 * nothing. A session leaves `session_paths`, with its effort rows, only when the collection found
 * its database file gone. */
export function syncAntigravityEffort(collection: Pick<AntigravityCollection, "effortSources" | "missingSessionIds">, generation = effortGeneration()) {
  let written = 0;
  for (const source of collection.effortSources) {
    upsertLocalSessionPath({
      sessionId: source.sessionId,
      agent: "antigravity",
      nativeKey: source.conversationId,
      sourceFile: source.sourceFile,
      cwd: source.cwd,
      mtimeMs: source.mtimeMs,
      size: source.size,
    });
  }
  // Only sessions whose own database file is gone are removed; see `checkStoredSessions`.
  removeLocalSessionPaths("antigravity", collection.missingSessionIds);
  if (!getEffortMeta().enabled) return { written };
  for (const source of collection.effortSources) {
    // Rows are bucketed into days in the reporting time zone, so a change of zone rewrites them.
    const signature = `${ANTIGRAVITY_EFFORT_VERSION}:${source.timeZone}:${source.signature}`;
    const state = getEffortState(source.sessionId);
    if (state && state.parserVersion === ANTIGRAVITY_EFFORT_VERSION && state.resumeHash === signature) continue;
    try {
      db.transaction(() => {
        resetEffortSession(source.sessionId);
        const committed = commitEffortSpan({
          generation,
          sessionId: source.sessionId,
          parserVersion: ANTIGRAVITY_EFFORT_VERSION,
          sourceSize: source.size,
          sourceMtime: source.mtimeMs,
          sourceIdentity: source.identity,
          lastOffset: 0,
          resumeHash: signature,
          currentEffort: null,
          currentModel: null,
          lastUsageKey: null,
          codexSessionKey: null,
          codexReplaying: false,
          codexUsageState: null,
          rows: source.rows,
          observations: source.observations,
          unknownObservations: source.unknownObservations,
          observedUsageTokens: source.tokens,
          attributedTokens: source.attributedTokens,
          parseErrors: 0,
          contextGaps: 0,
          skippedBytes: 0,
          coverageState: source.attributedTokens === 0 ? "unavailable" : source.unknownObservations === 0 ? "complete" : "partial",
          provider: "antigravity",
          activityTimestamps: source.activityTimestamps,
          quotaObservations: [],
        });
        // Rolls the reset back with it: a stale pass must leave the rows it found.
        if (!committed) throw new StaleGeneration();
      })();
      written++;
    } catch (error) {
      if (error instanceof StaleGeneration) return { written };
      throw error;
    }
  }
  return { written };
}
