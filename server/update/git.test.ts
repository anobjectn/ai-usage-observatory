import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyFetchFailure, collidingPaths, displayRemote, gitTimeouts, inspectRepository, reconcileGitState } from "./git";
import { commit, createRepoFixture, fixtureGitEnv, fixturePackage, git, write, type RepoFixture } from "./test-fixtures";

let fixture: RepoFixture | undefined;
afterEach(() => { fixture?.cleanup(); fixture = undefined; });

const setup = (files?: Record<string, string>) => (fixture = createRepoFixture(files));
const check = (root: string, extra: Partial<Parameters<typeof inspectRepository>[1]> = {}) =>
  inspectRepository(root, { fetch: true, env: fixtureGitEnv, ...extra }).then((record) => record.check);

describe("update check relationships", () => {
  test("an equal checkout is up to date and a pushed commit makes it eligible", async () => {
    const repo = setup();
    expect((await check(repo.work)).state).toBe("up-to-date");
    const target = repo.push({ "package.json": fixturePackage("1.1.0"), "src/new.ts": "export const x = 1;\n" }, "feat: add x");
    const result = await check(repo.work);
    expect(result).toMatchObject({ state: "eligible", eligible: true, relationship: "behind", behind: 1, target, targetVersion: "1.1.0", currentVersion: "1.0.0", upstream: "origin/main" });
    expect(result.incomingCommits).toEqual([{ sha: target, subject: "feat: add x" }]);
    expect(result).toMatchObject({ dependenciesChanged: false, migrationsChanged: false, launcherChanged: false });
    expect(Date.parse(result.expiresAt) - Date.parse(result.checkedAt)).toBe(10 * 60_000);
  });

  test("a local commit is ahead and a local plus remote commit is diverged", async () => {
    const repo = setup();
    commit(repo.work, { "src/local.ts": "1\n" });
    expect((await check(repo.work)).state).toBe("ahead");
    repo.push({ "src/remote.ts": "2\n" });
    expect(await check(repo.work)).toMatchObject({ state: "diverged", relationship: "diverged", ahead: 1, behind: 1, eligible: false });
  });

  test("tracked changes are reported for every relationship but block only behind", async () => {
    const repo = setup();
    write(repo.work, "src/app.ts", "export const dirty = true;\n");
    expect(await check(repo.work)).toMatchObject({ state: "up-to-date", dirty: true, paths: ["src/app.ts"], blockers: [] });
    repo.push({ "src/remote.ts": "2\n" });
    expect(await check(repo.work)).toMatchObject({ state: "dirty", eligible: false, blockers: ["dirty"], paths: ["src/app.ts"] });
  });

  test("a missing upstream is allowed and a different upstream is blocked", async () => {
    const repo = setup();
    git(repo.work, "branch", "--unset-upstream");
    repo.push({ "src/remote.ts": "2\n" });
    expect((await check(repo.work)).state).toBe("eligible");
    git(repo.work, "push", "-q", "origin", "main:other");
    git(repo.work, "fetch", "-q", "origin");
    git(repo.work, "branch", "-q", "--set-upstream-to=origin/other");
    expect((await check(repo.work)).reason).toBe("unsupported/upstream-mismatch");
  });

  test("an incompatible updater protocol blocks the update", async () => {
    const repo = setup();
    repo.push({ "package.json": JSON.stringify({ name: "fixture", version: "2.0.0", updaterProtocol: 2 }) });
    expect(await check(repo.work)).toMatchObject({ state: "incompatible", eligible: false, protocolCompatible: false });
  });

  test("dependency, migration, and launcher changes are flagged", async () => {
    const repo = setup();
    repo.push({ "bun.lock": "{}\n", "server/migrations.ts": "export {};\n", "server/update/job.ts": "export {};\n" });
    expect(await check(repo.work)).toMatchObject({ dependenciesChanged: true, migrationsChanged: true, launcherChanged: true, eligible: true });
  });

  test("an updater test change alone is not a launcher change", async () => {
    const repo = setup();
    repo.push({ "server/update/job.test.ts": "export {};\n" });
    expect(await check(repo.work)).toMatchObject({ launcherChanged: false, eligible: true });
  });
});

describe("unsupported checkouts", () => {
  test("feature branch, detached HEAD, and missing origin", async () => {
    const repo = setup();
    git(repo.work, "switch", "-q", "-c", "feature");
    expect((await check(repo.work)).reason).toBe("unsupported/not-main");
    git(repo.work, "switch", "-q", "--detach", "main");
    expect((await check(repo.work)).reason).toBe("unsupported/detached");
    git(repo.work, "switch", "-q", "main");
    git(repo.work, "remote", "remove", "origin");
    expect((await check(repo.work)).reason).toBe("unsupported/no-origin");
  });

  test("a directory without Git and a missing git executable", async () => {
    const repo = setup();
    const plain = join(repo.directory, "plain");
    mkdirSync(plain);
    expect((await check(plain)).reason).toBe("unsupported/not-git");
    expect((await check(repo.work, { git: join(repo.directory, "no-such-git") })).reason).toBe("unsupported/no-git");
  });

  test("shallow clones, linked worktrees, sparse checkouts, and submodules", async () => {
    const repo = setup();
    const shallow = join(repo.directory, "shallow");
    git(repo.directory, "clone", "-q", "--depth=1", `file://${repo.origin}`, shallow);
    expect((await check(shallow)).reason).toBe("unsupported/shallow");
    const linked = join(repo.directory, "linked");
    git(repo.work, "worktree", "add", "-q", "-b", "linked", linked);
    expect((await check(linked)).reason).toBe("unsupported/linked-worktree");
    git(repo.work, "worktree", "remove", "--force", linked);
    git(repo.work, "config", "core.sparseCheckout", "true");
    expect((await check(repo.work)).reason).toBe("unsupported/sparse-checkout");
    git(repo.work, "config", "--unset", "core.sparseCheckout");
    write(repo.work, ".gitmodules", "");
    expect((await check(repo.work)).reason).toBe("unsupported/submodules");
  });
});

describe("busy repositories", () => {
  test("an index lock and an unfinished merge block the check", async () => {
    const repo = setup();
    writeFileSync(join(repo.work, ".git", "index.lock"), "");
    expect(await check(repo.work)).toMatchObject({ state: "git-busy", paths: ["index.lock"] });
    rmSync(join(repo.work, ".git", "index.lock"));
    writeFileSync(join(repo.work, ".git", "MERGE_HEAD"), git(repo.work, "rev-parse", "HEAD"));
    expect(await check(repo.work)).toMatchObject({ state: "git-busy", paths: ["MERGE_HEAD"] });
  });
});

describe("collisions", () => {
  test("untracked and ignored files, directory replacement, and odd names", async () => {
    const repo = setup();
    repo.push({ "notes/a file.txt": "x\n", "dist/out.js": "x\n", "tool": "file now\n", "line\nbreak.txt": "x\n" });
    write(repo.work, "notes/a file.txt", "mine\n");
    write(repo.work, "dist/old.js", "ignored build output\n");
    let result = await check(repo.work);
    expect(result).toMatchObject({ state: "collision", eligible: false, paths: ["dist/out.js", "notes/a file.txt"] });
    rmSync(join(repo.work, "notes"), { recursive: true });
    write(repo.work, "tool/inner.txt", "a directory where a file arrives\n");
    result = await check(repo.work);
    expect(result.paths).toEqual(["dist/out.js", "tool"]);
    rmSync(join(repo.work, "tool"), { recursive: true });
    write(repo.work, "line\nbreak.txt", "mine\n");
    expect((await check(repo.work)).paths).toContain("line\nbreak.txt");
  });

  test("a file where an incoming directory arrives collides", () => {
    expect(collidingPaths(["config/a.json"], ["config"])).toEqual(["config/a.json"]);
    expect(collidingPaths(["config"], ["config/"])).toEqual(["config"]);
    expect(collidingPaths(["src/ok.ts"], ["srcx", "other/"])).toEqual([]);
  });

  test("app-owned paths always block", async () => {
    expect(collidingPaths([".usage-observatory/data.db", "node_modules/x/index.js", ".env.local", "data/custom.db"], [], ["data/custom.db"]))
      .toEqual([".env.local", ".usage-observatory/data.db", "data/custom.db", "node_modules/x/index.js"]);
    const repo = setup();
    repo.push({ "fixtures/app.db": "x\n" });
    expect((await check(repo.work, { dbPath: join(repo.work, "fixtures", "app.db") })).state).toBe("collision");
  });

  test("noncolliding untracked files keep the update eligible", async () => {
    const repo = setup();
    write(repo.work, "scratch.txt", "mine\n");
    write(repo.work, ".env.local", "SECRET=1\n");
    repo.push({ "src/remote.ts": "2\n" });
    expect((await check(repo.work)).state).toBe("eligible");
  });
});

describe("fetch failures", () => {
  const sshFixture = (repo: RepoFixture, script: string) => {
    const path = join(repo.directory, "fake-ssh");
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
    git(repo.work, "remote", "set-url", "origin", "ssh://git@example.invalid/owner/repo.git");
    return { ...fixtureGitEnv, GIT_SSH_COMMAND: path };
  };

  test("authentication and network failures are classified", async () => {
    const repo = setup();
    let env = sshFixture(repo, 'echo "git@example.invalid: Permission denied (publickey)." >&2; exit 255');
    expect((await check(repo.work, { env })).reason).toBe("failed/auth");
    env = sshFixture(repo, 'echo "ssh: Could not resolve host example.invalid" >&2; exit 255');
    expect((await check(repo.work, { env })).reason).toBe("failed/network");
  });

  test("a stalled fetch ends at its deadline", async () => {
    const repo = setup();
    const env = sshFixture(repo, "sleep 5");
    const saved = gitTimeouts.fetch;
    gitTimeouts.fetch = 300;
    const started = performance.now();
    try { expect((await check(repo.work, { env })).reason).toBe("failed/timeout"); }
    finally { gitTimeouts.fetch = saved; }
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  test("an unrecognized fetch error is a generic git error", () => {
    expect(classifyFetchFailure({ timedOut: false, stderr: "fatal: weird" })).toBe("git-error");
  });

  test("remote addresses lose their credentials", () => {
    expect(displayRemote("https://user:token@github.com/a/b.git")).toBe("https://github.com/a/b.git");
    expect(displayRemote("git@github.com:a/b.git")).toBe("git@github.com:a/b.git");
  });
});

describe("reconciliation", () => {
  test("HEAD and the tree decide the Git state", async () => {
    const repo = setup();
    const from = git(repo.work, "rev-parse", "HEAD");
    const target = repo.push({ "src/remote.ts": "2\n" });
    git(repo.work, "fetch", "-q", "origin");
    expect(await reconcileGitState(repo.work, from, target, { env: fixtureGitEnv })).toBe("unchanged");
    git(repo.work, "merge", "-q", "--ff-only", target);
    expect(await reconcileGitState(repo.work, from, target, { env: fixtureGitEnv })).toBe("target");
    write(repo.work, "src/remote.ts", "edited\n");
    expect(await reconcileGitState(repo.work, from, target, { env: fixtureGitEnv })).toBe("unexpected");
  });
});
