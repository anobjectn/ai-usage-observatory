import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Subprocess } from "bun";
import type { UpdateCheck, UpdateJob, UpdateStatus } from "../../src/types";
import { fixtureGitEnv, git } from "./test-fixtures";

/** Real launcher, real `bun install --frozen-lockfile`, and real `vite build` in a temporary clone
 * of this working tree. Opt in with USAGE_OBSERVATORY_E2E=1; it takes about a minute. */
const enabled = process.env.USAGE_OBSERVATORY_E2E === "1";
const sourceRoot = join(import.meta.dir, "..", "..");
const timeout = 600_000;

let directory = "";
let work = "";
let upstream = "";
let port = 0;
let launcher: Subprocess | null = null;
let sentinel: Subprocess | null = null;
const failFlag = () => join(directory, "fail-start.flag");
const holdFile = () => join(directory, "hold-start.flag");

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as import("node:net").AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function run(cwd: string, command: string[]) {
  const result = Bun.spawnSync(command, { cwd, env: fixtureGitEnv, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")}: ${result.stderr.toString()}`);
}

/** Pushes one commit from the upstream clone and returns its sha. */
function push(change: (root: string) => void, message: string) {
  change(upstream);
  git(upstream, "add", "-A");
  git(upstream, "commit", "-q", "--no-gpg-sign", "-m", message);
  git(upstream, "push", "-q", "origin", "main");
  return git(upstream, "rev-parse", "HEAD");
}

const bumpVersion = (version: string) => (root: string) => {
  const path = join(root, "package.json");
  writeFileSync(path, readFileSync(path, "utf8").replace(/"version": "[^"]+"/, `"version": "${version}"`));
};

function startLauncher() {
  launcher = Bun.spawn([process.execPath, "scripts/launcher.ts"], {
    cwd: work, stdout: "ignore", stderr: "ignore",
    env: {
      ...fixtureGitEnv, PORT: String(port), USAGE_OBSERVATORY_DB: join(directory, "fixture.db"),
      USAGE_OBSERVATORY_TEST_HOLD_FILE: holdFile(), E2E_FAIL_FLAG: failFlag(),
      QUOTA_SERVICE_ENABLED: "0", USAGE_OBSERVATORY_OFFLINE_PRICING: "1",
    },
  });
}

async function stopLauncher() {
  if (!launcher) return;
  launcher.kill("SIGTERM");
  await launcher.exited;
  launcher = null;
}

const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, { ...init, signal: AbortSignal.timeout(10_000) });
const post = (path: string, body: unknown) => api(path, {
  method: "POST", body: JSON.stringify(body),
  headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}`, "X-Observatory-Action": "update" },
});
const status = async () => (await (await api("/api/update/status")).json()) as UpdateStatus;
const version = async () => (await (await api("/api/update/version")).json()) as { commit: string; pid: number; bootId: string };
const persistedJob = () => (JSON.parse(readFileSync(join(work, ".usage-observatory", "update-job.json"), "utf8")) as { job: UpdateJob }).job;

async function until<T>(read: () => Promise<T | null | undefined>, message: string, limitMs = 240_000) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const value = await read().catch(() => null);
    if (value) return value;
    await Bun.sleep(250);
  }
  throw new Error(message);
}

async function checkAndApply(target: string) {
  const check = (await (await post("/api/update/check", {})).json()) as UpdateCheck;
  expect(check).toMatchObject({ state: "eligible", target });
  const reply = await post("/api/update/apply", { checkId: check.id });
  expect(reply.status).toBe(202);
  return ((await reply.json()) as { job: UpdateJob }).job;
}

/** Polls like the browser: errors mean "restarting", and maintenance answers are recorded. */
async function finish(jobId: string) {
  let sawMaintenance = false;
  const job = await until(async () => {
    const current = await status();
    if (current.maintenance) sawMaintenance = true;
    return current.job?.id === jobId && (current.job.phase === "complete" || current.job.phase === "failed") ? current.job : null;
  }, "The job did not finish");
  return { job, sawMaintenance };
}

beforeAll(async () => {
  if (!enabled) return;
  directory = mkdtempSync(join(tmpdir(), "aiuo-launcher-e2e-"));
  const seed = join(directory, "seed");
  const origin = join(directory, "origin.git");
  // This working tree, including uncommitted files, becomes the fixture's first commit.
  const files = Bun.spawnSync(["git", "ls-files", "-z", "-co", "--exclude-standard"], { cwd: sourceRoot }).stdout.toString().split("\0").filter(Boolean);
  for (const file of files) {
    if (!existsSync(join(sourceRoot, file))) continue;
    mkdirSync(dirname(join(seed, file)), { recursive: true });
    copyFileSync(join(sourceRoot, file), join(seed, file));
  }
  // The target's server exits at startup while the flag file exists.
  const index = join(seed, "server", "index.ts");
  writeFileSync(index, `if (process.env.E2E_FAIL_FLAG && (await Bun.file(process.env.E2E_FAIL_FLAG).exists())) process.exit(3);\n${readFileSync(index, "utf8")}`);
  git(directory, "init", "-q", "--bare", "-b", "main", origin);
  git(seed, "init", "-q", "-b", "main");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "--no-gpg-sign", "-m", "fixture base");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "-u", "origin", "main");
  work = join(directory, "work");
  upstream = join(directory, "upstream");
  git(directory, "clone", "-q", origin, work);
  git(directory, "clone", "-q", origin, upstream);
  run(work, [process.execPath, "install", "--frozen-lockfile"]);
  run(work, [process.execPath, "node_modules/vite/bin/vite.js", "build"]);
  port = await freePort();
  sentinel = Bun.spawn(["sleep", "600"]);
}, timeout);

afterAll(async () => {
  await stopLauncher();
  sentinel?.kill();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

test.skipIf(!enabled)("launcher check, apply, startup failure, port conflict, and install failure", async () => {
  startLauncher();
  const first = await until(version, "The launcher did not start the server", 30_000);
  expect((await status()).managed).toBe(true);

  // 1. A clean update: maintenance answers while the server is down; a new PID serves the target.
  const target = push(bumpVersion("9.9.1"), "fixture: version 9.9.1");
  let job = await checkAndApply(target);
  let outcome = await finish(job.id);
  expect(outcome.job).toMatchObject({ phase: "complete", gitState: "target" });
  expect(outcome.sawMaintenance).toBe(true);
  const updated = await version();
  expect(updated.commit).toBe(target);
  expect(updated.pid).not.toBe(first.pid);
  expect(JSON.parse(readFileSync(join(work, "dist", "build-info.json"), "utf8")).commit).toBe(target);

  // 2. The target's server exits at startup; after the cause is removed, Retry completes.
  writeFileSync(failFlag(), "");
  const second = push(bumpVersion("9.9.2"), "fixture: version 9.9.2");
  job = await checkAndApply(second);
  outcome = await finish(job.id);
  expect(outcome.job).toMatchObject({ phase: "failed", failedPhase: "verifying", gitState: "target", retryable: true });
  expect((await status()).maintenance).toBe(true);
  rmSync(failFlag());
  expect((await post("/api/update/retry", { jobId: job.id })).status).toBe(202);
  outcome = await finish(job.id);
  expect(outcome.job.phase).toBe("complete");
  expect((await version()).commit).toBe(second);

  // 3. Another process takes the port before the new server starts: the job fails, and the
  // occupying process is not touched.
  writeFileSync(holdFile(), "");
  const third = push(bumpVersion("9.9.3"), "fixture: version 9.9.3");
  job = await checkAndApply(third);
  await until(async () => persistedJob().phase === "starting", "The job did not reach starting");
  await until(async () => !(await api("/api/update/status").then(() => true, () => false)), "Maintenance did not release the port", 15_000);
  const occupant = Bun.spawn([process.execPath, "-e", `Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: () => new Response("occupied") }); setInterval(() => {}, 1000)`], { stdout: "ignore", stderr: "ignore" });
  await until(async () => (await api("/")).status === 200, "The occupying process did not bind", 15_000);
  rmSync(holdFile());
  const conflicted = await until(async () => (persistedJob().phase === "failed" ? persistedJob() : null), "The port conflict was not reported", 30_000);
  expect(conflicted).toMatchObject({ failedPhase: "starting", gitState: "target" });
  expect(conflicted.failure?.code).toBe("port-in-use");
  expect(occupant.exitCode).toBeNull();
  occupant.kill();
  await occupant.exited;
  await stopLauncher();

  // 4. The target's package.json disagrees with bun.lock: install fails, maintenance answers.
  startLauncher();
  await until(async () => (await version()).commit === third, "The restarted launcher did not serve the checkout", 30_000);
  const fourth = push((root) => {
    const path = join(root, "package.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.version = "9.9.4";
    manifest.dependencies["left-pad"] = "1.3.0";
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }, "fixture: dependency without lockfile");
  job = await checkAndApply(fourth);
  outcome = await finish(job.id);
  expect(outcome.job).toMatchObject({ phase: "failed", failedPhase: "installing", gitState: "target", installComplete: false });
  const maintenance = await status();
  expect(maintenance.maintenance).toBe(true);
  expect((await api("/api/dashboard")).status).toBe(503);
  await stopLauncher();

  expect(sentinel?.exitCode).toBeNull();
  expect(existsSync(join(work, ".usage-observatory", "launcher.lock"))).toBe(false);
}, timeout);
