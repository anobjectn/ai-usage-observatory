import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const autoCheckIntervalMs = 24 * 60 * 60 * 1000;

/** Readers never see a half-written file: write a sibling, then rename over the target. */
export function writeFileAtomic(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

export function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch { return null; }
}

const checkAtPath = (stateDir: string) => join(stateDir, "update-check-at");

/** The background check runs at most once a day. The file holds only a timestamp. */
export function autoCheckDue(stateDir: string, now = Date.now()) {
  const path = checkAtPath(stateDir);
  if (!existsSync(path)) return true;
  const last = Date.parse(readFileSync(path, "utf8").trim());
  return !Number.isFinite(last) || now - last >= autoCheckIntervalMs || last > now;
}

export function recordCheckAt(stateDir: string, at = new Date()) {
  try { writeFileAtomic(checkAtPath(stateDir), at.toISOString()); }
  catch { /* A read-only state directory only makes the next background check run early. */ }
}

/** Removes credentials from URLs in Git output and remote addresses. */
export function redactCredentials(text: string) {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1***@");
}

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
