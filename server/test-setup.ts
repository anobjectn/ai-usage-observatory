import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Preloaded by `bunfig.toml` before any test module. `server/store.ts` resolves its database
 * path once at import time, so this has to happen here rather than inside a test file: otherwise
 * the first test file to import the store decides the path for every other one, and a suite that
 * truncates tables would truncate the developer's real database. */
export const testDatabaseDirectory = mkdtempSync(join(tmpdir(), "usage-observatory-test-"));
process.env.USAGE_OBSERVATORY_DB = join(testDatabaseDirectory, "test.db");
// Antigravity's real conversation databases hold the user's prompts. No test may read them, so
// the collector is pointed at an empty directory; a suite that needs data builds its own.
export const testAntigravityDirectory = join(testDatabaseDirectory, "antigravity");
mkdirSync(testAntigravityDirectory);
process.env.ANTIGRAVITY_DATA_DIRS = testAntigravityDirectory;

process.on("exit", () => rmSync(testDatabaseDirectory, { recursive: true, force: true }));
