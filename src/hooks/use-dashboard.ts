import { startTransition, useEffect, useRef, useState } from "react";
import type { DashboardData } from "../types";
import { shareStructure } from "../app/analytics";


export function useDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Wall-clock time of the last response the server answered, `304` included.
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  const dashboardEtag = useRef<string | null>(null);
  const latest = useRef<DashboardData | null>(null);
  // Dashboard reads are numbered as they are sent, after any refresh POST, so a refresh that spent
  // its time collecting still counts as newer than a poll sent meanwhile. Only the newest read that
  // has finished is applied: an older read finishing later changes neither the data, the ETag nor
  // the connection banner.
  const readsStarted = useRef(0);
  const newestFinished = useRef(0);
  const finish = (read: number) => {
    if (read < newestFinished.current) return false;
    newestFinished.current = read;
    return true;
  };
  // Foreground loads can overlap; the "Collecting" spinner stays up until the last one ends.
  const foregroundLoads = useRef(0);
  const load = async (refresh = false, background = false) => {
    // Background polls stay silent: no "Collecting" spinner, and none of the app-wide
    // re-renders that toggling `loading` would force on every tick.
    // A standing error is cleared only by a response, so the connection banner stays up
    // through a retry instead of flickering away and back.
    if (!background) {
      foregroundLoads.current += 1;
      setLoading(true);
    }
    let read = 0;
    try {
      if (refresh) {
        const refreshed = await fetch("/api/refresh", { method: "POST" });
        if (!refreshed.ok) throw new Error(`Server returned ${refreshed.status}`);
      }
      read = ++readsStarted.current;
      const response = await fetch("/api/dashboard", {
        headers: dashboardEtag.current ? { "If-None-Match": dashboardEtag.current } : undefined,
      });
      if (response.status === 304) {
        setLastSuccessAt(Date.now());
        if (finish(read)) setError(null);
        return;
      }
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      const body = (await response.json()) as DashboardData;
      if (!finish(read)) return;
      dashboardEtag.current = response.headers.get("ETag");
      const next = shareStructure(latest.current, body);
      latest.current = next;
      // Committing in a transition lets React time-slice the tree-wide re-render instead of
      // blocking the main thread for the whole update.
      startTransition(() => {
        setData(next);
        setError(null);
        setLastSuccessAt(Date.now());
      });
    } catch (reason) {
      // A failed refresh POST never sent a read. It still takes the newest number, so the
      // failure shows even when a poll finished while collection was running.
      if (finish(read || ++readsStarted.current)) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!background && --foregroundLoads.current === 0) setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(false, true), 60_000);
    return () => clearInterval(timer);
  }, []);
  return { data, error, loading, load, lastSuccessAt };
}
