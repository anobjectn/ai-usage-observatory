import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionQuotaContext } from "../types";

/** The endpoint answers at most this many ids per request, so longer asks are split. */
const batchSize = 25;
/** A failed batch is asked for again after these delays, then left alone until the reading's
 * version changes or the view mounts again. */
export const quotaRetryDelaysMs = [5_000, 15_000, 45_000];
/** Matches the server's `SESSION_IDLE_GAP_MS`: a closing reading may still arrive this long after
 * a session's last activity. */
const closingToleranceMs = 30 * 60_000;

/** What a session's closing reading depends on. New activity changes it; so does each collection
 * while the session is still inside the closing tolerance, because the reading that closes it may
 * not have been observed yet. An older session's version is stable, so it is fetched once. */
export function quotaContextVersion(
  session: { totalTokens: number; metadata?: { lastActivity?: string } },
  collectedAt: string,
) {
  const lastActivity = session.metadata?.lastActivity ?? "";
  const base = `${lastActivity}|${session.totalTokens}`;
  const settling = Date.parse(collectedAt) - Date.parse(lastActivity) < closingToleranceMs;
  return settling ? `${base}|${collectedAt}` : base;
}

/** Ids whose current version is neither answered nor already in flight. */
export function quotaContextsToFetch(
  sessionIds: string[],
  versionOf: (sessionId: string) => string,
  settled: ReadonlyMap<string, string>,
  pending: ReadonlyMap<string, string>,
) {
  return sessionIds.flatMap((sessionId) => {
    if (!sessionId) return [];
    const version = versionOf(sessionId);
    return settled.get(sessionId) === version || pending.get(sessionId) === version
      ? []
      : [{ sessionId, version }];
  });
}

/** Closing account-quota readings for sessions, fetched on demand and remembered per version.
 * Callers ask for the ids they are about to show; an id whose current version is already answered
 * or in flight is not asked for again. Ids already asked for are asked again when their version
 * changes, and a failed batch is retried with backoff.
 *
 * A list that runs to thousands of rows cannot fetch a reading per row up front, so this is built
 * to be driven by what is on screen rather than by the whole list.
 */
export function useSessionQuotaContexts(versionOf: (sessionId: string) => string) {
  const [contexts, setContexts] = useState<
    Record<string, SessionQuotaContext | null>
  >({});
  const settled = useRef(new Map<string, string>());
  const pending = useRef(new Map<string, string>());
  const failures = useRef(new Map<string, { version: string; attempts: number }>());
  const asked = useRef(new Set<string>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const versionRef = useRef(versionOf);
  versionRef.current = versionOf;

  const request = useCallback((sessionIds: string[]) => {
    sessionIds.forEach((sessionId) => sessionId && asked.current.add(sessionId));
    const missing = quotaContextsToFetch(sessionIds, versionRef.current, settled.current, pending.current);
    if (!missing.length) return;
    missing.forEach(({ sessionId, version }) => pending.current.set(sessionId, version));
    for (let start = 0; start < missing.length; start += batchSize) {
      const batch = missing.slice(start, start + batchSize);
      // A newer request for an id supersedes this one; its answer is then dropped.
      const current = () => batch.filter(({ sessionId, version }) => pending.current.get(sessionId) === version);
      void fetch("/api/session-quota-contexts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionIds: batch.map(({ sessionId }) => sessionId) }),
      })
        .then(async (response) => {
          if (!response.ok)
            throw new Error("Quota closing readings are unavailable");
          return (await response.json()) as {
            items?: Record<string, SessionQuotaContext | null>;
          };
        })
        .then((result) => {
          const answered = current();
          answered.forEach(({ sessionId, version }) => {
            pending.current.delete(sessionId);
            settled.current.set(sessionId, version);
            failures.current.delete(sessionId);
          });
          setContexts((previous) => ({
            ...previous,
            ...Object.fromEntries(
              answered.map(({ sessionId }) => [sessionId, result.items?.[sessionId] ?? null]),
            ),
          }));
        })
        // A failed batch records no reading rather than a wrong one: a row that has never had a
        // reading says one is unavailable, and a row that had one keeps it. Either way the batch
        // is asked for again shortly, because the failure may be temporary.
        .catch(() => {
          const failed = current();
          failed.forEach(({ sessionId }) => pending.current.delete(sessionId));
          setContexts((previous) => ({
            ...previous,
            ...Object.fromEntries(
              failed.filter(({ sessionId }) => !Object.hasOwn(previous, sessionId)).map(({ sessionId }) => [sessionId, null]),
            ),
          }));
          // Each reading version has its own retry budget. Group equal delays without letting
          // an exhausted session consume another session's retries.
          const retries = new Map<number, typeof failed>();
          for (const reading of failed) {
            const previous = failures.current.get(reading.sessionId);
            const attempt = previous?.version === reading.version ? previous.attempts : 0;
            failures.current.set(reading.sessionId, { version: reading.version, attempts: attempt + 1 });
            const delay = quotaRetryDelaysMs[attempt];
            if (delay === undefined) continue;
            const group = retries.get(delay) ?? [];
            group.push(reading);
            retries.set(delay, group);
          }
          for (const [delay, readings] of retries) {
            const timer = setTimeout(() => {
              timers.current.delete(timer);
              const currentIds = readings.filter(({ sessionId, version }) => versionRef.current(sessionId) === version)
                .map(({ sessionId }) => sessionId);
              request(currentIds);
            }, delay);
            timers.current.add(timer);
          }
        });
    }
  }, []);

  // A dashboard update can change the version of a row already on screen, such as the session
  // that is still running. Those rows are asked for again; unchanged ones are skipped.
  useEffect(() => {
    if (asked.current.size) request([...asked.current]);
  }, [versionOf, request]);
  useEffect(() => () => {
    timers.current.forEach(clearTimeout);
    timers.current.clear();
  }, []);

  /** Records a reading that arrived another way, such as inside a session detail response. */
  const store = useCallback((sessionId: string, context: SessionQuotaContext | null) => {
    asked.current.add(sessionId);
    settled.current.set(sessionId, versionRef.current(sessionId));
    pending.current.delete(sessionId);
    setContexts((previous) => ({ ...previous, [sessionId]: context }));
  }, []);

  return { contexts, request, store };
}
