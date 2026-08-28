import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { migrations, runMigrations } from "./migrations";
import {
  db,
  getAnnotation,
  getAnnotations,
  getAnnotationVersion,
  isVerdict,
  setAnnotationText,
  setVerdict,
} from "./store";

beforeEach(() => db.query("DELETE FROM annotations").run());

describe("field-preserving annotation writes", () => {
  test("a tag or note edit preserves a recorded verdict", () => {
    setVerdict("s1", "good");
    setAnnotationText("s1", { tags: ["refactor"], note: "kept going" });
    expect(getAnnotation("s1")).toMatchObject({ tags: ["refactor"], note: "kept going", verdict: "good" });
  });

  test("a verdict write preserves tags and note", () => {
    setAnnotationText("s2", { tags: ["spike"], note: "context heavy" });
    const updated = setVerdict("s2", "bad");
    expect(updated).toMatchObject({ tags: ["spike"], note: "context heavy", verdict: "bad" });
    expect(getAnnotations().s2).toMatchObject({ tags: ["spike"], note: "context heavy", verdict: "bad" });
  });

  test("null clears the verdict without touching the rest", () => {
    setAnnotationText("s3", { tags: ["a"], note: "n" });
    setVerdict("s3", "mixed");
    expect(setVerdict("s3", null)).toMatchObject({ tags: ["a"], note: "n", verdict: null });
  });

  test("a verdict on a session with no annotation row starts from empty text", () => {
    expect(setVerdict("fresh", "good")).toMatchObject({ tags: [], note: "", verdict: "good" });
  });

  test("an unrated session reads as a null verdict, never a default rating", () => {
    expect(getAnnotation("never-seen")).toEqual({ tags: [], note: "", verdict: null });
    expect(isVerdict("great")).toBe(false);
    expect(isVerdict(null)).toBe(false);
    expect(isVerdict("mixed")).toBe(true);
  });

  test("every write advances the annotation revision", () => {
    const start = getAnnotationVersion();
    setVerdict("s4", "good");
    const afterVerdict = getAnnotationVersion();
    expect(afterVerdict).toBeGreaterThan(start);
    setAnnotationText("s4", { tags: [], note: "x" });
    expect(getAnnotationVersion()).toBeGreaterThan(afterVerdict);
  });
});

describe("migration 4", () => {
  test("upgrades a database at version 3 without losing annotations", () => {
    const legacy = new Database(":memory:");
    runMigrations(legacy, migrations.filter((migration) => migration.id <= 3));
    expect(Number((legacy.query("PRAGMA user_version").get() as { user_version: number }).user_version)).toBe(3);
    legacy.query("INSERT INTO annotations (session_id, tags, note) VALUES (?, ?, ?)")
      .run("legacy", JSON.stringify(["keep"]), "still here");

    runMigrations(legacy, migrations);

    expect(Number((legacy.query("PRAGMA user_version").get() as { user_version: number }).user_version)).toBe(6);
    const row = legacy.query("SELECT tags, note, verdict FROM annotations WHERE session_id = 'legacy'").get() as
      { tags: string; note: string; verdict: string | null };
    expect(row).toEqual({ tags: JSON.stringify(["keep"]), note: "still here", verdict: null });
    expect(legacy.query("SELECT version FROM annotation_meta WHERE id = 1").get()).toEqual({ version: 0 });
    // The column rejects a value that is not one of the three verdicts.
    expect(() => legacy.query("UPDATE annotations SET verdict = 'excellent' WHERE session_id = 'legacy'").run()).toThrow();
    legacy.close();
  });

  test("re-running the migration set is a no-op", () => {
    const database = new Database(":memory:");
    runMigrations(database);
    database.query("INSERT INTO annotations (session_id, verdict) VALUES ('a', 'good')").run();
    runMigrations(database);
    expect(database.query("SELECT verdict FROM annotations WHERE session_id = 'a'").get()).toEqual({ verdict: "good" });
    database.close();
  });
});
