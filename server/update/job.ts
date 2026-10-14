import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { UpdateCheck, UpdateGitState, UpdateJob, UpdatePhase } from "../../src/types";
import { execCommand } from "../subprocess";
import { backupDatabase, newestBackup, pruneBackups } from "./backup";
import { autoCheckDue, readJson, recordCheckAt, redactCredentials, writeFileAtomic } from "./files";
import { gitBusyMarkers, gitTimeouts, inspectRepository, readHead, reconcileGitState, runGit, trackedChanges, updaterProtocol, type CheckRecord, type GitOptions } from "./git";

export const jobDeadlineMs = 15 * 60_000;
export const stepTimeouts = { install: 5 * 60_000, build: 5 * 60_000, readiness: 90_000 };
const keepLogs = 5;
const tailLines = 40;

export type ServerHandle = { pid: number; bootId: string; exited: Promise<number | null>; stderrTail: () => string[] };
export type StepResult = { ok: boolean; message: string };
export type UpdaterDeps = {
  root: string;
  stateDir: string;
  dbPath: string;
  port: number;
  git?: GitOptions;
  /** `bun install` and `vite build`; tests inject a fake. */
  runStep: (step: "install" | "build", log: (text: string) => void) => Promise<StepResult>;
  server: { stop: () => Promise<void>; start: (bootId: string) => Promise<ServerHandle>; running: () => boolean };
  maintenance: { bind: () => Promise<void>; release: () => Promise<void>; bound: () => boolean };
  verify: (handle: ServerHandle, target: string) => Promise<StepResult>;
  portFree: () => Promise<boolean>;
  hooks?: { beforeMerge?: () => void | Promise<void>; beforeStart?: () => Promise<void> };
  now?: () => Date;
};
export type UpdaterReply = { status: number; body: unknown };

const terminal = (phase: UpdatePhase) => phase === "complete" || phase === "failed";
const jobFile = (stateDir: string) => join(stateDir, "update-job.json");
const logDirectory = (stateDir: string) => join(stateDir, "update-logs");

class JobFailure extends Error {
  constructor(readonly code: string, message: string, readonly options: { gitState?: UpdateGitState; retryable?: boolean; restartOld?: boolean } = {}) { super(message); }
}

/** Owns the latest check and the single update job. Runs inside the launcher, which keeps no other
 * reference to updated code while a job runs. */
export class Updater {
  check: CheckRecord | null = null;
  job: UpdateJob | null = null;
  private checking: Promise<UpdateCheck> | null = null;
  private validating: Promise<UpdaterReply> | null = null;
  private running: Promise<void> | null = null;
  private logLines: string[] = [];

  constructor(private readonly deps: UpdaterDeps) {}

  private now() { return this.deps.now?.() ?? new Date(); }
  jobActive() { return Boolean(this.job && !terminal(this.job.phase)); }
  /** Resolves when the background part of the current job ends. */
  settled() { return this.running ?? Promise.resolve(); }

  status() {
    const job = this.job;
    const now = this.now().getTime();
    const check = this.check?.check ?? null;
    const checkExpiresAt = check ? Date.parse(check.expiresAt) : Number.NaN;
    const checkExpired = Boolean(check && (!Number.isFinite(checkExpiresAt) || checkExpiresAt <= now));
    return {
      // An expired check no longer describes the checkout or origin. Hide it and let the
      // client trigger a fresh check instead of continuing to report a stale ahead/behind count.
      check: checkExpired ? null : check,
      job,
      backupPath: job?.backupPath ?? newestBackup(this.deps.stateDir),
      autoCheckDue: checkExpired || autoCheckDue(this.deps.stateDir, now),
      launcherRestartRequired: job?.phase === "complete" && job.launcherRestartRequired,
    };
  }

  async runCheck(): Promise<UpdaterReply> {
    if (this.jobActive()) return { status: 409, body: { error: "job-active", message: "An update is running" } };
    this.checking ??= inspectRepository(this.deps.root, { ...this.deps.git, fetch: true, dbPath: this.deps.dbPath, now: () => this.now() })
      .then((record) => {
        this.check = record;
        recordCheckAt(this.deps.stateDir, this.now());
        return record.check;
      })
      .finally(() => { this.checking = null; });
    return { status: 200, body: await this.checking };
  }

  /** Validates synchronously with the request, persists the job, and only then answers `202`. The
   * same `checkId` always names the same job. */
  async apply(checkId: string): Promise<UpdaterReply> {
    if (this.job?.checkId === checkId) return { status: 202, body: { job: this.job } };
    if (this.validating) {
      const reply = await this.validating;
      if (this.job?.checkId === checkId) return { status: 202, body: { job: this.job } };
      return reply.status === 202 ? { status: 409, body: { error: "busy", message: "Another update started" } } : this.apply(checkId);
    }
    if (this.jobActive()) return { status: 409, body: { error: "busy", message: "An update is running" } };
    this.validating = this.validate(checkId).finally(() => { this.validating = null; });
    return this.validating;
  }

  private async validate(checkId: string): Promise<UpdaterReply> {
    const record = this.check;
    if (!record || record.check.id !== checkId) return { status: 409, body: { error: "stale", message: "Check again before updating" } };
    const check = record.check;
    if (Date.parse(check.expiresAt) <= this.now().getTime()) return { status: 409, body: { error: "stale", message: "The check expired. Check again." } };
    if (!check.eligible || !check.head || !check.target) return { status: 422, body: { error: "ineligible", message: `This checkout cannot update: ${check.reason ?? check.state}` } };
    const failure = await this.revalidate(record);
    if (failure) return { status: 409, body: { error: "stale", message: failure } };
    const at = this.now().toISOString();
    this.job = {
      id: randomUUID(), checkId, from: check.head, target: check.target, phase: "validating", gitState: "unchanged",
      installComplete: false, buildComplete: false, startupAttempted: false, launcherRestartRequired: check.launcherChanged,
      startedAt: at, updatedAt: at, retryable: false,
    };
    this.pruneLogs();
    this.logLines = [];
    this.log(`Update ${check.head} -> ${check.target}`);
    this.persist();
    this.running = this.execute(this.job).finally(() => { this.running = null; });
    return { status: 202, body: { job: this.job } };
  }

  /** The checked target, unchanged checkout, and remote, without a new fetch. */
  private async revalidate(record: CheckRecord) {
    const current = await inspectRepository(this.deps.root, { ...this.deps.git, fetch: false, pinnedTarget: record.check.target!, dbPath: this.deps.dbPath, now: () => this.now() });
    if (current.check.state !== "eligible") return `The checkout changed since the check: ${current.check.reason ?? current.check.state}`;
    if (current.check.head !== record.check.head) return "HEAD moved since the check";
    if (current.remoteUrl !== record.remoteUrl) return "The origin remote changed since the check";
    return null;
  }

  async retry(jobId: string): Promise<UpdaterReply> {
    const job = this.job;
    if (!job || job.id !== jobId) return { status: 409, body: { error: "not-retryable", message: "No such update" } };
    if (this.jobActive() || this.validating) return { status: 409, body: { error: "busy", message: "An update is running" } };
    if (job.phase !== "failed" || !job.retryable || job.gitState !== "target") return { status: 409, body: { error: "not-retryable", message: "This update cannot be retried" } };
    const state = await reconcileGitState(this.deps.root, job.from, job.target, this.deps.git);
    const busy = await gitBusyMarkers(this.deps.root, this.deps.git).catch(() => ["unknown"]);
    if (state !== "target" || busy.length) return { status: 409, body: { error: "not-retryable", message: "HEAD, the working tree, or a Git operation changed. See the README recovery section." } };
    const resume: UpdatePhase = !job.installComplete ? "installing" : !job.buildComplete ? "building" : "starting";
    Object.assign(job, { phase: "validating" as UpdatePhase, failedPhase: undefined, failure: undefined, finishedAt: undefined, retryable: false });
    this.log(`Retry from ${resume}`);
    this.persist();
    this.running = this.resume(job, resume).finally(() => { this.running = null; });
    return { status: 202, body: { job } };
  }

  /** A launcher restart never resumes a job: an unfinished one becomes `failed/interrupted`. */
  async recover() {
    const saved = readJson<{ version: number; job: UpdateJob }>(jobFile(this.deps.stateDir));
    if (saved?.version !== 1 || !saved.job) return;
    const job = saved.job;
    if (!terminal(job.phase)) {
      job.gitState = await reconcileGitState(this.deps.root, job.from, job.target, this.deps.git);
      job.failedPhase = job.phase;
      job.phase = "failed";
      job.retryable = job.gitState === "target";
      job.failure = { code: "interrupted", message: "The launcher stopped while this update ran", logTail: [] };
      job.finishedAt = this.now().toISOString();
    }
    // This launcher started after the update, so it already runs the updated launcher code.
    job.launcherRestartRequired = false;
    this.job = job;
    this.persist();
  }

  private persist() {
    if (!this.job) return;
    this.job.updatedAt = this.now().toISOString();
    writeFileAtomic(jobFile(this.deps.stateDir), JSON.stringify({ version: 1, job: this.job }, null, 2));
  }

  private log(text: string) {
    const clean = redactCredentials(text);
    for (const line of clean.split("\n")) if (line.trim()) this.logLines.push(line);
    if (this.logLines.length > 400) this.logLines.splice(0, this.logLines.length - 400);
    if (!this.job) return;
    try {
      mkdirSync(logDirectory(this.deps.stateDir), { recursive: true });
      appendFileSync(join(logDirectory(this.deps.stateDir), `${this.job.id}.log`), clean.endsWith("\n") ? clean : `${clean}\n`);
    } catch { /* The in-memory tail still reaches the UI. */ }
  }

  private pruneLogs() {
    const directory = logDirectory(this.deps.stateDir);
    if (!existsSync(directory)) return;
    const logs = readdirSync(directory).filter((name) => name.endsWith(".log")).map((name) => join(directory, name))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
    for (const path of logs.slice(keepLogs - 1)) rmSync(path, { force: true });
  }

  private phase(job: UpdateJob, phase: UpdatePhase) {
    job.phase = phase;
    this.log(`Phase: ${phase}`);
    this.persist();
  }

  private fail(job: UpdateJob, failure: JobFailure, extraTail: string[] = []) {
    job.failedPhase = job.phase;
    job.phase = "failed";
    if (failure.options.gitState) job.gitState = failure.options.gitState;
    job.retryable = failure.options.retryable === true && job.gitState === "target";
    this.log(`Failed: ${failure.code}: ${failure.message}`);
    job.failure = { code: failure.code, message: redactCredentials(failure.message), logTail: [...this.logLines, ...extraTail.map(redactCredentials)].slice(-tailLines) };
    job.finishedAt = this.now().toISOString();
    this.persist();
  }

  /** Puts the previous server back after a failure that left Git unchanged. */
  private async restartOld() {
    try {
      if (this.deps.maintenance.bound()) await this.deps.maintenance.release();
      await this.deps.server.start(randomUUID());
      this.log("Restarted the previous server");
    } catch (error) {
      this.log(`Could not restart the previous server: ${error instanceof Error ? error.message : String(error)}`);
      await this.deps.maintenance.bind().catch(() => undefined);
    }
  }

  private async execute(job: UpdateJob) {
    try {
      this.phase(job, "stopping");
      await this.deps.server.stop();
      try { await this.deps.maintenance.bind(); }
      catch (error) { throw new JobFailure("maintenance-bind", `The maintenance page could not use the port: ${String(error)}`, { gitState: "unchanged", restartOld: true }); }

      this.phase(job, "backing-up");
      try {
        job.backupPath = backupDatabase(this.deps.dbPath, this.deps.stateDir, job.from, this.now()) ?? undefined;
        this.log(job.backupPath ? `Backup: ${job.backupPath}` : "No database to back up");
        pruneBackups(this.deps.stateDir, [job.backupPath]);
      } catch (error) {
        throw new JobFailure("backup-failed", error instanceof Error ? error.message : String(error), { gitState: "unchanged", restartOld: true });
      }

      this.phase(job, "applying");
      const record = this.check;
      const stale = record && record.check.id === job.checkId ? await this.revalidate(record) : "The check was replaced";
      if (stale) throw new JobFailure("stale", stale, { gitState: "unchanged", restartOld: true });
      await this.deps.hooks?.beforeMerge?.();
      const merge = await runGit(this.deps.root, ["merge", "--ff-only", "--no-edit", "--no-autostash", "--no-overwrite-ignore", job.target], { ...this.deps.git, timeoutMs: gitTimeouts.merge });
      this.log(merge.stdout + merge.stderr);
      // Whatever the exit status, HEAD and the tree decide what happened.
      job.gitState = await reconcileGitState(this.deps.root, job.from, job.target, this.deps.git);
      this.persist();
      if (job.gitState === "unchanged") {
        throw new JobFailure(merge.timedOut ? "merge-timeout" : "merge-failed", redactCredentials(merge.stderr.trim()) || "Git did not move HEAD", { restartOld: true });
      }
      if (job.gitState !== "target") throw new JobFailure(merge.timedOut ? "merge-timeout" : "merge-unexpected", "HEAD or the working tree is not at the checked target. See the README recovery section.");
      await this.continueFrom(job, "installing");
    } catch (error) {
      await this.handleFailure(job, error);
    }
  }

  private async resume(job: UpdateJob, from: UpdatePhase) {
    try {
      if (this.deps.server.running()) await this.deps.server.stop();
      if (!this.deps.maintenance.bound()) await this.deps.maintenance.bind().catch((error) => this.log(`Maintenance page unavailable: ${String(error)}`));
      await this.continueFrom(job, from);
    } catch (error) {
      await this.handleFailure(job, error);
    }
  }

  private async handleFailure(job: UpdateJob, error: unknown) {
    const failure = error instanceof JobFailure ? error : new JobFailure("internal", error instanceof Error ? error.message : String(error), { retryable: job.gitState === "target" });
    this.fail(job, failure, (failure as JobFailure & { tail?: string[] }).tail);
    if (failure.options.restartOld && job.gitState === "unchanged") await this.restartOld();
    else if (!this.deps.server.running() && !this.deps.maintenance.bound()) await this.deps.maintenance.bind().catch(() => undefined);
  }

  /** HEAD is still the target, the tree is clean, and no Git operation started. */
  private async assertAtTarget(job: UpdateJob) {
    const { branch, head } = await readHead(this.deps.root, this.deps.git);
    const changes = await trackedChanges(this.deps.root, this.deps.git);
    const busy = await gitBusyMarkers(this.deps.root, this.deps.git);
    if (branch === "main" && head === job.target && changes.length === 0 && busy.length === 0) return;
    job.gitState = "unexpected";
    throw new JobFailure("drift", "HEAD, the working tree, or a Git operation changed during the update");
  }

  private async continueFrom(job: UpdateJob, from: UpdatePhase) {
    const order: UpdatePhase[] = ["installing", "building", "starting"];
    for (const step of order.slice(order.indexOf(from))) {
      this.phase(job, step);
      await this.assertAtTarget(job);
      if (step === "installing" || step === "building") {
        const kind = step === "installing" ? "install" : "build";
        const result = await this.deps.runStep(kind, (text) => this.log(text));
        if (!result.ok) throw new JobFailure(`${kind}-failed`, result.message, { retryable: true });
        if (kind === "install") job.installComplete = true;
        else job.buildComplete = true;
        this.persist();
        continue;
      }
      if (this.deps.maintenance.bound()) await this.deps.maintenance.release();
      await this.deps.hooks?.beforeStart?.();
      if (!(await this.deps.portFree())) {
        throw new JobFailure("port-in-use", `Port ${this.deps.port} is used by another process. Stop it, then retry.`, { retryable: true });
      }
      job.startupAttempted = true;
      const handle = await this.deps.server.start(randomUUID());
      this.phase(job, "verifying");
      const exited = handle.exited.then((code) => ({ ok: false, message: `The new server exited with ${code}` }));
      const verified = await Promise.race([this.deps.verify(handle, job.target), exited]);
      if (!verified.ok) {
        if (this.deps.server.running()) await this.deps.server.stop();
        const failure = new JobFailure("startup-failed", verified.message, { retryable: true }) as JobFailure & { tail?: string[] };
        failure.tail = handle.stderrTail();
        throw failure;
      }
      await this.assertAtTarget(job);
      job.phase = "complete";
      job.finishedAt = this.now().toISOString();
      this.log("Update complete");
      this.persist();
    }
  }
}

/** The real install and build. Both run in their own process group, so a deadline also stops
 * the tools they spawn. */
export function defaultRunStep(root: string): UpdaterDeps["runStep"] {
  return async (step, log) => {
    const command = step === "install"
      ? [process.execPath, "install", "--frozen-lockfile"]
      : [process.execPath, join(root, "node_modules", "vite", "bin", "vite.js"), "build"];
    const timeoutMs = step === "install" ? stepTimeouts.install : stepTimeouts.build;
    log(`$ ${step === "install" ? "bun install --frozen-lockfile" : "vite build"}`);
    const result = await execCommand(command, { cwd: root, timeoutMs, processGroup: true, maxOutput: 256 * 1024, onOutput: (text) => log(text) });
    if (result.timedOut) return { ok: false, message: `${step} timed out after ${timeoutMs / 60_000} minutes` };
    if (result.code !== 0) return { ok: false, message: `${step} exited with ${result.code}` };
    return { ok: true, message: "" };
  };
}

/** Ready means: this child answers with the target commit and its own boot id, and the build
 * stamp matches. It does not wait for data collection. */
export function defaultVerify(root: string, port: number, deadlineMs = stepTimeouts.readiness): UpdaterDeps["verify"] {
  return async (handle, target) => {
    const deadline = Date.now() + deadlineMs;
    let last = "no answer";
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/update/version`, { signal: AbortSignal.timeout(3000) });
        if (response.ok) {
          const version = await response.json() as { commit?: string; bootId?: string; pid?: number; protocol?: number };
          if (version.bootId === handle.bootId && version.pid === handle.pid && version.commit === target && version.protocol === updaterProtocol) {
            const stamp = readJson<{ commit?: string }>(join(root, "dist", "build-info.json"));
            if (stamp?.commit === target) return { ok: true, message: "" };
            last = `dist/build-info.json names ${stamp?.commit ?? "no commit"}`;
          } else last = `the server reported commit ${version.commit ?? "unknown"}`;
        } else last = `HTTP ${response.status}`;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      await Bun.sleep(500);
    }
    return { ok: false, message: `The new server was not ready within ${deadlineMs / 1000} s (${last})` };
  };
}

export async function portIsFree(port: number) {
  try {
    const listener = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    listener.stop(true);
    return true;
  } catch {
    return false;
  }
}
