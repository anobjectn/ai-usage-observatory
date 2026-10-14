import { useEffect, useState, type ReactNode } from "react";
import { CircleArrowUp, Info, LoaderCircle, RefreshCw, RotateCw, TriangleAlert } from "lucide-react";
import { jobActive, type UpdateUi } from "../hooks/use-update";
import type { UpdateCheck, UpdateGitState, UpdatePhase, UpdateStatus } from "../types";

const short = (sha: string | null | undefined) => sha?.slice(0, 7) ?? "unknown";
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const unsupportedText: Record<string, (check: UpdateCheck) => ReactNode> = {
  "unsupported/not-main": (check) => <>This checkout is on <code>{check.branch}</code>. Switch to <code>main</code> yourself to use in-app updates.</>,
  "unsupported/detached": () => <>HEAD is detached. Switch to <code>main</code> yourself to use in-app updates.</>,
  "unsupported/no-origin": () => <>This checkout has no <code>origin</code> remote.</>,
  "unsupported/not-git": () => "This copy is not a Git checkout. Download the new version manually.",
  "unsupported/no-git": () => "Git is not installed or not on PATH.",
  "unsupported/upstream-mismatch": (check) => <><code>main</code> tracks <code>{check.upstream}</code>, not <code>origin/main</code>.</>,
  "unsupported/shallow": () => <>This is a shallow clone. Run <code>git fetch --unshallow</code> first.</>,
  "unsupported/linked-worktree": () => "In-app updates work only in the main checkout, not in a linked worktree.",
  "unsupported/sparse-checkout": () => "Sparse checkouts are not supported.",
  "unsupported/submodules": () => "Checkouts with submodules are not supported.",
  "unsupported/no-commits": () => "This checkout has no commits.",
};

const failedText: Record<string, string> = {
  "failed/auth": "Git could not authenticate to origin. Check your SSH key or credentials, then check again.",
  "failed/network": "Git could not reach origin. Check the network connection, then check again.",
  "failed/timeout": "Fetching origin took longer than 60 seconds.",
  "failed/git-error": "Git reported an error during the check.",
  "failed/stale-check": "The checkout changed during the check. Check again.",
  "failed/no-remote-main": "origin has no main branch.",
};

const phaseText: Record<UpdatePhase, string> = {
  validating: "Validating", stopping: "Stopping the server", "backing-up": "Backing up the database",
  applying: "Applying the update", installing: "Installing dependencies", building: "Building the app",
  starting: "Starting the server", verifying: "Verifying the new version", complete: "Complete", failed: "Failed",
};

const gitStateText: Record<UpdateGitState, string> = {
  unchanged: "Your checkout was not changed. The previous version runs again.",
  target: "Your checkout is at the new version, but the update did not finish.",
  unexpected: "Your checkout is in an unexpected state. Do not retry; follow the recovery steps.",
  unknown: "The update could not confirm the state of your checkout. Follow the recovery steps.",
};

const recoveryNote = <p className="update-note">See README.md, section “Recover from a failed update”.</p>;

function Paths({ paths }: { paths: string[] }) {
  return paths.length ? <ul className="update-paths">{paths.map((path) => <li key={path}><code>{path}</code></li>)}</ul> : null;
}

function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{Math.max(0, Math.round((now - Date.parse(since)) / 1000))} s</>;
}

function manualCommands(status: UpdateStatus) {
  if (status.blockingReason === "dev") return <>This is the dev server. Run <code>git pull --ff-only &amp;&amp; bun install</code>; the dev server reloads.</>;
  if (status.blockingReason === "unmanaged") return <>Restart with <code>bun run start</code> to update in the app, or run <code>git pull --ff-only &amp;&amp; bun install &amp;&amp; bun run build</code>.</>;
  if (status.blockingReason === "remote-restricted") return "Updates can be applied only from this computer.";
  return null;
}

function CheckDetails({ check, status, onCheck }: { check: UpdateCheck; status: UpdateStatus | null; onCheck: () => void }) {
  const behind = check.relationship === "behind";
  const body: ReactNode = (() => {
    switch (check.state) {
      case "up-to-date": return <p>Up to date with <code>origin/main</code>.</p>;
      case "ahead": return <p>This checkout is {plural(check.ahead, "commit")} ahead of <code>origin/main</code>. There is nothing to update.</p>;
      case "diverged": return <p>Local <code>main</code> and <code>origin/main</code> have diverged ({check.ahead} ahead, {check.behind} behind). Update manually.</p>;
      case "dirty": return <><p>Uncommitted changes block the update. Commit or stash them, then check again.</p><Paths paths={check.paths} /></>;
      case "collision": return <><p>The update would overwrite these local files. Move them, then check again.</p><Paths paths={check.paths} /></>;
      case "git-busy": return <><p>A Git operation is in progress. Finish it, then check again.</p><Paths paths={check.paths} /></>;
      case "incompatible": return <p>This update needs a newer launcher. Run <code>git pull --ff-only &amp;&amp; bun install &amp;&amp; bun run build</code>, then restart <code>bun run start</code>.</p>;
      case "unsupported": return <p>{unsupportedText[check.reason ?? ""]?.(check) ?? check.reason}</p>;
      case "failed": return <><p>{failedText[check.reason ?? ""] ?? "The check failed."}</p><button className="update-inline-button" onClick={onCheck}>Check again</button></>;
      case "eligible": return <p>v{check.currentVersion} → v{check.targetVersion ?? "?"} · {plural(check.behind, "new commit")}</p>;
    }
  })();
  return (
    <>
      {body}
      {behind && check.incomingCommits.length > 0 && (
        <ul className="update-commits">
          {check.incomingCommits.map((commit) => <li key={commit.sha}><code>{short(commit.sha)}</code> {commit.subject}</li>)}
        </ul>
      )}
      {behind && (check.dependenciesChanged || check.migrationsChanged || check.launcherChanged) && (
        <p className="update-note">
          {[check.dependenciesChanged && "Dependencies change.", check.migrationsChanged && "The database schema changes; a backup is made first.", check.launcherChanged && "The launcher changes; restart bun run start once afterward."].filter(Boolean).join(" ")}
        </p>
      )}
      {check.dirty && check.state !== "dirty" && <p className="update-note">Uncommitted changes: {check.paths.slice(0, 3).join(", ")}</p>}
      {check.eligible && status && !status.canApply && <p className="update-note">{manualCommands(status)}</p>}
      <p className="update-meta">
        {check.remoteDisplay && <>origin {check.remoteDisplay} · </>}checked {new Date(check.checkedAt).toLocaleTimeString()}
      </p>
    </>
  );
}

function Details({ update }: { update: UpdateUi }) {
  const { status, check, error, reconnecting, lostContact } = update;
  const job = status?.job ?? null;
  const active = jobActive(job);
  return (
    <div className="update-details" id="update-details" role="region" aria-label="Update details">
      {status?.schemaAhead && (
        <p className="update-warning"><TriangleAlert aria-hidden="true" /> A newer version wrote this database. This version keeps running; some data may be missing. {status.backupPath && <>Backup: <code>{status.backupPath}</code></>}</p>
      )}
      {error && <p className="update-warning">{error}</p>}
      {lostContact && <p className="update-warning">Lost contact with the server. The update may still run. Reload this page in a minute.</p>}
      {active && job && (
        <>
          <p><b>{reconnecting ? "Restarting — reconnecting" : phaseText[job.phase]}</b> · <Elapsed since={job.startedAt} /></p>
          <p className="update-note">Updating to <code>{short(job.target)}</code>. The page reloads when the new version is ready.</p>
        </>
      )}
      {!active && job?.phase === "failed" && (
        <>
          <p><b>The update stopped at {phaseText[job.failedPhase ?? "failed"].toLowerCase()}.</b> {job.failure?.message}</p>
          <p>{gitStateText[job.gitState]}</p>
          {job.backupPath && <p className="update-note">Database backup: <code>{job.backupPath}</code></p>}
          {job.failure && job.failure.logTail.length > 0 && <pre className="update-log">{job.failure.logTail.join("\n")}</pre>}
          {job.retryable && <button className="update-inline-button" onClick={() => void update.retry()}>Retry</button>}
          {!job.retryable && job.gitState !== "unchanged" && recoveryNote}
        </>
      )}
      {!active && job?.phase === "complete" && !check?.eligible && (
        <p>Updated to <code>{short(job.target)}</code>.{status?.launcherRestartRequired && <> Restart <code>bun run start</code> once to load the new launcher.</>}</p>
      )}
      {update.reloadNeeded && <p>A new version is running. <button className="update-inline-button" onClick={update.reload}>Reload to finish</button></p>}
      {!active && check && <CheckDetails check={check} status={status} onCheck={() => void update.runCheck()} />}
      {!active && !check && !job && !error && <p>{update.checking ? "Checking origin/main…" : "No check yet."}</p>}
    </div>
  );
}

/** One sidebar button beside the version. A click checks, or, after an eligible check, updates.
 * The details toggle never starts an update. */
export function UpdateControl({ update, variant = "sidebar" }: { update: UpdateUi; variant?: "sidebar" | "boot" }) {
  const { status, check } = update;
  const eligible = Boolean(check?.eligible && status?.canApply);
  const label = update.updating
    ? "Updating…"
    : update.checking
      ? "Checking…"
      : update.reloadNeeded
        ? "Reload to finish"
        : eligible
          ? "Update and restart"
          : "Check for updates";
  const Icon = update.updating || update.checking ? LoaderCircle : eligible ? CircleArrowUp : update.reloadNeeded ? RotateCw : RefreshCw;
  const live = update.updating && status?.job
    ? (update.reconnecting ? "Restarting — reconnecting" : `Updating: ${phaseText[status.job.phase]}`)
    : update.checking ? "Checking for updates" : check ? `Update check: ${check.state}` : "";
  const onClick = () => {
    if (update.reloadNeeded) update.reload();
    else if (eligible) void update.apply();
    else void update.runCheck();
  };
  if (variant === "boot" && !status?.job && !status?.schemaAhead) return null;
  return (
    <div className={`update-control update-control-${variant}${eligible ? " is-eligible" : ""}`}>
      <div className="update-control-row" role="group" aria-label="Updates">
        <button
          className="update-button"
          onClick={onClick}
          disabled={update.updating || update.checking}
          aria-describedby={update.open ? "update-details" : undefined}
          data-tooltip={label}
        >
          <Icon className={update.updating || update.checking ? "is-spinning" : undefined} aria-hidden="true" />
          <span>{label}</span>
        </button>
        <button
          className="update-details-toggle"
          onClick={() => update.setOpen(!update.open)}
          aria-expanded={update.open}
          aria-controls="update-details"
          aria-label="Update details"
        >
          {status?.schemaAhead ? <TriangleAlert aria-hidden="true" /> : <Info aria-hidden="true" />}
        </button>
      </div>
      <span className="sr-only" aria-live="polite">{live}</span>
      {(update.open || variant === "boot") && <Details update={update} />}
    </div>
  );
}
