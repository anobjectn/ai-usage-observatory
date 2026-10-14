import { useCallback, useEffect, useRef, useState } from "react";
import type { UpdateCheck, UpdateJob, UpdateStatus } from "../types";

export const updateJobDeadlineMs = 15 * 60_000;
export const updatePollMs = 1000;
export const updateBackoffMs = 3000;
const reloadedKey = "usage-observatory:update-reloaded";

type Options = {
  fetch?: typeof fetch;
  reload?: () => void;
  storage?: Pick<Storage, "getItem" | "setItem">;
  appCommit?: string | null;
  hostname?: string;
};

export type UpdateUi = ReturnType<typeof useUpdate>;

const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const postHeaders = { "Content-Type": "application/json", "X-Observatory-Action": "update" };
export const jobActive = (job: UpdateJob | null | undefined) => Boolean(job && job.phase !== "complete" && job.phase !== "failed");
const bundleCommit = () => (typeof __APP_COMMIT__ === "undefined" ? null : __APP_COMMIT__);

async function readError(response: Response) {
  const body = await response.json().catch(() => null) as { message?: string; error?: string } | null;
  return body?.message ?? body?.error ?? `Server returned ${response.status}`;
}

/** Update status, checks, and the job poll. Mounted before the dashboard loads, so a failed or
 * running update is visible even when `/api/dashboard` is down. */
export function useUpdate(options: Options = {}) {
  const request = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const reload = options.reload ?? (() => window.location.reload());
  const storage = options.storage ?? window.sessionStorage;
  const appCommit = options.appCommit === undefined ? bundleCommit() : options.appCommit;
  const hostname = options.hostname ?? window.location.hostname;
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [polling, setPolling] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [lostContact, setLostContact] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const pollStarted = useRef(0);
  const sawActiveJob = useRef(false);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const accept = useCallback((next: UpdateStatus) => {
    setStatus(next);
    if (next.check) setCheck(next.check);
    if (jobActive(next.job)) sawActiveJob.current = true;
    // Reload once into the new bundle. The job id guards against a reload loop.
    if (next.job?.phase === "complete" && sawActiveJob.current && storage.getItem(reloadedKey) !== next.job.id) {
      storage.setItem(reloadedKey, next.job.id);
      reload();
    }
    return next;
  }, [reload, storage]);

  const loadStatus = useCallback(async () => {
    const response = await request("/api/update/status", { cache: "no-store" });
    if (!response.ok) throw new Error(await readError(response));
    return accept(await response.json() as UpdateStatus);
  }, [accept, request]);

  /** Polls every second while a job runs. A network error is a restart, not a failure. */
  const poll = useCallback(() => {
    clearTimeout(timer.current);
    if (!pollStarted.current) pollStarted.current = Date.now();
    setPolling(true);
    const tick = async () => {
      if (!mounted.current) return;
      if (Date.now() - pollStarted.current > updateJobDeadlineMs) {
        setPolling(false);
        setLostContact(true);
        return;
      }
      let delay = updatePollMs;
      try {
        const next = await loadStatus();
        setReconnecting(false);
        if (!jobActive(next.job)) {
          setPolling(false);
          pollStarted.current = 0;
          return;
        }
      } catch {
        setReconnecting(true);
        delay = updateBackoffMs;
      }
      timer.current = setTimeout(tick, delay);
    };
    void tick();
  }, [loadStatus]);

  const runCheck = useCallback(async (background = false) => {
    if (!background) setOpen(true);
    setChecking(true);
    setError(null);
    try {
      const response = await request("/api/update/check", { method: "POST", headers: postHeaders, body: "{}" });
      if (response.status === 409) { poll(); return; }
      if (!response.ok) throw new Error(await readError(response));
      setCheck(await response.json() as UpdateCheck);
      await loadStatus().catch(() => undefined);
    } catch (reason) {
      if (!background) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setChecking(false);
    }
  }, [loadStatus, poll, request]);

  const apply = useCallback(async () => {
    if (!check) return;
    setStarting(true);
    setError(null);
    setLostContact(false);
    sawActiveJob.current = true;
    try {
      const response = await request("/api/update/apply", { method: "POST", headers: postHeaders, body: JSON.stringify({ checkId: check.id }) });
      if (response.status === 202) { poll(); return; }
      setError(await readError(response));
      setOpen(true);
    } catch {
      // A lost `202` is recovered from the job in `status`.
      poll();
    } finally {
      setStarting(false);
    }
  }, [check, poll, request]);

  const retry = useCallback(async () => {
    const job = status?.job;
    if (!job) return;
    setError(null);
    sawActiveJob.current = true;
    try {
      const response = await request("/api/update/retry", { method: "POST", headers: postHeaders, body: JSON.stringify({ jobId: job.id }) });
      if (response.status !== 202) { setError(await readError(response)); return; }
    } catch { /* Polling below reports the outcome. */ }
    poll();
  }, [poll, request, status?.job]);

  useEffect(() => {
    mounted.current = true;
    void (async () => {
      try {
        const first = await loadStatus();
        if (jobActive(first.job) || first.maintenance) poll();
        else if (first.autoCheckDue && loopbackHosts.has(hostname)) void runCheck(true);
      } catch (reason) {
        // No answer at all: the server may be restarting into an update. Poll until it answers.
        if (reason instanceof TypeError) poll();
      }
    })();
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
    // Runs once per mount.
  }, []);

  const running = status?.running?.commit ?? null;
  const reloadNeeded = status?.mode === "prod" && !jobActive(status.job) && Boolean(appCommit && running && appCommit !== running);
  return {
    status, check, checking, starting, polling, reconnecting, lostContact, error, open, setOpen,
    runCheck, apply, retry, reloadNeeded, reload,
    updating: starting || jobActive(status?.job),
  };
}
