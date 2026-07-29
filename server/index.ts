import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { getSnapshot, refresh } from "./collector";
import { buildInsights, resolveScope } from "./insights";
import { importAnthropicWebCredits } from "./quota";
import { getSessionDetail } from "./session-detail";
import { buildEffortAggregate, buildEffortSessionDigest, buildEffortStatus, buildSessionEffortSummary, clearEffortMemo, effortEtag, memoizedBody, resolveEffortGroup, resolveEffortScope, scopeKey } from "./effort-api";
import { scheduleEffortIndexing } from "./effort-index";
import { deleteEffortDerived, setEffortEnabled } from "./effort-store";
import { createRule, deleteRule, getSettings, listAdvice, listRules, setAnnotation, setSettings, updateAdviceState, updateRule } from "./store";

const port = Number(process.env.PORT ?? 4318);
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const dashboard = (request: Request, value: Awaited<ReturnType<typeof getSnapshot>>) => {
  const etag = `\"${value.collectedAt}\"`;
  const headers = { "Cache-Control": "private, no-cache", ETag: etag };
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return Response.json(value, { headers });
};

const effortHeaders = (etag: string) => ({ "Cache-Control": "private, no-cache", ETag: etag });

/** Effort responses are conditional on both the snapshot and the private index version, so a
 * background backfill invalidates them without `/api/dashboard` gaining an effort field. */
function conditional(request: Request, etag: string, build: () => unknown) {
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: effortHeaders(etag) });
  return Response.json(build(), { headers: effortHeaders(etag) });
}

function conditionalBody(request: Request, etag: string, build: () => string) {
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: effortHeaders(etag) });
  return new Response(build(), { headers: { ...effortHeaders(etag), "Content-Type": "application/json" } });
}

async function body(request: Request) {
  try { return await request.json() as Record<string, unknown>; }
  catch { throw new Error("Expected a JSON request body"); }
}

function errorResponse(error: unknown, status = 500) {
  return json({ error: error instanceof Error ? error.message : String(error) }, status);
}

function isLoopbackHost(host: string | null) {
  if (!host) return false;
  try { return ["127.0.0.1", "::1", "localhost"].includes(new URL(`http://${host}`).hostname); }
  catch { return false; }
}

function isWithin(directory: string, target: string) {
  const path = relative(directory, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function api(request: Request, url: URL) {
  const path = url.pathname;
  if (request.method === "GET" && path === "/api/dashboard") return dashboard(request, await getSnapshot());
  if (request.method === "GET" && path === "/api/insights") {
    const snapshot = await getSnapshot();
    const scope = resolveScope(url.searchParams);
    const key = effortEtag(["/api/insights", snapshot.collectedAt, buildEffortStatus().indexVersion, JSON.stringify(scope)]);
    if (request.headers.get("if-none-match") === key) return new Response(null, { status: 304, headers: { "Cache-Control": "private, no-cache", ETag: key } });
    return Response.json(buildInsights(snapshot as unknown as import("../src/types").DashboardData, scope), { headers: { "Cache-Control": "private, no-cache", ETag: key } });
  }
  if (request.method === "GET" && path === "/api/effort/status") {
    const status = buildEffortStatus();
    return conditional(request, effortEtag(["status", status.indexVersion, status.phase, status.quality, status.progress?.pendingBytes ?? -1, status.progress?.indexedBytes ?? -1]), () => status);
  }
  if (request.method === "PUT" && path === "/api/effort/settings") {
    const input = await body(request);
    if (typeof input.enabled !== "boolean") return errorResponse("enabled must be a boolean", 400);
    setEffortEnabled(input.enabled);
    clearEffortMemo();
    // The backlog is a join of the path catalog against parser state, and the catalog is only
    // populated by a successful collection. Without this, enabling before the first refresh finds
    // nothing to do and reports "ready" with zero indexed sessions. This awaits the snapshot,
    // never the transcript parsing it schedules.
    if (input.enabled) {
      await getSnapshot();
      scheduleEffortIndexing();
    }
    return json(buildEffortStatus());
  }
  if (request.method === "DELETE" && path === "/api/effort/derived") {
    deleteEffortDerived();
    clearEffortMemo();
    return json(buildEffortStatus());
  }
  if (request.method === "GET" && (path === "/api/effort" || path === "/api/effort/sessions")) {
    const snapshot = await getSnapshot();
    const scope = resolveEffortScope(url.searchParams);
    const group = resolveEffortGroup(url.searchParams.get("group"));
    const status = buildEffortStatus();
    const isDigest = path === "/api/effort/sessions";
    const etag = effortEtag([path, snapshot.collectedAt, status.indexVersion, isDigest ? "digest" : group, scopeKey(scope)]);
    const data = snapshot as unknown as import("../src/types").DashboardData;
    return conditionalBody(request, etag, () => memoizedBody(etag, () => (isDigest ? buildEffortSessionDigest(data, scope) : buildEffortAggregate(data, scope, group))));
  }
  if (request.method === "GET" && path === "/api/advice") return json(listAdvice(url.searchParams.get("state") ?? "active"));
  if (request.method === "GET" && path === "/api/advice/log") return json(listAdvice());
  const adviceMatch = path.match(/^\/api\/advice\/(\d+)\/(dismiss|snooze|feedback)$/);
  if (adviceMatch && request.method === "POST") {
    const action = adviceMatch[2];
    const input = await body(request);
    if (action === "feedback") return json(updateAdviceState(Number(adviceMatch[1]), "dismissed"));
    const until = action === "snooze" && input.snoozedUntil ? String(input.snoozedUntil) : null;
    if (action === "snooze" && !until) return errorResponse("snoozedUntil is required", 400);
    return json(updateAdviceState(Number(adviceMatch[1]), action === "snooze" ? "snoozed" : "dismissed", until));
  }
  if (request.method === "POST" && path === "/api/refresh") return json(await refresh());
  if (request.method === "POST" && path === "/api/quotas/anthropic-web-import") {
    let payload: Record<string, unknown>;
    try { payload = await body(request); }
    catch { return errorResponse("Expected a JSON object body", 400); }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return errorResponse("Expected a JSON object body", 400);
    let result: Awaited<ReturnType<typeof importAnthropicWebCredits>>;
    try { result = await importAnthropicWebCredits(payload); }
    catch (error) { return errorResponse(error, 502); }
    // Forward the producer's rejection verbatim; a failed import must leave the
    // prior imported observation (and the whole dashboard) untouched.
    if (result.status < 200 || result.status >= 300) return json(result.data ?? { error: "Import rejected" }, result.status);
    const snapshot = await refresh();
    return json({ ok: true, import: result.data, quotas: snapshot.quotas });
  }
  if (request.method === "GET" && path === "/api/rules") return json(listRules());
  if (request.method === "POST" && path === "/api/rules") {
    const input = await body(request);
    if (!input.pattern || !input.tag || !["glob", "regex"].includes(String(input.kind))) return errorResponse("pattern, tag, and a valid kind are required", 400);
    return json(createRule({ pattern: String(input.pattern), tag: String(input.tag), kind: input.kind as "glob" | "regex" }), 201);
  }
  const ruleMatch = path.match(/^\/api\/rules\/(\d+)$/);
  if (ruleMatch && request.method === "PUT") {
    const input = await body(request);
    return json(updateRule(Number(ruleMatch[1]), { pattern: String(input.pattern), tag: String(input.tag), kind: input.kind as "glob" | "regex" }));
  }
  if (ruleMatch && request.method === "DELETE") { deleteRule(Number(ruleMatch[1])); return new Response(null, { status: 204 }); }
  const annotationMatch = path.match(/^\/api\/sessions\/([^/]+)\/annotations$/);
  if (annotationMatch && request.method === "PUT") {
    const input = await body(request);
    setAnnotation(decodeURIComponent(annotationMatch[1]), { tags: Array.isArray(input.tags) ? input.tags.map(String) : [], note: String(input.note ?? "") });
    return json({ ok: true });
  }
  const detailMatch = path.match(/^\/api\/sessions\/([^/]+)\/detail$/);
  if (detailMatch && request.method === "GET") {
    const sessionId = decodeURIComponent(detailMatch[1]);
    const [detail, snapshot] = await Promise.all([getSessionDetail(sessionId), getSnapshot()]);
    return json({ ...detail, effort: buildSessionEffortSummary(snapshot as unknown as import("../src/types").DashboardData, sessionId) });
  }
  if (path === "/api/settings" && request.method === "GET") return json(getSettings());
  if (path === "/api/settings" && request.method === "PUT") { setSettings(await body(request) as Record<string, string>); return json(getSettings()); }

  const snapshot = await getSnapshot();
  if (request.method === "GET" && path === "/api/overview") return json({ totals: snapshot.totals, blocks: snapshot.blocks, quotas: snapshot.quotas, sources: snapshot.sources, collectedAt: snapshot.collectedAt });
  if (request.method === "GET" && path === "/api/usage") return json({ daily: snapshot.daily, weekly: snapshot.weekly, monthly: snapshot.monthly });
  if (request.method === "GET" && path === "/api/sessions") {
    const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 25)));
    return json({ items: snapshot.sessions.slice((page - 1) * limit, page * limit), total: snapshot.sessions.length, page, limit });
  }
  if (request.method === "GET" && path === "/api/projects") return json(snapshot.projects);
  if (request.method === "GET" && path === "/api/models") return json(snapshot.models);
  if (request.method === "GET" && path === "/api/blocks") return json(snapshot.blocks);
  if (request.method === "GET" && path === "/api/quotas") return json(snapshot.quotas);
  if (request.method === "GET" && path === "/api/sources") return json(snapshot.sources);
  if (request.method === "GET" && path === "/api/themes") return json([{ id: "observatory", name: "Observatory", active: true }]);
  return errorResponse("Not found", 404);
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (!isLoopbackHost(request.headers.get("host"))) return errorResponse("Forbidden host", 403);
      if (url.pathname.startsWith("/api/")) return await api(request, url);
      const dist = resolve(process.cwd(), "dist");
      if (existsSync(dist)) {
        const requested = resolve(dist, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
        const file = Bun.file(isWithin(dist, requested) && existsSync(requested) ? requested : resolve(dist, "index.html"));
        return new Response(file);
      }
      return new Response("AI Usage Observatory API is running. Start Vite with `bun run dev:client`.", { status: 200 });
    } catch (error) { return errorResponse(error); }
  },
});

console.log(`AI Usage Observatory listening on http://${server.hostname}:${server.port}`);
