import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, runGit, updaterProtocol } from "./git";

/** The identity of this server process. The launcher passes `bootId` so it can tell a fresh
 * server from one that was already running on the port. */
export const bootId = process.env.USAGE_OBSERVATORY_BOOT_ID || randomUUID();
export const bootStartedAt = new Date().toISOString();
let bootCommit: string | null = null;
let bootVersion: string | null = null;

/** Read once at boot: the commit and version this process loaded, not what is on disk later. */
export async function initBootIdentity(root = repoRoot) {
  try { bootVersion = String(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? "") || null; }
  catch { bootVersion = null; }
  const head = await runGit(root, ["rev-parse", "HEAD"]).catch(() => null);
  bootCommit = head?.code === 0 ? head.stdout.trim() : null;
}

export function runningIdentity() {
  return { commit: bootCommit, version: bootVersion, pid: process.pid, bootId, protocol: updaterProtocol, startedAt: bootStartedAt };
}
