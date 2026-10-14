import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { UpdateCheck, UpdateGitState, UpdateRelationship } from "../../src/types";
import { execCommand, type CommandResult } from "../subprocess";
import { redactCredentials } from "./files";

/** The checkout this code runs from. */
export const repoRoot = resolve(import.meta.dir, "..", "..");
/** Bumped when the launcher cannot run a target's updater contract. */
export const updaterProtocol = 1;
export const checkTtlMs = 10 * 60_000;
export const gitTimeouts = { local: 15_000, fetch: 60_000, merge: 30_000 };
export const targetBranch = "main";
export const targetRef = "refs/remotes/origin/main";

/** Paths an update must never write, whatever Git would allow. */
const protectedPrefixes = [".usage-observatory/", "node_modules/"];
const protectedFiles = [".env.local"];
/** Changes here mean the running launcher is older than the code it would supervise. */
const launcherPaths = ["scripts/launcher.ts", "server/subprocess.ts", "server/db-path.ts", "server/request-host.ts"];

export type GitOptions = { git?: string; env?: Record<string, string | undefined> };
export type CheckOptions = GitOptions & {
  /** False for revalidation: compare against the cached remote-tracking ref only. */
  fetch: boolean;
  /** A target from an earlier check; it must still be reachable from the cached ref. */
  pinnedTarget?: string;
  dbPath?: string;
  now?: () => Date;
  protocol?: number;
};
/** The launcher keeps the raw remote URL beside the check, so it never reaches the browser. */
export type CheckRecord = { check: UpdateCheck; remoteUrl: string | null };

const sshConfigured = new Map<string, boolean>();

/** Git never prompts: no terminal, no credential dialog, no SSH passphrase. */
export async function gitEnv(root: string, options: GitOptions = {}) {
  const env: Record<string, string | undefined> = {
    ...(options.env ?? process.env),
    GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", SSH_ASKPASS_REQUIRE: "never", LC_ALL: "C", NO_COLOR: "1",
  };
  if (!env.GIT_SSH_COMMAND) {
    let configured = sshConfigured.get(root);
    if (configured === undefined) {
      const result = await execCommand([options.git ?? "git", "config", "--get", "core.sshCommand"], { cwd: root, env, timeoutMs: gitTimeouts.local });
      configured = result.code === 0 && result.stdout.trim() !== "";
      sshConfigured.set(root, configured);
    }
    // SSH aliases in ~/.ssh/config still apply; BatchMode only removes prompts.
    if (!configured) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes -o ConnectTimeout=15";
  }
  return env;
}

export async function runGit(root: string, args: string[], options: GitOptions & { timeoutMs?: number } = {}): Promise<CommandResult> {
  // A process group lets a deadline also stop hooks and transports that hold git's pipes open.
  return execCommand([options.git ?? "git", ...args], {
    cwd: root, env: await gitEnv(root, options), timeoutMs: options.timeoutMs ?? gitTimeouts.local, processGroup: true,
  });
}

async function gitText(root: string, args: string[], options: GitOptions = {}) {
  const result = await runGit(root, args, options);
  if (result.timedOut) throw new GitError("timeout", `git ${args[0]} timed out`);
  if (result.code !== 0 || result.truncated) throw new GitError("git-error", redactCredentials(result.stderr.trim()) || `git ${args[0]} failed`);
  return result.stdout;
}

const nulList = (text: string) => text.split("\0").filter(Boolean);

class GitError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** Classifies a failed fetch for the UI. Authentication is checked first: SSH prints
 * "Could not read from remote repository" for both refused keys and dead hosts. */
export function classifyFetchFailure(result: Pick<CommandResult, "stderr" | "timedOut">): "auth" | "network" | "timeout" | "git-error" {
  if (result.timedOut) return "timeout";
  const text = result.stderr;
  if (/permission denied|authentication failed|could not read username|publickey|host key verification failed|repository not found|access denied|403/i.test(text)) return "auth";
  if (/could not resolve host|connection refused|network is unreachable|timed out|connection reset|unable to access|could not read from remote|no route to host/i.test(text)) return "network";
  return "git-error";
}

/** Shows the remote without credentials. SCP-style addresses (`git@host:owner/repo`) stay as is. */
export function displayRemote(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") return url;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return redactCredentials(url);
  }
}

export async function gitBusyMarkers(root: string, options: GitOptions = {}) {
  const names = ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "index.lock"];
  const output = await gitText(root, ["rev-parse", ...names.flatMap((name) => ["--git-path", name])], options);
  return output.split("\n").filter(Boolean).flatMap((path, index) => existsSync(isAbsolute(path) ? path : join(root, path)) ? [names[index]] : []);
}

/** Tracked changes only. Untracked files are handled by the collision check. */
export async function trackedChanges(root: string, options: GitOptions = {}) {
  const entries = nulList(await gitText(root, ["status", "--porcelain=v2", "-z", "--untracked-files=no", "--ignore-submodules=none"], options));
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const fields = entry.split(" ");
    if (entry.startsWith("1 ")) paths.push(fields.slice(8).join(" "));
    else if (entry.startsWith("2 ")) { paths.push(fields.slice(9).join(" ")); index++; }
    else if (entry.startsWith("u ")) paths.push(fields.slice(10).join(" "));
  }
  return paths;
}

export async function readHead(root: string, options: GitOptions = {}) {
  const [branch, head] = await Promise.all([
    runGit(root, ["symbolic-ref", "-q", "--short", "HEAD"], options),
    runGit(root, ["rev-parse", "--verify", "-q", "HEAD"], options),
  ]);
  return { branch: branch.code === 0 ? branch.stdout.trim() : null, head: head.code === 0 ? head.stdout.trim() : null };
}

/** Incoming paths that would overwrite an untracked or ignored file or directory, or that the
 * app owns. `--directory` lists a wholly untracked or ignored directory once, as `name/`. */
export function collidingPaths(incoming: string[], localOnly: string[], protectedPaths: string[] = []) {
  const collisions = new Set<string>();
  for (const path of incoming) {
    if (protectedPrefixes.some((prefix) => path.startsWith(prefix)) || protectedFiles.includes(path) || protectedPaths.includes(path)) {
      collisions.add(path);
      continue;
    }
    for (const entry of localOnly) {
      const name = entry.endsWith("/") ? entry.slice(0, -1) : entry;
      if (path === name || path.startsWith(`${name}/`) || name.startsWith(`${path}/`)) collisions.add(path);
    }
  }
  return [...collisions].sort();
}

/** A path relative to the checkout, compared both as given and through symlinks (`/var` vs
 * `/private/var` on macOS). Empty when the path is outside the checkout. */
function pathsWithin(root: string, path: string) {
  const real = (value: string) => { try { return realpathSync(value); } catch { return value; } };
  const candidates = [relative(root, resolve(path)), relative(real(root), join(real(dirname(resolve(path))), basename(path)))];
  return [...new Set(candidates.filter((value) => value && !value.startsWith("..") && !isAbsolute(value)))];
}

function packageJsonAt(root: string, revision: string, options: GitOptions) {
  return gitText(root, ["show", `${revision}:package.json`], options)
    .then((text) => JSON.parse(text) as Record<string, unknown>)
    .catch(() => null);
}

function readVersion(root: string) {
  try { return String((JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string }).version ?? "") || null; }
  catch { return null; }
}

function emptyCheck(root: string, now: Date): UpdateCheck {
  return {
    id: randomUUID(), checkedAt: now.toISOString(), expiresAt: new Date(now.getTime() + checkTtlMs).toISOString(),
    branch: null, upstream: null, remoteDisplay: null, head: null, target: null, relationship: "unknown",
    state: "failed", reason: null, eligible: false, dirty: false, ahead: 0, behind: 0, blockers: [], paths: [],
    currentVersion: readVersion(root), targetVersion: null, incomingCommits: [], dependenciesChanged: false,
    migrationsChanged: false, launcherChanged: false, protocolCompatible: false,
  };
}

function block(check: UpdateCheck, state: UpdateCheck["state"], reason: string) {
  check.state = state;
  check.reason = reason;
  check.blockers.push(reason);
  return check;
}

/** Checks whether this checkout can fast-forward `main` to `origin/main`. The first blocker wins;
 * the relationship is still reported when it is known. Never changes the working tree or HEAD. */
export async function inspectRepository(root: string, options: CheckOptions): Promise<CheckRecord> {
  const now = options.now?.() ?? new Date();
  const check = emptyCheck(root, now);
  const record: CheckRecord = { check, remoteUrl: null };
  const git = options.git ?? "git";
  if (!Bun.which(git)) return { ...record, check: block(check, "unsupported", "unsupported/no-git") };
  try {
    const toplevel = await runGit(root, ["rev-parse", "--show-toplevel"], options);
    if (toplevel.code !== 0 || realpathSync(toplevel.stdout.trim()) !== realpathSync(root)) {
      return { ...record, check: block(check, "unsupported", "unsupported/not-git") };
    }
    if ((await gitText(root, ["rev-parse", "--is-shallow-repository"], options)).trim() === "true") return { ...record, check: block(check, "unsupported", "unsupported/shallow") };
    const [gitDir, commonDir] = (await gitText(root, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], options)).trim().split("\n");
    if (realpathSync(gitDir) !== realpathSync(commonDir)) return { ...record, check: block(check, "unsupported", "unsupported/linked-worktree") };
    const sparse = await runGit(root, ["config", "--bool", "core.sparseCheckout"], options);
    if (sparse.stdout.trim() === "true") return { ...record, check: block(check, "unsupported", "unsupported/sparse-checkout") };
    if (existsSync(join(root, ".gitmodules")) || /^160000 /m.test(await gitText(root, ["ls-files", "--stage"], options))) {
      return { ...record, check: block(check, "unsupported", "unsupported/submodules") };
    }

    const { branch, head } = await readHead(root, options);
    check.branch = branch;
    check.head = head;
    if (!branch) return { ...record, check: block(check, "unsupported", "unsupported/detached") };
    if (branch !== targetBranch) return { ...record, check: block(check, "unsupported", "unsupported/not-main") };
    if (!head) return { ...record, check: block(check, "unsupported", "unsupported/no-commits") };
    const remote = await runGit(root, ["remote", "get-url", "origin"], options);
    if (remote.code !== 0) return { ...record, check: block(check, "unsupported", "unsupported/no-origin") };
    record.remoteUrl = remote.stdout.trim();
    check.remoteDisplay = displayRemote(record.remoteUrl);
    const upstream = (await gitText(root, ["for-each-ref", "--format=%(upstream)", `refs/heads/${targetBranch}`], options)).trim();
    check.upstream = upstream ? upstream.replace(/^refs\/remotes\//, "") : null;
    if (upstream && upstream !== targetRef) return { ...record, check: block(check, "unsupported", "unsupported/upstream-mismatch") };

    const busy = await gitBusyMarkers(root, options);
    if (busy.length) {
      check.paths = busy;
      return { ...record, check: block(check, "git-busy", "git-busy") };
    }

    if (options.fetch) {
      const fetched = await runGit(root, ["fetch", "--no-tags", "origin", `+refs/heads/${targetBranch}:${targetRef}`], { ...options, timeoutMs: gitTimeouts.fetch });
      if (fetched.code !== 0 || fetched.timedOut) return { ...record, check: block(check, "failed", `failed/${classifyFetchFailure(fetched)}`) };
    }
    const cached = await runGit(root, ["rev-parse", "--verify", "-q", `${targetRef}^{commit}`], options);
    if (cached.code !== 0) return { ...record, check: block(check, "failed", "failed/no-remote-main") };
    let target = cached.stdout.trim();
    if (options.pinnedTarget) {
      const reachable = await runGit(root, ["merge-base", "--is-ancestor", options.pinnedTarget, targetRef], options);
      if (reachable.code !== 0) return { ...record, check: block(check, "failed", "failed/stale-check") };
      target = options.pinnedTarget;
    }
    check.target = target;

    const [ahead, behind] = (await gitText(root, ["rev-list", "--left-right", "--count", `HEAD...${target}`], options)).trim().split(/\s+/).map(Number);
    check.ahead = ahead;
    check.behind = behind;
    const relationship: UpdateRelationship = ahead === 0 && behind === 0 ? "equal" : behind === 0 ? "ahead" : ahead === 0 ? "behind" : "diverged";
    check.relationship = relationship;

    const changed = await trackedChanges(root, options);
    // Reported for every relationship; it blocks only a fast-forward.
    check.dirty = changed.length > 0;

    let collisions: string[] = [];
    if (relationship === "behind") {
      const log = await gitText(root, ["log", "-z", "--format=%H%x1f%s", "-n", "20", `HEAD..${target}`], options);
      check.incomingCommits = nulList(log).map((line) => {
        const [sha, subject = ""] = line.replace(/^\n/, "").split("\x1f");
        return { sha, subject };
      });
      const allChanged = nulList(await gitText(root, ["diff", "-z", "--name-only", "HEAD", target], options));
      const incoming = nulList(await gitText(root, ["diff", "-z", "--name-only", "--diff-filter=ACRT", "HEAD", target], options));
      const [currentPackage, targetPackage] = await Promise.all([packageJsonAt(root, "HEAD", options), packageJsonAt(root, target, options)]);
      const dependencies = (value: Record<string, unknown> | null) => JSON.stringify([value?.dependencies ?? {}, value?.devDependencies ?? {}]);
      check.targetVersion = typeof targetPackage?.version === "string" ? targetPackage.version : null;
      check.protocolCompatible = targetPackage?.updaterProtocol === (options.protocol ?? updaterProtocol);
      check.dependenciesChanged = allChanged.includes("bun.lock") || dependencies(currentPackage) !== dependencies(targetPackage);
      check.migrationsChanged = allChanged.includes("server/migrations.ts");
      check.launcherChanged = allChanged.some((path) => launcherPaths.includes(path) || (path.startsWith("server/update/") && !path.endsWith(".test.ts")));
      const localOnly = [
        ...nulList(await gitText(root, ["ls-files", "-z", "--others", "--exclude-standard", "--directory"], options)),
        ...nulList(await gitText(root, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], options)),
      ];
      collisions = collidingPaths(incoming, localOnly, options.dbPath ? pathsWithin(root, options.dbPath) : []);
    }

    const drift = await readHead(root, options);
    if (drift.branch !== branch || drift.head !== head) return { ...record, check: block(check, "failed", "failed/stale-check") };

    if (relationship === "equal") check.state = "up-to-date";
    else if (relationship === "ahead") check.state = "ahead";
    else if (relationship === "diverged") block(check, "diverged", "diverged");
    else if (check.dirty) block(check, "dirty", "dirty");
    else if (collisions.length) {
      block(check, "collision", "collision");
      check.paths = collisions.slice(0, 10);
    } else if (!check.protocolCompatible) block(check, "incompatible", "incompatible-protocol");
    else check.state = "eligible";
    if (check.dirty) check.paths = changed.slice(0, 10);
    check.eligible = check.state === "eligible";
    return record;
  } catch (error) {
    const code = error instanceof GitError ? error.code : "git-error";
    return { ...record, check: block(check, "failed", `failed/${code}`) };
  }
}

/** What HEAD and the tree say after a merge attempt, whatever its exit status was. */
export async function reconcileGitState(root: string, from: string, target: string, options: GitOptions = {}): Promise<UpdateGitState> {
  try {
    const { branch, head } = await readHead(root, options);
    const changes = await trackedChanges(root, options);
    if (branch !== targetBranch || changes.length) return "unexpected";
    if (head === target) return "target";
    if (head === from) return "unchanged";
    return "unexpected";
  } catch {
    return "unknown";
  }
}
