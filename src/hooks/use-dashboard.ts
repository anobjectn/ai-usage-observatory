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
  // Requests are numbered as they start. The connection banner follows the newest request that
  // has finished, so a slow older request that fails cannot raise it after a newer one succeeded,
  // and an older success cannot clear a newer failure.
  const requestsStarted = useRef(0);
  const newestFinished = useRef(0);
  const finish = (request: number) => {
    if (request < newestFinished.current) return false;
    newestFinished.current = request;
    return true;
  };
  const load = async (refresh = false, background = false) => {
    // Background polls stay silent: no "Collecting" spinner, and none of the app-wide
    // re-renders that toggling `loading` would force on every tick.
    // A standing error is cleared only by a response, so the connection banner stays up
    // through a retry instead of flickering away and back.
    if (!background) setLoading(true);
    const request = ++requestsStarted.current;
    try {
      if (refresh) {
        const refreshed = await fetch("/api/refresh", { method: "POST" });
        if (!refreshed.ok) throw new Error(`Server returned ${refreshed.status}`);
      }
      const response = await fetch("/api/dashboard", {
        headers: dashboardEtag.current ? { "If-None-Match": dashboardEtag.current } : undefined,
      });
      if (response.status === 304) {
        setLastSuccessAt(Date.now());
        if (finish(request)) setError(null);
        return;
      }
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      dashboardEtag.current = response.headers.get("ETag");
      const next = shareStructure(latest.current, (await response.json()) as DashboardData);
      latest.current = next;
      const newest = finish(request);
      // Committing in a transition lets React time-slice the tree-wide re-render instead of
      // blocking the main thread for the whole update.
      startTransition(() => {
        setData(next);
        if (newest) setError(null);
        setLastSuccessAt(Date.now());
      });
    } catch (reason) {
      if (finish(request)) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!background) setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(false, true), 60_000);
    return () => clearInterval(timer);
  }, []);
  return { data, error, loading, load, lastSuccessAt };
}
