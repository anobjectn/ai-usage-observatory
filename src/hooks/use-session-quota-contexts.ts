import { useCallback, useRef, useState } from "react";
import type { SessionQuotaContext } from "../types";

/** The endpoint answers at most this many ids per request, so longer asks are split. */
const batchSize = 25;

/** Closing account-quota readings for sessions, fetched on demand and remembered. Callers ask for
 * the ids they are about to show; an id already fetched or in flight is never asked for twice.
 *
 * A list that runs to thousands of rows cannot fetch a reading per row up front, so this is built
 * to be driven by what is on screen rather than by the whole list.
 */
export function useSessionQuotaContexts() {
  const [contexts, setContexts] = useState<
    Record<string, SessionQuotaContext | null>
  >({});
  const asked = useRef(new Set<string>());
  const request = useCallback((sessionIds: string[]) => {
    const missing = sessionIds.filter(
      (sessionId) => sessionId && !asked.current.has(sessionId),
    );
    if (!missing.length) return;
    missing.forEach((sessionId) => asked.current.add(sessionId));
    for (let start = 0; start < missing.length; start += batchSize) {
      const batch = missing.slice(start, start + batchSize);
      void fetch("/api/session-quota-contexts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionIds: batch }),
      })
        .then(async (response) => {
          if (!response.ok)
            throw new Error("Quota closing readings are unavailable");
          return (await response.json()) as {
            items?: Record<string, SessionQuotaContext | null>;
          };
        })
        .then((result) => {
          setContexts((current) => ({
            ...current,
            ...Object.fromEntries(
              batch.map((sessionId) => [
                sessionId,
                result.items?.[sessionId] ?? null,
              ]),
            ),
          }));
        })
        // A batch that fails records no reading rather than a wrong one; the cell then says a
        // reading is unavailable, which is what happened.
        .catch(() => {
          setContexts((current) => ({
            ...current,
            ...Object.fromEntries(
              batch.map((sessionId) => [sessionId, null]),
            ),
          }));
        });
    }
  }, []);
  return { contexts, request };
}
