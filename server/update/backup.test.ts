import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDbPath } from "../db-path";
import { backupDatabase, listBackups, pruneBackups } from "./backup";

let directory = "";
afterEach(() => rmSync(directory, { recursive: true, force: true }));

test("a WAL database with uncheckpointed rows is copied completely and passes integrity_check", () => {
  directory = mkdtempSync(join(tmpdir(), "aiuo-backup-"));
  const dbPath = resolveDbPath({ USAGE_OBSERVATORY_DB: "data/app.db" }, directory);
  mkdirSync(join(directory, "data"));
  const live = new Database(dbPath, { create: true });
  live.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE rows (value TEXT); PRAGMA user_version = 4;");
  for (let index = 0; index < 50; index++) live.query("INSERT INTO rows VALUES (?)").run(`row ${index}`);
  const path = backupDatabase(dbPath, join(directory, "state"), "abcdef0123456789")!;
  live.close();
  expect(path).toContain("pre-update-abcdef0-");
  const copy = new Database(path, { readonly: true });
  expect((copy.query("SELECT COUNT(*) AS count FROM rows").get() as { count: number }).count).toBe(50);
  expect((copy.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
  // The backup reads the file as it is; no migration ran on it.
  expect((copy.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(4);
  expect(copy.query("SELECT name FROM sqlite_master WHERE name = 'path_rules'").get()).toBeNull();
  copy.close();
});

test("an absolute path works and a missing database needs no backup", () => {
  directory = mkdtempSync(join(tmpdir(), "aiuo-backup-"));
  const dbPath = resolveDbPath({ USAGE_OBSERVATORY_DB: join(directory, "absolute.db") }, "/elsewhere");
  expect(backupDatabase(dbPath, join(directory, "state"), "abcdef0")).toBeNull();
  new Database(dbPath, { create: true }).close();
  expect(backupDatabase(dbPath, join(directory, "state"), "abcdef0")).not.toBeNull();
});

test("retention keeps the newest three and any referenced backup", () => {
  directory = mkdtempSync(join(tmpdir(), "aiuo-backup-"));
  const backups = join(directory, "backups");
  mkdirSync(backups);
  const paths = Array.from({ length: 6 }, (_, index) => {
    const path = join(backups, `pre-update-000000${index}-${index}.db`);
    writeFileSync(path, "");
    utimesSync(path, 1000 + index, 1000 + index);
    return path;
  });
  pruneBackups(directory, [paths[0]]);
  expect(listBackups(directory).sort()).toEqual([paths[0], paths[3], paths[4], paths[5]].sort());
});
