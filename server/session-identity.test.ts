import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { db, getAnnotation, getAnnotationVersion, setAnnotationText, setVerdict } from "./store";
import { getPathIndex, getSessionSource, indexSessionPaths, stableSessionId } from "./path-indexer";

const workspace = mkdtempSync(join(tmpdir(), "aiuo-session-identity-"));
let caseNumber = 0;
let root: string;
const filename = "rollout-2026-09-30T12-00-00-fixture.jsonl";
const activeRelative = `.codex/sessions/2026/09/30/${filename}`;
const archivedRelative = `.codex/archived_sessions/${filename}`;
const nativeKey = "identity-fixture";
const transcript = JSON.stringify({ type: "session_meta", payload: { id: nativeKey, cwd: "/fixture/project" } }) + "\n";
beforeEach(() => {
  db.exec("DELETE FROM session_paths; DELETE FROM annotations;");
  root = join(workspace, String(caseNumber++));
});
afterAll(() => { db.exec("DELETE FROM session_paths; DELETE FROM annotations;"); rmSync(workspace, { recursive: true, force: true }); });
async function create(relative: string) {
  const file = join(root, relative);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, transcript);
  return file;
}

test("archiving and restoring a transcript preserve its identity and annotations", async () => {
  const active = await create(activeRelative);
  const first = await indexSessionPaths(root);
  const sessionId = first.catalog[0].sessionId;
  setAnnotationText(sessionId, { tags: ["keep"], note: "Keep this note" });
  setVerdict(sessionId, "good");
  db.query(`INSERT INTO session_effort_state (session_id, parser_version, source_size, source_mtime,
    last_offset, resume_hash, coverage_state, last_indexed_at) VALUES (?, 1, 1, 1, 1, 'hash', 'known', CURRENT_TIMESTAMP)`).run(sessionId);
  // A derived row remains attached through the move, rather than being cascaded away.
  db.query("INSERT INTO session_evidence_meta (session_id, provider, source_mtime, updated_at) VALUES (?, 'codex', 1, CURRENT_TIMESTAMP)").run(sessionId);
  const archived = join(root, archivedRelative);
  await mkdir(dirname(archived), { recursive: true });
  await rename(active, archived);
  const next = await indexSessionPaths(root);
  expect(next.catalog[0].sessionId).toBe(sessionId);
  expect(next.removedSessionIds).toEqual([]);
  expect(getSessionSource(sessionId)?.sourceFile).toBe(archived);
  expect(getAnnotation(sessionId)).toMatchObject({ tags: ["keep"], note: "Keep this note", verdict: "good" });
  expect(db.query("SELECT resume_hash FROM session_effort_state WHERE session_id = ?").get(sessionId)).toEqual({ resume_hash: "hash" });
  expect(db.query("SELECT provider FROM session_evidence_meta WHERE session_id = ?").get(sessionId)).not.toBeNull();
  await rename(archived, active);
  expect((await indexSessionPaths(root)).catalog[0].sessionId).toBe(sessionId);
  expect(getSessionSource(sessionId)?.sourceFile).toBe(active);
  db.query("DELETE FROM session_evidence_meta WHERE session_id = ?").run(sessionId);
});

test("an already archived session recovers its orphaned active-path annotation", async () => {
  const archived = await create(archivedRelative);
  const oldId = stableSessionId("codex", activeRelative, nativeKey);
  setAnnotationText(oldId, { tags: ["before-archive"], note: "Original note" });
  setVerdict(oldId, "mixed");
  const revision = getAnnotationVersion();
  const current = (await indexSessionPaths(root)).catalog[0].sessionId;
  expect(current).not.toBe(oldId);
  expect(getAnnotation(current)).toMatchObject({ tags: ["before-archive"], note: "Original note", verdict: "mixed" });
  expect(getAnnotationVersion()).toBeGreaterThan(revision);
  expect(getSessionSource(oldId)?.sourceFile).toBe(archived);
  setVerdict(oldId, "good");
  expect(getAnnotation(current).verdict).toBe("good");
  const afterRecovery = getAnnotationVersion();
  await indexSessionPaths(root);
  expect(getAnnotationVersion()).toBe(afterRecovery);
});

test.each(["shrink", "unresolved cwd"])("restored sessions retain identity after a %s reparse", async (reason) => {
  const archived = await create(archivedRelative);
  const header = JSON.stringify({ type: "session_meta", payload: {
    id: nativeKey, ...(reason === "shrink" ? { cwd: "/fixture/project" } : {}),
  } }) + "\n";
  await writeFile(archived, header + JSON.stringify({ type: "event_msg", payload: { message: "Original event" } }) + "\n");
  const sessionId = (await indexSessionPaths(root)).catalog[0].sessionId;
  setAnnotationText(sessionId, { tags: ["keep"], note: "Keep this note" });
  setVerdict(sessionId, "good");
  db.query(`INSERT INTO session_effort_state (session_id, parser_version, source_size, source_mtime,
    last_offset, resume_hash, coverage_state, last_indexed_at) VALUES (?, 1, 1, 1, 1, 'hash', 'known', CURRENT_TIMESTAMP)`).run(sessionId);
  const active = join(root, activeRelative);
  await mkdir(dirname(active), { recursive: true });
  await rename(archived, active);
  expect((await indexSessionPaths(root)).catalog[0].sessionId).toBe(sessionId);

  await writeFile(active, reason === "shrink" ? header : header + transcript);
  // Force the reparse independently of filesystem timestamp resolution.
  const modified = new Date(Date.now() + 2000);
  await utimes(active, modified, modified);
  const next = await indexSessionPaths(root);
  expect(next.catalog[0].sessionId).toBe(sessionId);
  expect(next.removedSessionIds).toEqual([]);
  expect(getAnnotation(sessionId)).toMatchObject({ tags: ["keep"], note: "Keep this note", verdict: "good" });
  expect(getSessionSource(stableSessionId("codex", activeRelative, nativeKey))?.sourceFile).toBe(active);
  expect(db.query("SELECT resume_hash FROM session_effort_state WHERE session_id = ?").get(sessionId)).toEqual({ resume_hash: "hash" });
});

test("a replacement transcript with a different native key gets a new identity", async () => {
  const active = await create(activeRelative);
  await writeFile(active, transcript + JSON.stringify({ type: "event_msg", payload: { message: "Original event" } }) + "\n");
  const original = (await indexSessionPaths(root)).catalog[0].sessionId;
  setAnnotationText(original, { tags: ["original"], note: "Original session" });
  await writeFile(active, JSON.stringify({ type: "session_meta", payload: { id: "replacement", cwd: "/fixture/project" } }) + "\n");
  const modified = new Date(Date.now() + 2000);
  await utimes(active, modified, modified);
  const next = await indexSessionPaths(root);
  expect(next.catalog[0].sessionId).not.toBe(original);
  expect(next.removedSessionIds).toEqual([original]);
  expect(getAnnotation(next.catalog[0].sessionId).note).toBe("");
});

test("recovery retains text, tags, and evidence of conflicting user ratings", async () => {
  await create(archivedRelative);
  const archivedId = stableSessionId("codex", archivedRelative, nativeKey);
  const oldId = stableSessionId("codex", activeRelative, nativeKey);
  setAnnotationText(archivedId, { tags: ["after"], note: "New note" });
  setVerdict(archivedId, "good");
  setAnnotationText(oldId, { tags: ["before"], note: "Old note" });
  setVerdict(oldId, "bad");
  await indexSessionPaths(root);
  expect(getAnnotation(archivedId)).toMatchObject({ tags: ["after", "before"], verdict: "good" });
  expect(getAnnotation(archivedId).note).toContain("New note");
  expect(getAnnotation(archivedId).note).toContain("Old note");
  expect(getAnnotation(archivedId).note).toContain("Previous session verdict: bad.");
});

test("coexisting active and archived copies are not treated as a move", async () => {
  await create(activeRelative);
  const initial = (await indexSessionPaths(root)).catalog[0].sessionId;
  setAnnotationText(initial, { tags: [], note: "Active copy" });
  await create(archivedRelative);
  const catalog = (await indexSessionPaths(root)).catalog;
  expect(new Set(catalog.map((row) => row.sessionId)).size).toBe(2);
  const archivedId = catalog.find((row) => row.sourceFile.includes("archived_sessions"))!.sessionId;
  expect(getAnnotation(initial).note).toBe("Active copy");
  expect(getAnnotation(archivedId).note).toBe("");
});

/** Codex's in-place compression: `rollout-….jsonl` becomes `rollout-….jsonl.zst`. */
async function compressInPlace(file: string) {
  await writeFile(`${file}.zst`, Bun.zstdCompressSync(await Bun.file(file).bytes()));
  await rm(file);
  return `${file}.zst`;
}

test("compressing a transcript in place keeps its identity, annotations, and report keys", async () => {
  const plain = await create(activeRelative);
  const sessionId = (await indexSessionPaths(root)).catalog[0].sessionId;
  setAnnotationText(sessionId, { tags: ["keep"], note: "Survives compression" });
  const compressed = await compressInPlace(plain);
  const next = await indexSessionPaths(root);
  expect(next.catalog.map((source) => source.sessionId)).toEqual([sessionId]);
  expect(next.removedSessionIds).toEqual([]);
  expect(getSessionSource(sessionId)?.sourceFile).toBe(compressed);
  expect(getAnnotation(sessionId)).toMatchObject({ tags: ["keep"], note: "Survives compression" });
  // ccusage reports the compressed rollout under its plain dated key.
  expect(getPathIndex()[`codex:2026/09/30/${filename.replace(/\.jsonl$/, "")}`]?.sessionId).toBe(sessionId);
});

test("a log first seen compressed gets the ID its plain form would have had", async () => {
  await compressInPlace(await create(activeRelative));
  const [source] = (await indexSessionPaths(root)).catalog;
  expect(source.sessionId).toBe(stableSessionId("codex", activeRelative, nativeKey));
  expect(getSessionSource(source.sessionId)?.cwd).toBe("/fixture/project");
});

test("while both forms exist, the plain log is the one session", async () => {
  const plain = await create(activeRelative);
  await writeFile(`${plain}.zst`, Bun.zstdCompressSync(await Bun.file(plain).bytes()));
  // Codex restoring a compressed session for resume: the plain copy is the newer one.
  await utimes(`${plain}.zst`, new Date("2026-10-01T00:00:00Z"), new Date("2026-10-01T00:00:00Z"));
  const { catalog, duplicateTranscripts } = await indexSessionPaths(root);
  expect(catalog.map((source) => source.sourceFile)).toEqual([plain]);
  expect(duplicateTranscripts).toEqual({ pairs: 1, stalePlain: [] });
});

test("a plain copy restored beside a newer compressed copy is counted once and reported as stale", async () => {
  // A backup restore copies the plain log back after Codex had already compressed it.
  const compressed = await compressInPlace(await create(activeRelative));
  const sessionId = (await indexSessionPaths(root)).catalog[0].sessionId;
  setAnnotationText(sessionId, { tags: ["keep"], note: "Survives the restore" });
  const plain = compressed.slice(0, -".zst".length);
  await writeFile(plain, transcript);
  await utimes(plain, new Date("2026-09-30T12:00:00Z"), new Date("2026-09-30T12:00:00Z"));
  const restored = await indexSessionPaths(root);
  expect(restored.catalog.map((source) => [source.sessionId, source.sourceFile])).toEqual([[sessionId, plain]]);
  expect(restored.duplicateTranscripts).toEqual({ pairs: 1, stalePlain: [activeRelative] });
  // Moving the stale plain copy aside hands the session back to the compressed log, same ID.
  await rm(plain);
  const cleaned = await indexSessionPaths(root);
  expect(cleaned.catalog.map((source) => [source.sessionId, source.sourceFile])).toEqual([[sessionId, compressed]]);
  expect(cleaned.duplicateTranscripts).toEqual({ pairs: 0, stalePlain: [] });
  expect(getAnnotation(sessionId).note).toBe("Survives the restore");
});
