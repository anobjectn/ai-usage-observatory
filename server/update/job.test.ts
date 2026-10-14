import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UpdateCheck, UpdateJob } from "../../src/types";
import { gitTimeouts } from "./git";
import { Updater, type UpdaterDeps } from "./job";
import { commit, createRepoFixture, fixtureGitEnv, git, write, type RepoFixture } from "./test-fixtures";

let fixture: RepoFixture | undefined;
afterEach(() => { fixture?.cleanup(); fixture = undefined; });

function harness(overrides: Partial<UpdaterDeps> = {}) {
  const repo = (fixture = createRepoFixture());
  const stateDir = join(repo.work, ".usage-observatory");
  const events: string[] = [];
  let serverRunning = true;
  let maintenanceBound = false;
  const deps: UpdaterDeps = {
    root: repo.work, stateDir, dbPath: join(stateDir, "data.db"), port: 0, git: { env: fixtureGitEnv },
    runStep: async (step) => { events.push(step); return { ok: true, message: "" }; },
    server: {
      stop: async () => { serverRunning = false; events.push("stop"); },
      start: async (bootId) => {
        serverRunning = true;
        events.push("start");
        return { pid: 1, bootId, exited: new Promise(() => {}), stderrTail: () => ["server stderr"] };
      },
      running: () => serverRunning,
    },
    maintenance: {
      bind: async () => { maintenanceBound = true; events.push("bind"); },
      release: async () => { maintenanceBound = false; events.push("release"); },
      bound: () => maintenanceBound,
    },
    verify: async () => ({ ok: true, message: "" }),
    portFree: async () => true,
    ...overrides,
  };
  const updater = new Updater(deps);
  const head = () => git(repo.work, "rev-parse", "HEAD");
  const checked = async () => (await updater.runCheck()).body as UpdateCheck;
  const applied = async (checkId: string) => {
    const reply = await updater.apply(checkId);
    await updater.settled();
    return reply;
  };
  const persisted = () => (JSON.parse(readFileSync(join(stateDir, "update-job.json"), "utf8")) as { job: UpdateJob }).job;
  return { repo, deps, updater, events, head, checked, applied, persisted, stateDir };
}

describe("apply", () => {
  test("applies the exact checked target even after origin advances again", async () => {
    const h = harness();
    const target = h.repo.push({ "src/one.ts": "1\n" });
    const check = await h.checked();
    expect(check.eligible).toBe(true);
    h.repo.push({ "src/two.ts": "2\n" });
    const reply = await h.applied(check.id);
    expect(reply.status).toBe(202);
    expect(h.updater.job).toMatchObject({ phase: "complete", gitState: "target", target, installComplete: true, buildComplete: true });
    expect(h.head()).toBe(target);
    expect(h.events).toEqual(["stop", "bind", "install", "build", "release", "start"]);
  });

  test("the same checkId names the same job", async () => {
    const h = harness();
    h.repo.push({ "src/one.ts": "1\n" });
    const check = await h.checked();
    const [first, second] = await Promise.all([h.updater.apply(check.id), h.updater.apply(check.id)]);
    await h.updater.settled();
    expect((first.body as { job: UpdateJob }).job.id).toBe((second.body as { job: UpdateJob }).job.id);
    expect((await h.updater.apply(check.id)).status).toBe(202);
    expect(h.events.filter((event) => event === "install")).toHaveLength(1);
    expect(h.events.filter((event) => event === "build")).toHaveLength(1);
  });

  test("an up-to-date check is ineligible and an unknown check is stale", async () => {
    const h = harness();
    const check = await h.checked();
    expect((await h.updater.apply(check.id)).status).toBe(422);
    expect((await h.updater.apply(crypto.randomUUID())).status).toBe(409);
  });

  test("a force-push that drops the checked target makes the checkId stale", async () => {
    const h = harness();
    h.repo.push({ "src/one.ts": "1\n" });
    const check = await h.checked();
    h.repo.forcePush({ "src/rewritten.ts": "x\n" });
    // Any fetch that sees the rewrite, without a new check replacing this one.
    git(h.repo.work, "fetch", "-q", "origin");
    const reply = await h.updater.apply(check.id);
    expect(reply.status).toBe(409);
    expect(reply.body).toMatchObject({ error: "stale" });
    expect(h.head()).not.toBe(check.target);
  });

  test("HEAD, branch, and tree drift between check and apply are refused", async () => {
    const h = harness();
    h.repo.push({ "src/one.ts": "1\n" });
    let check = await h.checked();
    write(h.repo.work, "src/app.ts", "dirty\n");
    expect((await h.updater.apply(check.id)).status).toBe(409);
    git(h.repo.work, "checkout", "--", "src/app.ts");
    check = await h.checked();
    git(h.repo.work, "switch", "-q", "-c", "elsewhere");
    expect((await h.updater.apply(check.id)).status).toBe(409);
    git(h.repo.work, "switch", "-q", "main");
    check = await h.checked();
    commit(h.repo.work, { "src/local.ts": "local\n" });
    expect((await h.updater.apply(check.id)).status).toBe(409);
    expect(h.events).toEqual([]);
  });

  test("an index lock that appears just before the merge leaves Git unchanged and restarts the old server", async () => {
    const h = harness({ hooks: { beforeMerge: () => writeFileSync(join(fixture!.work, ".git", "index.lock"), "") } });
    h.repo.push({ "src/one.ts": "1\n" });
    const from = h.head();
    const check = await h.checked();
    await h.applied(check.id);
    expect(h.updater.job).toMatchObject({ phase: "failed", failedPhase: "applying", gitState: "unchanged", retryable: false });
    expect(h.head()).toBe(from);
    expect(h.events).toEqual(["stop", "bind", "release", "start"]);
  });

  test("a merge that outlives its deadline is reconciled from HEAD", async () => {
    const h = harness();
    const target = h.repo.push({ "src/one.ts": "1\n" });
    const hook = join(h.repo.work, ".git", "hooks", "post-merge");
    mkdirSync(join(h.repo.work, ".git", "hooks"), { recursive: true });
    writeFileSync(hook, "#!/bin/sh\nsleep 3\n");
    chmodSync(hook, 0o755);
    const check = await h.checked();
    const saved = gitTimeouts.merge;
    gitTimeouts.merge = 500;
    const started = performance.now();
    try { await h.applied(check.id); }
    finally { gitTimeouts.merge = saved; }
    // The deadline stops the hook too; otherwise the merge waits out its full 3 s.
    expect(performance.now() - started).toBeLessThan(2_500);
    expect(h.head()).toBe(target);
    expect(h.updater.job).toMatchObject({ phase: "complete", gitState: "target" });
  });

  test("the job is persisted before each step", async () => {
    const seen: string[] = [];
    const h = harness({
      runStep: async (step) => {
        seen.push(`${step}:${(JSON.parse(readFileSync(join(fixture!.work, ".usage-observatory", "update-job.json"), "utf8")) as { job: UpdateJob }).job.phase}`);
        return { ok: true, message: "" };
      },
    });
    h.repo.push({ "src/one.ts": "1\n" });
    const check = await h.checked();
    const reply = await h.updater.apply(check.id);
    expect(h.persisted().id).toBe((reply.body as { job: UpdateJob }).job.id);
    await h.updater.settled();
    expect(seen).toEqual(["install:installing", "build:building"]);
    expect(h.persisted()).toMatchObject({ phase: "complete", gitState: "target" });
  });

  test("untracked files, .env.local, and app state survive", async () => {
    const h = harness();
    write(h.repo.work, "scratch.txt", "mine\n");
    write(h.repo.work, ".env.local", "KEY=1\n");
    write(h.repo.work, ".usage-observatory/keep.txt", "state\n");
    h.repo.push({ "src/one.ts": "1\n" });
    await h.applied((await h.checked()).id);
    expect(h.updater.job?.phase).toBe("complete");
    expect(readFileSync(join(h.repo.work, "scratch.txt"), "utf8")).toBe("mine\n");
    expect(readFileSync(join(h.repo.work, ".env.local"), "utf8")).toBe("KEY=1\n");
    expect(readFileSync(join(h.repo.work, ".usage-observatory", "keep.txt"), "utf8")).toBe("state\n");
  });
});

describe("failure, recovery, and retry", () => {
  test("a crash after the merge becomes interrupted with Git at the target", async () => {
    const h = harness({ runStep: () => new Promise(() => {}) });
    const target = h.repo.push({ "src/one.ts": "1\n" });
    await h.updater.apply((await h.checked()).id);
    while (h.persisted().phase !== "installing") await Bun.sleep(20);
    const restarted = new Updater(h.deps);
    await restarted.recover();
    expect(restarted.job).toMatchObject({ phase: "failed", failedPhase: "installing", gitState: "target", retryable: true, target });
    expect(restarted.job?.failure?.code).toBe("interrupted");
  });

  test("retry needs HEAD at the target and a clean tree, then resumes at the first unfinished step", async () => {
    let installs = 0;
    const steps: string[] = [];
    const h = harness({
      runStep: async (step) => {
        steps.push(step);
        if (step === "install" && installs++ === 0) return { ok: false, message: "install exited with 1" };
        return { ok: true, message: "" };
      },
    });
    h.repo.push({ "src/one.ts": "1\n" });
    await h.applied((await h.checked()).id);
    const job = h.updater.job!;
    expect(job).toMatchObject({ phase: "failed", failedPhase: "installing", gitState: "target", retryable: true });
    expect(job.failure?.logTail.some((line) => line.includes("install exited with 1"))).toBe(true);
    write(h.repo.work, "src/one.ts", "edited\n");
    expect((await h.updater.retry(job.id)).status).toBe(409);
    git(h.repo.work, "checkout", "--", "src/one.ts");
    expect((await h.updater.retry(job.id)).status).toBe(202);
    await h.updater.settled();
    expect(h.updater.job?.phase).toBe("complete");
    expect(steps).toEqual(["install", "install", "build"]);
  });

  test("a server that fails verification keeps the log tail and allows retry from starting", async () => {
    let attempts = 0;
    const h = harness({ verify: async () => (attempts++ === 0 ? { ok: false, message: "exited with 3" } : { ok: true, message: "" }) });
    h.repo.push({ "src/one.ts": "1\n" });
    await h.applied((await h.checked()).id);
    expect(h.updater.job).toMatchObject({ phase: "failed", failedPhase: "verifying", gitState: "target", retryable: true, startupAttempted: true });
    expect(h.updater.job?.failure?.logTail).toContain("server stderr");
    expect(h.deps.maintenance.bound()).toBe(true);
    await h.updater.retry(h.updater.job!.id);
    await h.updater.settled();
    expect(h.updater.job?.phase).toBe("complete");
    expect(h.events.filter((event) => event === "install")).toHaveLength(1);
  });

  test("an occupied port fails at starting and is not touched", async () => {
    const h = harness({ portFree: async () => false });
    h.repo.push({ "src/one.ts": "1\n" });
    await h.applied((await h.checked()).id);
    expect(h.updater.job).toMatchObject({ phase: "failed", failedPhase: "starting", retryable: true });
    expect(h.updater.job?.failure?.code).toBe("port-in-use");
    expect(h.events).not.toContain("start");
  });

  test("check and apply are refused while a job runs", async () => {
    let release!: () => void;
    const h = harness({ runStep: () => new Promise((resolve) => { release = () => resolve({ ok: true, message: "" }); }) });
    h.repo.push({ "src/one.ts": "1\n" });
    const check = await h.checked();
    await h.updater.apply(check.id);
    while (!release) await Bun.sleep(10);
    expect((await h.updater.runCheck()).status).toBe(409);
    const busy = await h.updater.apply(crypto.randomUUID());
    expect(busy.status).toBe(409);
    expect(busy.body).toMatchObject({ error: "busy" });
    release();
    while (h.updater.jobActive()) { await Bun.sleep(10); release(); }
  });
});
