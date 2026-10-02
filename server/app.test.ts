import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRequestHandler } from "./app";
import type { getSnapshot } from "./collector";
import { db, getAnnotation, getAnnotationVersion, listRules, setVerdict } from "./store";
import { dashboardFixture } from "../tests/fixtures/dashboard";

let snapshot = dashboardFixture();
const read = async () => ({ ...snapshot, sessions: snapshot.sessions.map((session) => ({ ...session, annotation: getAnnotation(session.sessionId) })) }) as unknown as Awaited<ReturnType<typeof getSnapshot>>;
const handle = createRequestHandler({ getSnapshot: read, refresh: read });
const originalHosts = process.env.USAGE_OBSERVATORY_ALLOWED_HOSTS;
beforeEach(() => { snapshot = dashboardFixture(); delete process.env.USAGE_OBSERVATORY_ALLOWED_HOSTS; });
afterEach(() => {
  if (originalHosts === undefined) delete process.env.USAGE_OBSERVATORY_ALLOWED_HOSTS;
  else process.env.USAGE_OBSERVATORY_ALLOWED_HOSTS = originalHosts;
});

function request(path: string, method = "GET", payload?: unknown, headers: Record<string, string> = {}) {
  return handle(new Request(`http://127.0.0.1:4318${path}`, {
    method, headers: { host: "127.0.0.1:4318", ...(payload === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  }));
}

describe("API mutation boundary", () => {
  for (const [path, method] of [
    ["/api/rules", "POST"], ["/api/rules/1", "PUT"], ["/api/rules/1", "DELETE"],
    ["/api/refresh", "POST"], ["/api/settings", "PUT"], ["/api/effort/settings", "PUT"],
    ["/api/effort/derived", "DELETE"], ["/api/sessions/fixture/annotations", "PUT"],
    ["/api/sessions/fixture/verdict", "PUT"], ["/api/sessions/fixture/external-open", "POST"],
    ["/api/quotas/anthropic-web-import", "POST"], ["/api/advice/1/dismiss", "POST"],
    ["/api/session-quota-contexts", "POST"],
  ]) {
    test(`rejects a cross-site ${method} to ${path}`, async () => {
      const response = await request(path, method, {}, { origin: "https://unrelated.example", "sec-fetch-site": "cross-site", "content-type": "text/plain" });
      expect(response.status).toBe(403);
    });
  }

  test("rejects non-JSON bodies before writing a rule", async () => {
    const count = listRules().length;
    const response = await request("/api/rules", "POST", { pattern: "**", tag: "fixture", kind: "glob" }, { "content-type": "text/plain" });
    expect(response.status).toBe(415);
    expect(listRules()).toHaveLength(count);
  });

  test("permits local CLI, Vite browser, and configured remote browser requests", async () => {
    expect((await request("/api/refresh", "POST")).status).toBe(200);
    expect((await request("/api/refresh", "POST", undefined, { origin: "http://127.0.0.1:5173", "sec-fetch-site": "same-origin" })).status).toBe(200);
    process.env.USAGE_OBSERVATORY_ALLOWED_HOSTS = "fixture.tailnet.ts.net";
    expect((await request("/api/refresh", "POST", undefined, { host: "fixture.tailnet.ts.net", origin: "https://fixture.tailnet.ts.net" })).status).toBe(200);
    expect((await request("/api/refresh", "POST", undefined, { host: "fixture.tailnet.ts.net" })).status).toBe(403);
  });
});

describe("API input validation", () => {
  for (const path of ["/api/rules", "/api/effort/settings", "/api/session-quota-contexts", "/api/quotas/anthropic-web-import", "/api/advice/1/snooze"]) {
    for (const value of [null, [], "text", 1]) {
      test(`${path} rejects ${JSON.stringify(value)} with 400`, async () => {
        expect((await request(path, path === "/api/effort/settings" ? "PUT" : "POST", value)).status).toBe(400);
      });
    }
  }
  test("malformed JSON has a validation response", async () => {
    const response = await handle(new Request("http://127.0.0.1:4318/api/rules", { method: "POST", headers: { host: "127.0.0.1:4318", "content-type": "application/json" }, body: "{" }));
    expect(response.status).toBe(400);
  });
  test("creation and update reject missing fields and malformed regexes", async () => {
    for (const [method, path] of [["POST", "/api/rules"], ["PUT", "/api/rules/1"]]) {
      for (const value of [{}, { pattern: "[", kind: "regex", tag: "fixture" }, { pattern: "**", kind: "invalid", tag: "fixture" }, { pattern: "**", kind: "glob", tag: {} }]) {
        expect((await request(path, method, value)).status).toBe(400);
      }
    }
  });
  test("valid rule creation and update use the same contract", async () => {
    const created = await request("/api/rules", "POST", { pattern: "**/fixture", kind: "glob", tag: "fixture" });
    expect(created.status).toBe(201);
    const rule = await created.json();
    expect((await request(`/api/rules/${rule.id}`, "PUT", { pattern: "fixture$", kind: "regex", tag: "fixture-updated" })).status).toBe(200);
    db.query("DELETE FROM path_rules WHERE id = ?").run(rule.id);
  });
  test("invalid annotation, verdict, settings, and pagination values do not produce 500", async () => {
    for (const [path, value] of [["/api/sessions/fixture/annotations", { tags: [1] }], ["/api/sessions/fixture/verdict", {}], ["/api/settings", { monthlyBudget: {} }]]) {
      expect((await request(String(path), "PUT", value)).status).toBe(400);
    }
    for (const query of ["page=NaN", "limit=0", "page=1.5", "limit=Infinity"]) expect((await request(`/api/sessions?${query}`)).status).toBe(400);
  });
});

test("dashboard ETags expose failure, recovery, and annotation changes", async () => {
  const initial = await request("/api/dashboard");
  const healthyTag = initial.headers.get("etag")!;
  expect((await request("/api/dashboard", "GET", undefined, { "if-none-match": healthyTag })).status).toBe(304);
  snapshot.refresh = { inProgress: false, stale: true, lastError: "Fixture collection failed" };
  const failed = await request("/api/dashboard", "GET", undefined, { "if-none-match": healthyTag });
  expect(failed.status).toBe(200);
  expect((await failed.json()).refresh.stale).toBe(true);
  const failedTag = failed.headers.get("etag")!;
  snapshot.refresh = { inProgress: false, stale: false, lastError: null };
  expect((await request("/api/dashboard", "GET", undefined, { "if-none-match": failedTag })).status).toBe(200);
  const revision = getAnnotationVersion();
  setVerdict("fixture-session", "good");
  expect(getAnnotationVersion()).toBeGreaterThan(revision);
  const rated = await request("/api/dashboard", "GET", undefined, { "if-none-match": healthyTag });
  expect(rated.status).toBe(200);
  expect((await rated.json()).sessions[0].annotation.verdict).toBe("good");
  db.query("DELETE FROM annotations WHERE session_id = 'fixture-session'").run();
});
