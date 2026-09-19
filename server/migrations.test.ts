import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runMigrations } from "./migrations";

const ruleCount = (db: Database) =>
  (db.query("SELECT COUNT(*) AS count FROM path_rules").get() as { count: number }).count;

describe("default path rules", () => {
  test("a brand-new database receives both defaults", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    expect(ruleCount(db)).toBe(2);
  });

  test("deleting every rule sticks across a restart", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    db.exec("DELETE FROM path_rules");
    // A restart runs the migrations again against the same file.
    runMigrations(db);
    expect(ruleCount(db)).toBe(0);
  });

  test("an upgraded database with no rules stays empty", () => {
    const db = new Database(":memory:");
    // State left by a version 7 build: booted once, then the user deleted every rule.
    runMigrations(db);
    db.exec("DELETE FROM path_rules; PRAGMA user_version = 7;");
    db.exec("INSERT INTO settings (key, value) VALUES ('monthlyBudget', '250')");
    runMigrations(db);
    expect(ruleCount(db)).toBe(0);
  });
});
