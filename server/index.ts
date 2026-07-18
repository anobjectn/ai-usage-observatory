import { existsSync } from "node:fs";
import { join } from "node:path";
import { getSnapshot, refresh } from "./collector";
import { createRule, deleteRule, getSettings, listRules, setAnnotation, setSettings, updateRule } from "./store";

const port = Number(process.env.PORT ?? 4318);
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

async function body(request: Request) {
  try { return await request.json() as Record<string, unknown>; }
  catch { throw new Error("Expected a JSON request body"); }
}

function errorResponse(error: unknown, status = 500) {
  return json({ error: error instanceof Error ? error.message : String(error) }, status);
}

async function api(request: Request, url: URL) {
  const path = url.pathname;
  if (request.method === "GET" && path === "/api/dashboard") return json(await getSnapshot());
  if (request.method === "POST" && path === "/api/refresh") return json(await refresh());
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
      if (url.pathname.startsWith("/api/")) return await api(request, url);
      const dist = join(process.cwd(), "dist");
      if (existsSync(dist)) {
        const requested = join(dist, url.pathname === "/" ? "index.html" : url.pathname);
        const file = Bun.file(existsSync(requested) ? requested : join(dist, "index.html"));
        return new Response(file);
      }
      return new Response("AI Usage Observatory API is running. Start Vite with `bun run dev:client`.", { status: 200 });
    } catch (error) { return errorResponse(error); }
  },
});

console.log(`AI Usage Observatory listening on http://${server.hostname}:${server.port}`);
refresh().catch((error) => console.error("Initial refresh failed:", error));
setInterval(() => refresh().catch(() => undefined), 60_000);
