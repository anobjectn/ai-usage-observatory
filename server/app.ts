import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { getSnapshot, refresh } from "./collector";
import { buildInsights, resolveScope } from "./insights";
import { dailyWeeklyQuotaSeries, importAnthropicWebCredits } from "./quota";
import { getSessionDetail } from "./session-detail";
import { getSessionQuotaContext } from "./session-quota-context";
import { collectAllowanceComparisonReport } from "./quota-comparisons";
import { ExternalOpenError, openSessionExternalTarget } from "./external-open";
import { buildEffortAggregate, buildEffortComboBoard, buildEffortComboDays, buildEffortSessionDigest, buildEffortStatus, buildSessionEffortCombos, buildSessionEffortSummary, clearEffortMemo, effortEtag, memoizedBody, resolveEffortGroup, resolveEffortScope, scopeKey } from "./effort-api";
import { scheduleEffortIndexing } from "./effort-index";
import { deleteEffortDerived, setEffortEnabled } from "./effort-store";
import { requestHostAllowed, requestOriginAllowed } from "./request-host";
import { createRule, deleteRule, getAnnotationVersion, getSettings, listAdvice, listRules, resolveSessionId, setAnnotationText, setSettings, setVerdict, updateAdviceState, updateRule } from "./store";

import { annotationBody, effortSettingsBody, externalOpenBody, objectBody, pageNumber, quotaContextsBody, readBody, RequestInputError, ruleBody, settingsBody, snoozeBody, verdictBody } from "./request-body";

type Services = { getSnapshot: typeof getSnapshot; refresh: typeof refresh };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const dashboard = (request: Request, value: Awaited<ReturnType<typeof getSnapshot>>) => {
  // Both annotation edits and refresh failures change the body without changing collectedAt.
  const etag = effortEtag(["dashboard", value.collectedAt, getAnnotationVersion(), JSON.stringify(value.refresh)]);
  const headers = { "Cache-Control": "private, no-cache", ETag: etag };
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  // The full quota series stays server-side for insights; the browser gets a day-grained
  // weekly-window down-sample for the headroom overlay — the raw series is by far the
  // largest part of the payload.
  const { series, ...history } = value.quotas.history;
  const slimSeries = dailyWeeklyQuotaSeries(series, value.timeZone);
  return Response.json(
    { ...value, quotas: { ...value.quotas, history: { ...history, series: slimSeries } } },
    { headers },
  );
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

function errorResponse(error: unknown, status = 500) {
  return json({ error: error instanceof Error ? error.message : String(error) }, status);
}

function isWithin(directory: string, target: string) {
  const path = relative(directory, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function api(request: Request, url: URL, services: Services) {
  const path = url.pathname;
  if (request.method === "GET" && path === "/api/dashboard") return dashboard(request, await services.getSnapshot());
  if (request.method === "GET" && path === "/api/insights") {
    const snapshot = await services.getSnapshot();
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
    const input = await readBody(request, effortSettingsBody);
    setEffortEnabled(input.enabled);
    clearEffortMemo();
    // The backlog is a join of the path catalog against parser state, and the catalog is only
    // populated by a successful collection. Without this, enabling before the first refresh finds
    // nothing to do and reports "ready" with zero indexed sessions. This awaits the snapshot,
    // never the transcript parsing it schedules.
    if (input.enabled) {
      await services.getSnapshot();
      scheduleEffortIndexing();
    }
    return json(buildEffortStatus());
  }
  if (request.method === "DELETE" && path === "/api/effort/derived") {
    deleteEffortDerived();
    clearEffortMemo();
    return json(buildEffortStatus());
  }
  if (request.method === "GET" && (path === "/api/effort" || path === "/api/effort/sessions" || path === "/api/effort/combo-days" || path === "/api/effort/combos")) {
    const snapshot = await services.getSnapshot();
    const scope = resolveEffortScope(url.searchParams);
    const group = resolveEffortGroup(url.searchParams.get("group"));
    const status = buildEffortStatus();
    const kind = path === "/api/effort/sessions"
      ? "digest"
      : path === "/api/effort/combo-days"
        ? "combo-days"
        : path === "/api/effort/combos"
          ? "combos"
          : group;
    // The scoreboard reports verdicts, which change neither `collectedAt` nor the index version.
    // Without the annotation revision a new rating would sit behind a 304 and a memoized body.
    const etag = effortEtag([path, snapshot.collectedAt, status.indexVersion, kind, scopeKey(scope), kind === "combos" ? getAnnotationVersion() : 0]);
    const data = snapshot as unknown as import("../src/types").DashboardData;
    return conditionalBody(request, etag, () => memoizedBody(etag, () =>
      kind === "digest"
        ? buildEffortSessionDigest(data, scope)
        : kind === "combo-days"
          ? buildEffortComboDays(data, scope)
          : kind === "combos"
            ? buildEffortComboBoard(data, scope)
            : buildEffortAggregate(data, scope, group)));
  }
  if (request.method === "GET" && path === "/api/advice") return json(listAdvice(url.searchParams.get("state") ?? "active"));
  if (request.method === "GET" && path === "/api/advice/log") return json(listAdvice());
  const adviceMatch = path.match(/^\/api\/advice\/(\d+)\/(dismiss|snooze|feedback)$/);
  if (adviceMatch && request.method === "POST") {
    const action = adviceMatch[2];
    const input = await readBody(request, action === "snooze" ? snoozeBody : objectBody);
    if (action === "feedback") return json(updateAdviceState(Number(adviceMatch[1]), "dismissed"));
    const until = action === "snooze" && input.snoozedUntil ? String(input.snoozedUntil) : null;
    if (action === "snooze" && !until) return errorResponse("snoozedUntil is required", 400);
    return json(updateAdviceState(Number(adviceMatch[1]), action === "snooze" ? "snoozed" : "dismissed", until));
  }
  if (request.method === "POST" && path === "/api/refresh") return json(await services.refresh());
  if (request.method === "POST" && path === "/api/quotas/anthropic-web-import") {
    const payload = await readBody(request, objectBody);
    let result: Awaited<ReturnType<typeof importAnthropicWebCredits>>;
    try { result = await importAnthropicWebCredits(payload); }
    catch (error) { return errorResponse(error, 502); }
    // Forward the producer's rejection verbatim; a failed import must leave the
    // prior imported observation (and the whole dashboard) untouched.
    if (result.status < 200 || result.status >= 300) return json(result.data ?? { error: "Import rejected" }, result.status);
    const snapshot = await services.refresh();
    return json({ ok: true, import: result.data, quotas: snapshot.quotas });
  }
  if (request.method === "GET" && path === "/api/rules") return json(listRules());
  if (request.method === "POST" && path === "/api/rules") {
    return json(createRule(await readBody(request, ruleBody)), 201);
  }
  const ruleMatch = path.match(/^\/api\/rules\/(\d+)$/);
  if (ruleMatch && request.method === "PUT") {
    const rule = updateRule(Number(ruleMatch[1]), await readBody(request, ruleBody));
    return rule ? json(rule) : errorResponse("Rule not found", 404);
  }
  if (ruleMatch && request.method === "DELETE") { deleteRule(Number(ruleMatch[1])); return new Response(null, { status: 204 }); }
  const annotationMatch = path.match(/^\/api\/sessions\/([^/]+)\/annotations$/);
  if (annotationMatch && request.method === "PUT") {
    const input = await readBody(request, annotationBody);
    const annotation = setAnnotationText(decodeURIComponent(annotationMatch[1]), input);
    return json({ ok: true, annotation });
  }
  const verdictMatch = path.match(/^\/api\/sessions\/([^/]+)\/verdict$/);
  if (verdictMatch && request.method === "PUT") {
    const input = await readBody(request, verdictBody);
    return json({ ok: true, annotation: setVerdict(decodeURIComponent(verdictMatch[1]), input.verdict) });
  }
  const externalOpenMatch = path.match(/^\/api\/sessions\/([^/]+)\/external-open$/);
  if (externalOpenMatch && request.method === "POST") {
    const input = await readBody(request, externalOpenBody);
    const sessionId = decodeURIComponent(externalOpenMatch[1]);
    try {
      if (input.target === "transcript")
        return json(await openSessionExternalTarget(sessionId, input.action, { kind: "transcript" }));
      return json(await openSessionExternalTarget(sessionId, input.action, { kind: "file", path: input.path }));
    } catch (error) {
      return error instanceof ExternalOpenError
        ? errorResponse(error, error.status)
        : errorResponse(error);
    }
  }
  const detailMatch = path.match(/^\/api\/sessions\/([^/]+)\/detail$/);
  if (detailMatch && request.method === "GET") {
    const sessionId = resolveSessionId(decodeURIComponent(detailMatch[1]));
    const [detail, snapshot] = await Promise.all([getSessionDetail(sessionId), services.getSnapshot()]);
    const quotaContext = await getSessionQuotaContext(sessionId);
    return json({
      ...detail,
      effort: buildSessionEffortSummary(snapshot as unknown as import("../src/types").DashboardData, sessionId),
      effortCombos: buildSessionEffortCombos(sessionId),
      quotaContext,
    });
  }
  if (path === "/api/session-quota-contexts" && request.method === "POST") {
    const input = await readBody(request, quotaContextsBody);
    const sessionIds = [...new Set(input.sessionIds)];
    const entries = await Promise.all(
      sessionIds.map(async (sessionId) => [sessionId, await getSessionQuotaContext(resolveSessionId(sessionId))] as const),
    );
    return json({ items: Object.fromEntries(entries) });
  }
  if (path === "/api/settings" && request.method === "GET") return json(getSettings());
  if (path === "/api/settings" && request.method === "PUT") { setSettings(await readBody(request, settingsBody)); return json(getSettings()); }

  const snapshot = await services.getSnapshot();
  if (request.method === "GET" && path === "/api/overview") return json({ totals: snapshot.totals, blocks: snapshot.blocks, quotas: snapshot.quotas, sources: snapshot.sources, collectedAt: snapshot.collectedAt, timeZone: snapshot.timeZone });
  if (request.method === "GET" && path === "/api/usage") return json({ daily: snapshot.daily, weekly: snapshot.weekly, monthly: snapshot.monthly });
  if (request.method === "GET" && path === "/api/sessions") {
    const page = pageNumber(url.searchParams.get("page"), 1);
    const limit = pageNumber(url.searchParams.get("limit"), 25, 100);
    return json({ items: snapshot.sessions.slice((page - 1) * limit, page * limit), total: snapshot.sessions.length, page, limit });
  }
  if (request.method === "GET" && path === "/api/quota-comparisons") {
    return json(await collectAllowanceComparisonReport(snapshot.sessions as import("../src/types").Session[]));
  }
  if (request.method === "GET" && path === "/api/projects") return json(snapshot.projects);
  if (request.method === "GET" && path === "/api/models") return json(snapshot.models);
  if (request.method === "GET" && path === "/api/blocks") return json(snapshot.blocks);
  if (request.method === "GET" && path === "/api/quotas") return json(snapshot.quotas);
  if (request.method === "GET" && path === "/api/sources") return json(snapshot.sources);
  if (request.method === "GET" && path === "/api/themes") return json([{ id: "observatory", name: "Observatory", active: true }]);
  return errorResponse("Not found", 404);
}

export function createRequestHandler(services: Services = { getSnapshot, refresh }) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    try {
      if (!requestHostAllowed(request.headers.get("host"))) return errorResponse("Forbidden host", 403);
      if (url.pathname.startsWith("/api/")) {
        if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !requestOriginAllowed(request.headers)) {
          return errorResponse("Write requests must come from an allowed app origin", 403);
        }
        return await api(request, url, services);
      }
      const dist = resolve(process.cwd(), "dist");
      if (existsSync(dist)) {
        const requested = resolve(dist, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
        const file = Bun.file(isWithin(dist, requested) && existsSync(requested) ? requested : resolve(dist, "index.html"));
        return new Response(file);
      }
      return new Response("AI Usage Observatory API is running. Start Vite with `bun run dev:client`.", { status: 200 });
    } catch (error) { return errorResponse(error, error instanceof RequestInputError ? error.status : 500); }
  };
}
