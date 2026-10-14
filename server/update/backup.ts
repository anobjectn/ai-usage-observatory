import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const backupPrefix = "pre-update-";
const keepBackups = 3;

export const backupDirectory = (stateDir: string) => join(stateDir, "backups");

/** Copies the database before an update. `VACUUM INTO` reads through the WAL, so rows not yet
 * checkpointed are included. No migration runs: the file is opened without the store. Returns
 * null when there is no database yet. */
export function backupDatabase(dbPath: string, stateDir: string, from: string, now = new Date()) {
  if (!existsSync(dbPath)) return null;
  const directory = backupDirectory(stateDir);
  mkdirSync(directory, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const path = join(directory, `${backupPrefix}${from.slice(0, 7)}-${stamp}.db`);
  const source = new Database(dbPath, { readwrite: true, create: false });
  try {
    source.exec("PRAGMA busy_timeout = 5000");
    source.query("VACUUM INTO ?").run(path);
  } finally { source.close(); }
  const copy = new Database(path, { readonly: true });
  try {
    const result = copy.query("PRAGMA integrity_check").get() as { integrity_check?: string } | null;
    if (result?.integrity_check !== "ok") throw new Error(`Backup failed its integrity check: ${result?.integrity_check ?? "no result"}`);
  } catch (error) {
    copy.close();
    rmSync(path, { force: true });
    throw error;
  }
  copy.close();
  return path;
}

export function listBackups(stateDir: string) {
  const directory = backupDirectory(stateDir);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.startsWith(backupPrefix) && name.endsWith(".db"))
    .map((name) => join(directory, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs || right.localeCompare(left));
}

/** Keeps the newest three, and never deletes a backup an unresolved failed job points to. */
export function pruneBackups(stateDir: string, referenced: Array<string | undefined> = []) {
  const keep = new Set(referenced.filter(Boolean));
  for (const [index, path] of listBackups(stateDir).entries()) {
    if (index < keepBackups || keep.has(path)) continue;
    rmSync(path, { force: true });
  }
}

export const newestBackup = (stateDir: string) => listBackups(stateDir)[0] ?? null;
