/** `bun run start`: supervises the production server and runs in-app updates. This process is
 * never replaced by an update; it imports every updater module now and none later. */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import type { UpdateRunning, UpdateStatus } from "../src/types";
import { resolveDbPath } from "../server/db-path";
import { readHead, repoRoot } from "../server/update/git";
import { isIpcRequest, type IpcRequest } from "../server/update/ipc";
import { defaultRunStep, defaultVerify, portIsFree, Updater, type ServerHandle } from "../server/update/job";
import { startMaintenanceServer } from "../server/update/maintenance";

const root = repoRoot;
const port = Number(process.env.PORT ?? 4318);
const stateDir = join(root, ".usage-observatory");
const lockPath = join(stateDir, "launcher.lock");
const nonce = randomUUID();
const stopGraceMs = 10_000;

function acquireLock() {
  mkdirSync(stateDir, { recursive: true });
  try {
    const descriptor = openSync(lockPath, "wx", 0o600);
    writeSync(descriptor, JSON.stringify({ pid: process.pid, nonce, root }));
    closeSync(descriptor);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let owner: { pid?: number } = {};
    try { owner = JSON.parse(readFileSync(lockPath, "utf8")); } catch { /* reported below */ }
    let alive = false;
    try { if (owner.pid) { process.kill(owner.pid, 0); alive = true; } } catch { alive = false; }
    console.error(alive
      ? `Another launcher (pid ${owner.pid}) already runs this checkout. Stop it first.`
      : `A launcher lock from pid ${owner.pid ?? "unknown"} remains, but that process is gone. Confirm nothing runs this checkout, then delete ${lockPath}.`);
    process.exit(1);
  }
}

function releaseLock() {
  try {
    if (JSON.parse(readFileSync(lockPath, "utf8")).nonce === nonce) rmSync(lockPath, { force: true });
  } catch { /* Not ours, or already gone. */ }
}

acquireLock();
process.on("exit", releaseLock);

let child: Subprocess | null = null;
const expectedExits = new WeakSet<Subprocess>();
let running: UpdateRunning | null = null;
let maintenance: ReturnType<typeof startMaintenanceServer> | null = null;
let shuttingDown = false;

function launcherStatus(): UpdateStatus {
  const status = updater.status();
  const jobActive = updater.jobActive();
  return {
    managed: true, mode: "prod", canApply: !jobActive, blockingReason: jobActive ? "job-active" : null,
    running, schemaAhead: false, ...status, maintenance: maintenance !== null,
  };
}

async function handleIpc(message: unknown, subprocess: Subprocess) {
  if (!isIpcRequest(message)) return;
  const request: IpcRequest = message;
  const body = (request.body ?? {}) as { checkId?: string; jobId?: string };
  let reply: { status: number; body: unknown };
  try {
    if (request.type === "status") reply = { status: 200, body: launcherStatus() };
    else if (request.type === "check") reply = await updater.runCheck();
    else if (request.type === "apply") reply = await updater.apply(String(body.checkId));
    else reply = await updater.retry(String(body.jobId));
  } catch (error) {
    reply = { status: 500, body: { error: "launcher-error", message: error instanceof Error ? error.message : String(error) } };
  }
  try { subprocess.send({ v: 1, id: request.id, ok: reply.status < 400, status: reply.status, body: reply.body }); }
  catch { /* The server exited before the answer. */ }
}

async function startServer(bootId: string): Promise<ServerHandle> {
  const { head } = await readHead(root).catch(() => ({ head: null }));
  let version: string | null = null;
  try { version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? null; } catch { version = null; }
  const tail: string[] = [];
  // Its own process group, so a stop also reaches anything the server spawned.
  const proc = Bun.spawn([process.execPath, "server/index.ts"], {
    cwd: root,
    env: { ...process.env, USAGE_OBSERVATORY_MANAGED: "1", USAGE_OBSERVATORY_BOOT_ID: bootId },
    stdin: "ignore", stdout: "inherit", stderr: "pipe", detached: true,
    ipc: (message, subprocess) => void handleIpc(message, subprocess),
  });
  child = proc;
  running = { commit: head, version, bootId, startedAt: new Date().toISOString() };
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
      process.stderr.write(chunk);
      tail.push(...decoder.decode(chunk, { stream: true }).split("\n").filter(Boolean));
      if (tail.length > 40) tail.splice(0, tail.length - 40);
    }
  })();
  const exited = proc.exited.then((code) => {
    if (child === proc) child = null;
    if (!expectedExits.has(proc) && !updater.jobActive() && !shuttingDown) {
      console.error(`AI Usage Observatory server exited with ${code}; the launcher stops too.`);
      void shutdown(code || 1);
    }
    return code;
  });
  return { pid: proc.pid, bootId, exited, stderrTail: () => [...tail] };
}

/** Stops only the child this launcher started: SIGTERM to its group, then SIGKILL after 10 s. */
async function stopServer() {
  const proc = child;
  if (!proc) return;
  expectedExits.add(proc);
  // Lets an in-flight answer (the `202` that started this job) reach the browser first.
  await Bun.sleep(300);
  const signal = (name: NodeJS.Signals) => { try { process.kill(-proc.pid, name); } catch { proc.kill(name); } };
  signal("SIGTERM");
  const stopped = await Promise.race([proc.exited.then(() => true), Bun.sleep(stopGraceMs).then(() => false)]);
  if (!stopped) {
    signal("SIGKILL");
    await proc.exited;
  }
  if (child === proc) child = null;
}

/** Test seam for the end-to-end suite: hold before the new server starts while a file exists. */
async function testHoldBeforeStart() {
  const hold = process.env.USAGE_OBSERVATORY_TEST_HOLD_FILE;
  if (!hold) return;
  const deadline = Date.now() + 60_000;
  while (existsSync(hold) && Date.now() < deadline) await Bun.sleep(100);
}

const updater = new Updater({
  root, stateDir, port, dbPath: resolveDbPath(process.env, root),
  runStep: defaultRunStep(root),
  verify: defaultVerify(root, port),
  portFree: () => portIsFree(port),
  server: { start: startServer, stop: stopServer, running: () => child !== null },
  maintenance: {
    bind: async () => {
      if (maintenance) return;
      maintenance = startMaintenanceServer({ port, status: launcherStatus, retry: (jobId) => updater.retry(jobId) });
    },
    release: async () => {
      const server = maintenance;
      maintenance = null;
      await server?.stop(true);
    },
    bound: () => maintenance !== null,
  },
  hooks: { beforeStart: testHoldBeforeStart },
});

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  await stopServer();
  await maintenance?.stop(true);
  releaseLock();
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

await updater.recover();
if (updater.job?.phase === "failed") {
  console.warn(`The last update ${updater.job.id} failed at ${updater.job.failedPhase} (${updater.job.failure?.code}). Details are in the app.`);
}
await startServer(randomUUID());
console.log(`AI Usage Observatory launcher (pid ${process.pid}) supervises the server on port ${port}.`);
