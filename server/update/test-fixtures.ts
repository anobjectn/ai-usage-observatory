import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Git without the developer's global configuration, hooks, or signing. */
export const fixtureGitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

export function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: fixtureGitEnv, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

export function write(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

export function commit(root: string, files: Record<string, string>, message = "fixture change") {
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  git(root, "add", "-A", "-f");
  git(root, "commit", "-q", "--no-gpg-sign", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

export type RepoFixture = {
  directory: string;
  origin: string;
  /** The checkout under test. */
  work: string;
  /** Another clone that pushes new commits to origin. */
  upstream: string;
  push: (files: Record<string, string>, message?: string) => string;
  forcePush: (files: Record<string, string>) => string;
  cleanup: () => void;
};

const basePackage = (version: string) => JSON.stringify({ name: "fixture", version, updaterProtocol: 1 }, null, 2);

/** A bare origin, a `main` clone that tracks it, and a second clone for pushing. */
export function createRepoFixture(files: Record<string, string> = {}): RepoFixture {
  const directory = mkdtempSync(join(tmpdir(), "aiuo-update-git-"));
  const origin = join(directory, "origin.git");
  const seed = join(directory, "seed");
  git(directory, "init", "-q", "--bare", "-b", "main", origin);
  git(directory, "init", "-q", "-b", "main", seed);
  commit(seed, { "package.json": basePackage("1.0.0"), ".gitignore": "node_modules/\n.usage-observatory/\ndist/\n.env.local\n", "src/app.ts": "export {};\n", ...files }, "initial");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "-u", "origin", "main");
  const work = join(directory, "work");
  const upstream = join(directory, "upstream");
  git(directory, "clone", "-q", origin, work);
  git(directory, "clone", "-q", origin, upstream);
  rmSync(seed, { recursive: true, force: true });
  return {
    directory, origin, work, upstream,
    push(changes, message) {
      const sha = commit(upstream, changes, message);
      git(upstream, "push", "-q", "origin", "main");
      return sha;
    },
    forcePush(changes) {
      git(upstream, "reset", "-q", "--hard", "HEAD~1");
      const sha = commit(upstream, changes, "rewritten");
      git(upstream, "push", "-q", "-f", "origin", "main");
      return sha;
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

export const fixturePackage = basePackage;
