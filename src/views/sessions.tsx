import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { compareEffort } from "../effort-model";
import { ComboFacetSelect } from "../components/effort";
import { providerFromAgent } from "../provider";
import { PageJump } from "../components/page-jump";
import type { RateCardSummary } from "../types";
import {
  decodeEffortDigest,
  effortSearchText,
  effortSummaryLabel,
  matchesSessionEffortFilter,
  useEffortRefreshOnIndexChange,
  useEffortSessions,
  useEffortStatus,
} from "../hooks/use-effort";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  PencilLine,
  Search,
  Plus,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import type { SessionAnnotation, Session, SessionDetail, SessionQuotaContext, QuotaHistory } from "../types";
import { Empty, PageTitle } from "./chrome";
import {
  useUserScrollIntent,
  sessionHref,
  userScrollCancelWindowMs,
  autoScrollDelayMs,
} from "../app/preferences";
import { formatCompact, DateStamp, SessionDateStamp, formatWarpCredits, formatMoney } from "../app/format";
import {
  quotaResetBoundaries,
  sessionQuotaEvents,
  type SessionQuotaEvent,
  sessionModelNames,
} from "../app/analytics";
import {
  sessionProviderColors,
  sessionProviderLabels,
  SessionQuotaBalanceCell,
  SessionEffortCell,
  SessionVerdictBadge,
  SessionDetailPanel,
  effortFilterLabel,
} from "../components/session-detail";

export function Sessions({
  sessions,
  rateCard,
  unpricedModels,
  showCache,
  onEdit,
  focusSessionId,
  focusOutsideRange = false,
  quotaHistory = null,
}: {
  sessions: Session[];
  rateCard: RateCardSummary;
  unpricedModels: string[];
  showCache: boolean;
  onEdit: (session: Session) => void;
  focusSessionId?: string | null;
  focusOutsideRange?: boolean;
  quotaHistory?: QuotaHistory | null;
}) {
  type SortKey =
    | "activity"
    | "session"
    | "cwd"
    | "tokens"
    | "cost";
  const [query, setQuery] = useState("");
  const [effortFilter, setEffortFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, SessionDetail>>({});
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});
  const [quotaContexts, setQuotaContexts] = useState<Record<string, SessionQuotaContext | null>>({});
  const [loadingDetail, setLoadingDetail] = useState<string | null>(null);
  const [copiedSessionId, setCopiedSessionId] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; direction: "asc" | "desc" }>(
    { key: "activity", direction: "desc" },
  );
  const pageSize = 15;
  const focusedRowRef = useRef<HTMLTableRowElement | null>(null);
  const lastUserScrollAt = useUserScrollIntent();
  // The digest is requested unscoped: it describes every dashboard session, and this view already
  // receives the range/provider/path-filtered subset it should render.
  const digestRequest = useEffortSessions({});
  const statusRequest = useEffortStatus();
  const digest = digestRequest.data;
  const effortStatus = statusRequest.data;
  useEffortRefreshOnIndexChange(statusRequest.data?.indexVersion, [digestRequest.load]);
  const effortBySession = useMemo(() => decodeEffortDigest(digest), [digest]);
  // A verdict write returns the stored annotation. Patching it in here makes the change visible
  // at once; the next dashboard fetch independently returns the same value, so the two agree.
  const [annotationPatches, setAnnotationPatches] = useState<Record<string, SessionAnnotation>>({});
  const annotationOf = useCallback(
    (session: Session) => annotationPatches[session.sessionId] ?? session.annotation,
    [annotationPatches],
  );
  const patchAnnotation = useCallback(
    (sessionId: string, annotation: SessionAnnotation) =>
      setAnnotationPatches((current) => ({ ...current, [sessionId]: annotation })),
    [],
  );
  const observedEffortValues = useMemo(
    () => [...(digest?.efforts ?? [])].sort(compareEffort),
    [digest],
  );
  const observedCombos = useMemo(
    () => (digest?.combos ?? []).map(([familyIndex, effortIndex, kind]) => ({
      family: digest!.families[familyIndex],
      effort: digest!.efforts[effortIndex],
      kind,
    })),
    [digest],
  );
  const effortText = useCallback(
    (session: Session) => effortSearchText(effortBySession.get(session.sessionId)),
    [effortBySession],
  );
  const matchesEffortFilter = useCallback(
    (session: Session) =>
      matchesSessionEffortFilter(effortBySession.get(session.sessionId), effortFilter),
    [effortBySession, effortFilter],
  );
  const filtered = useMemo(() => {
    const normalizedQuery = query.toLowerCase();
    return sessions.filter(
      (s) =>
        matchesEffortFilter(s) &&
        `${s.agent} ${s.modelsUsed.join(" ")} ${s.cwd ?? ""} ${s.pathTags.join(" ")} ${s.annotation.tags.join(" ")} ${effortText(s)}`
          .toLowerCase()
          .includes(normalizedQuery),
    );
  }, [query, sessions, effortText, matchesEffortFilter]);
  const sorted = useMemo(() => [...filtered].sort((left, right) => {
    const value = (session: Session): string | number => {
      if (sort.key === "activity")
        return Date.parse(String(session.metadata?.lastActivity ?? "")) || 0;
      if (sort.key === "session") {
        return `${providerFromAgent(session.agent) ?? "unknown"}\0${session.modelsUsed[0] ?? ""}`;
      }
      if (sort.key === "cwd") return session.cwd ?? "";
      if (sort.key === "tokens") return session.outputTokens;
      return session.totalCost;
    };
    const a = value(left),
      b = value(right);
    const comparison =
      typeof a === "number" && typeof b === "number"
        ? a - b
        : String(a).localeCompare(String(b));
    return sort.direction === "asc" ? comparison : -comparison;
  }), [filtered, sort, effortBySession]);
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const pageRows = sorted.slice((page - 1) * pageSize, page * pageSize);
  // Context carry: cache-read tokens dragged along per output token. The
  // baseline is the median of the sessions in view, so "heavy" always means
  // "heavy among what you are looking at". Token-based only — a session whose
  // output was mostly deletions still counts its output tokens in full.
  const sessionCarry = (session: Session) =>
    session.outputTokens > 0 && session.cacheReadTokens > 0
      ? session.cacheReadTokens / session.outputTokens
      : null;
  const medianCarry = useMemo(() => {
    const values = filtered
      .map(sessionCarry)
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b);
    return values.length ? values[Math.floor(values.length / 2)] : null;
  }, [filtered]);
  // The rating nudge points at the largest unrated session in view: verdicts
  // starve the model × effort evidence table, and the biggest sessions are the
  // ones whose rating moves it most.
  const unratedCount = useMemo(
    () => filtered.filter((session) => !annotationOf(session).verdict).length,
    [filtered, annotationOf],
  );
  const biggestUnrated = useMemo(() => {
    let best: Session | null = null;
    for (const session of filtered) {
      if (annotationOf(session).verdict) continue;
      if (!best || session.totalTokens > best.totalTokens) best = session;
    }
    return best;
  }, [filtered, annotationOf]);
  const rateBiggestUnrated = async () => {
    if (!biggestUnrated) return;
    const index = sorted.findIndex(
      (session) => session.sessionId === biggestUnrated.sessionId,
    );
    if (index >= 0) setPage(Math.floor(index / pageSize) + 1);
    await toggle(biggestUnrated);
    requestAnimationFrame(() => {
      document
        .querySelector(".session-row-open")
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  };
  // The remaining-quota column reads like a bank statement's balance column, which only holds
  // when rows are in end-time order: any other sort turns it into a column of random numbers.
  const showQuotaBalance = sort.key === "activity";
  const columnCount = 9;
  const pageQuotaKey = pageRows.map((session) => session.sessionId).join("\n");
  useEffect(() => {
    const sessionIds = pageQuotaKey ? pageQuotaKey.split("\n") : [];
    const missing = sessionIds.filter((sessionId) => !Object.hasOwn(quotaContexts, sessionId));
    if (!missing.length) return;
    const controller = new AbortController();
    void fetch("/api/session-quota-contexts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionIds: missing }),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Quota closing readings are unavailable");
        return await response.json() as { items?: Record<string, SessionQuotaContext | null> };
      })
      .then((result) => {
        setQuotaContexts((current) => ({
          ...current,
          ...Object.fromEntries(missing.map((sessionId) => [sessionId, result.items?.[sessionId] ?? null])),
        }));
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setQuotaContexts((current) => ({
          ...current,
          ...Object.fromEntries(missing.map((sessionId) => [sessionId, null])),
        }));
      });
    return () => controller.abort();
  }, [pageQuotaKey]);
  useEffect(() => setPage(1), [query, effortFilter]);
  useEffect(() => setPage((current) => Math.min(current, pages)), [pages]);
  const sortBy = (key: SortKey) => {
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "desc" ? "asc" : "desc" }
        : {
            key,
            direction:
              key === "activity" || key === "tokens" || key === "cost"
                ? "desc"
                : "asc",
          },
    );
    setPage(1);
  };
  const loadDetail = async (session: Session) => {
    setDetailErrors((current) => {
      if (!current[session.sessionId]) return current;
      const next = { ...current };
      delete next[session.sessionId];
      return next;
    });
    setLoadingDetail(session.sessionId);
    try {
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(session.sessionId)}/detail`,
      );
      if (!response.ok) throw new Error("Session details are unavailable");
      const detail = (await response.json()) as SessionDetail;
      setDetails((current) => ({ ...current, [session.sessionId]: detail }));
      if (detail.quotaContext !== undefined) {
        setQuotaContexts((current) => ({ ...current, [session.sessionId]: detail.quotaContext ?? null }));
      }
    } catch {
      // A failed request says nothing about whether the transcript still exists. Keep it
      // distinct from the server's successful `available: false` response, and do not cache
      // the failure as a missing record so the user can retry after the local API returns.
      setDetailErrors((current) => ({
        ...current,
        [session.sessionId]: "Could not load session details. The local API may be unavailable.",
      }));
    } finally {
      setLoadingDetail(null);
    }
  };
  const toggle = async (session: Session) => {
    if (expanded === session.sessionId) return setExpanded(null);
    setExpanded(session.sessionId);
    // Warp rows used to stop here because they had no readable record. They now
    // resolve to the prompts in Warp's own query log, so they fetch like the rest.
    if (details[session.sessionId]) return;
    await loadDetail(session);
  };
  const copySessionLink = async (sessionId: string) => {
    try {
      const link = new URL(sessionHref(sessionId), window.location.href).href;
      await navigator.clipboard.writeText(link);
      setCopiedSessionId(sessionId);
      window.setTimeout(() => setCopiedSessionId(null), 1600);
    } catch {}
  };
  useEffect(() => {
    if (!focusSessionId) return;
    const index = sorted.findIndex(
      (session) => session.sessionId === focusSessionId,
    );
    if (index < 0) return;
    setPage(Math.floor(index / pageSize) + 1);
    if (expanded !== focusSessionId) void toggle(sorted[index]);
  }, [focusSessionId]);
  useEffect(() => {
    if (!focusSessionId || expanded !== focusSessionId) return;
    const timeout = window.setTimeout(() => {
      if (performance.now() - lastUserScrollAt.current < userScrollCancelWindowMs)
        return;
      const row = focusedRowRef.current;
      if (!row) return;
      const topbarHeight =
        document.querySelector<HTMLElement>(".topbar")?.getBoundingClientRect().height ?? 72;
      const target = Math.max(
        0,
        window.scrollY + row.getBoundingClientRect().top - topbarHeight - 18,
      );
      if (Math.abs(target - window.scrollY) < 12) return;
      window.scrollTo({
        top: target,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
    }, autoScrollDelayMs);
    return () => window.clearTimeout(timeout);
  }, [focusSessionId, page, expanded]);
  const header = (key: SortKey, label: string, columnClass: string) => (
    <th
      className={`session-col ${columnClass}`}
      aria-sort={
        sort.key === key
          ? sort.direction === "asc"
            ? "ascending"
            : "descending"
          : "none"
      }
    >
      <button
        type="button"
        className={`sort-header ${sort.key === key ? "active" : ""}`}
        onClick={() => sortBy(key)}
      >
        {label}
        <span aria-hidden="true">
          {sort.key === key ? (sort.direction === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </button>
    </th>
  );
  return (
    <div className="view-stack page-enter">
      <PageTitle
        eyebrow="SESSION LEDGER"
        title="Trace sessions"
        description="Expand a session to inspect local prompts, sampled assistant output, files, tools, model mix, and effort. Warp rows add the prompts you typed and the replies you got back to their credit and tool summaries."
        actions={
          <div className="project-controls">
            <label className="search">
              <Search />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search sessions…"
              />
              {query && (
                <button
                  type="button"
                  className="search-clear"
                  onClick={() => setQuery("")}
                  aria-label="Clear session search"
                >
                  Clear
                </button>
              )}
            </label>
            <div className="project-sort">
              <label htmlFor="session-effort-filter">MODEL × EFFORT</label>
              <ComboFacetSelect
                id="session-effort-filter"
                value={effortFilter}
                onChange={setEffortFilter}
                effortLevels={observedEffortValues}
                combos={observedCombos}
                disabled={!effortStatus?.enabled}
              />
            </div>
          </div>
        }
      />
      <section className="panel table-panel">
        {biggestUnrated && (
          <div className="rate-nudge">
            <PencilLine aria-hidden="true" />
            <span>
              <b>{unratedCount === 1 ? "1 session" : `${unratedCount} sessions`}</b> in view
              {unratedCount === 1 ? " is" : " are"} unrated. Verdicts are the only
              user-supplied signal here — they feed the model × effort evidence.
            </span>
            <button type="button" onClick={() => void rateBiggestUnrated()}>
              Rate the biggest ({formatCompact(biggestUnrated.totalTokens)} tokens)
            </button>
          </div>
        )}
        <div className="table-scroll">
          <table className="session-table">
            <colgroup>
              <col className="session-col--quota" />
              <col className="session-col--activity" />
              <col className="session-col--model" />
              <col className="session-col--pwd" />
              <col className="session-col--tokens" />
              <col className="session-col--cost" />
              <col className="session-col--verdict" />
              <col className="session-col--actions" />
              <col className="session-col--toggle" />
            </colgroup>
            <thead>
              <tr>
                <th className="session-col session-col--quota">
                  <span
                    className={`session-quota-balance-header${showQuotaBalance ? "" : " is-dormant"}`}
                    title={showQuotaBalance
                      ? `Account quota remaining at each session's closing reading. Rows run ${sort.direction === "asc" ? "oldest to newest" : "newest to oldest"}.`
                      : "Quota balances are hidden until the table is sorted by last activity."}
                  >
                    {sort.direction === "asc"
                      ? <TrendingUp aria-hidden="true" />
                      : <TrendingDown aria-hidden="true" />}
                    <span className="sr-only">
                      {showQuotaBalance
                        ? `Quota remaining, activity sorted ${sort.direction === "asc" ? "ascending" : "descending"}`
                        : "Quota remaining, values hidden because the table is not sorted by last activity"}
                    </span>
                  </span>
                </th>
                {header("activity", "Last activity", "session-col--activity")}
                {header("session", "Provider & Model", "session-col--model")}
                {header("cwd", "pwd", "session-col--pwd")}
                {header("tokens", "out T", "session-col--tokens")}
                {header("cost", "cost", "session-col--cost")}
                <th className="session-col session-col--verdict session-verdict-header">
                  <span title="Your own rating of the session. It is never inferred, and it is the only signal in this app that is user-supplied.">
                    Rate
                  </span>
                </th>
                <th
                  className="session-col session-col--header-pagination"
                  colSpan={2}
                  scope="colgroup"
                >
                  <div className="session-header-pagination" aria-label="Session table pagination">
                    <button
                      type="button"
                      disabled={page === 1}
                      onClick={() => setPage((p) => p - 1)}
                      aria-label="Previous session page"
                    >
                      <ChevronLeft aria-hidden="true" />
                    </button>
                    <PageJump
                      page={page}
                      pages={pages}
                      label="session page"
                      onChange={setPage}
                    />
                    <button
                      type="button"
                      disabled={page === pages}
                      onClick={() => setPage((p) => p + 1)}
                      aria-label="Next session page"
                    >
                      <ChevronRight aria-hidden="true" />
                    </button>
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((session, index) => {
                const boundaries = showQuotaBalance && index > 0
                  ? quotaResetBoundaries(quotaContexts[pageRows[index - 1]!.sessionId], quotaContexts[session.sessionId])
                  : [];
                // Quota-exhausted and banked-reset instants sit between the two sessions' last
                // activity. The newest row on the first page also owns everything after it, so
                // a limit hit since the last session still shows up at the top of the list.
                const activityAt = Date.parse(String(session.metadata?.lastActivity ?? ""));
                const neighbourAt = index > 0
                  ? Date.parse(String(pageRows[index - 1]!.metadata?.lastActivity ?? ""))
                  : page === 1 && sort.direction === "desc" ? Number.POSITIVE_INFINITY : Number.NaN;
                const events = showQuotaBalance && Number.isFinite(activityAt) && !Number.isNaN(neighbourAt)
                  ? sessionQuotaEvents(quotaHistory, neighbourAt, activityAt)
                  : [];
                const trailingEvents = showQuotaBalance && Number.isFinite(activityAt)
                  && sort.direction === "asc" && page === pages && index === pageRows.length - 1
                  ? sessionQuotaEvents(quotaHistory, activityAt, Number.POSITIVE_INFINITY)
                  : [];
                const eventDivider = (items: SessionQuotaEvent[], keyPrefix: string) =>
                  items.length > 0 && (
                    <tr className={`session-reset-divider session-reset-divider--event${items.some((event) => event.kind !== "reset") ? " is-exhausted" : ""}`}>
                      <td colSpan={columnCount}>
                        {items.map((event) => (
                          <span key={`${keyPrefix}-${event.provider}-${event.kind}-${event.at}`} className="session-reset-divider__event">
                            <span className="session-reset-divider__provider">
                              <i
                                style={{ background: sessionProviderColors[event.provider] }}
                                aria-hidden="true"
                              />
                              {sessionProviderLabels[event.provider]}
                            </span>
                            <span className="session-reset-divider__window">
                              {event.label} · <DateStamp value={new Date(event.at).toISOString()} />
                            </span>
                          </span>
                        ))}
                      </td>
                    </tr>
                  );
                const sessionProvider = providerFromAgent(session.agent);
                const sessionProviderLabel = sessionProvider
                  ? sessionProviderLabels[sessionProvider]
                  : session.agent;
                return (
                <Fragment key={session.sessionId}>
                  {eventDivider(events, "above")}
                  {boundaries.length > 0 && (
                    <tr className="session-reset-divider">
                      <td colSpan={columnCount}>
                        <span className="session-reset-divider__provider">
                          <i
                            style={{ background: sessionProviderColors[boundaries[0]!.provider] }}
                            aria-hidden="true"
                          />
                          {sessionProviderLabels[boundaries[0]!.provider]}
                        </span>
                        {boundaries.map((boundary) => (
                          <span key={boundary.id} className="session-reset-divider__window">
                            {boundary.label} window reset · <DateStamp value={new Date(boundary.at).toISOString()} />
                          </span>
                        ))}
                      </td>
                    </tr>
                  )}
                  <tr
                    ref={
                      session.sessionId === focusSessionId
                        ? focusedRowRef
                        : undefined
                    }
                    className={`session-row ${expanded === session.sessionId ? "session-row-open" : ""}`}
                    tabIndex={0}
                    aria-expanded={expanded === session.sessionId}
                    aria-label={`Toggle details for ${session.modelsUsed[0] ?? "this session"}, effort ${effortSummaryLabel(effortBySession.get(session.sessionId))}`}
                    onClick={() => void toggle(session)}
                    onKeyDown={(event) => {
                      if (
                        event.target === event.currentTarget &&
                        (event.key === "Enter" || event.key === " ")
                      ) {
                        event.preventDefault();
                        void toggle(session);
                      }
                    }}
                  >
                    <td className={`session-col session-col--quota session-row__quota-left${showQuotaBalance ? "" : " is-dormant"}`}>
                      {showQuotaBalance && (
                        <SessionQuotaBalanceCell
                          context={quotaContexts[session.sessionId]}
                          loading={!Object.hasOwn(quotaContexts, session.sessionId)}
                          provider={sessionProvider ?? quotaContexts[session.sessionId]?.provider ?? null}
                        />
                      )}
                    </td>
                    <td className="session-col session-col--activity">
                      <span className="session-activity">
                        {session.metadata?.lastActivity
                          ? <SessionDateStamp value={session.metadata.lastActivity} />
                          : "—"}
                      </span>
                    </td>
                    <td className="session-col session-col--model">
                      <span>
                        <span className="session-row__model-title">
                          <span className={`agent-pill ${sessionProvider ?? "unknown"}`}>
                            {sessionProviderLabel}
                          </span>
                          <b>{session.modelsUsed[0] ?? "Unknown"}</b>
                          {sessionModelNames(session).length > 1 && (
                            <i
                              className="model-mix-marker"
                              title={`${sessionModelNames(session).length} models used in this session`}
                            >
                              Mixed · {sessionModelNames(session).length}
                            </i>
                          )}
                          {focusOutsideRange && session.sessionId === focusSessionId && (
                            <i className="session-range-exception">Outside active range</i>
                          )}
                        </span>
                        <small>{session.period.slice(0, 18)}</small>
                        <span className="session-row__model-effort">
                          <SessionEffortCell
                            decoded={effortBySession.get(session.sessionId)}
                            enabled={Boolean(effortStatus?.enabled)}
                          />
                        </span>
                      </span>
                    </td>
                    <td className="session-col session-col--pwd">
                      <span
                        className="cwd"
                        title={session.cwd ?? "Unavailable"}
                      >
                        <span dir="ltr">{session.cwd ?? "Path unavailable"}</span>
                      </span>
                      <span className="mini-tags">
                        {[...session.pathTags, ...annotationOf(session).tags]
                          .slice(0, 3)
                          .map((tag) => (
                            <i key={tag}>{tag}</i>
                          ))}
                      </span>
                    </td>
                    <td className="session-col session-col--tokens">
                      <b>{formatCompact(session.outputTokens)}</b>
                      <small>
                        {session.source === "warp"
                          ? "output tokens"
                          : `${formatCompact(session.totalTokens)} total`}
                      </small>
                      {(() => {
                        const carry = sessionCarry(session);
                        if (carry === null || carry < 1) return null;
                        const heavy = medianCarry !== null && medianCarry > 0 && carry >= medianCarry * 3;
                        return (
                          <small
                            className={`session-carry${heavy ? " is-heavy" : ""}`}
                            title={`Re-read ${Math.round(carry)} cache tokens per output token${medianCarry !== null ? ` · median in view ${Math.round(medianCarry)}:1` : ""}. Token-based: output that deletes code counts the same as output that adds it.`}
                          >
                            {Math.round(carry)}:1 carry
                          </small>
                        );
                      })()}
                    </td>
                    <td className="session-col session-col--cost">
                      {session.source === "warp" ? (
                        <>
                          <b>{formatWarpCredits(session.warp?.credits ?? 0)}</b>
                          <small>Warp credits</small>
                        </>
                      ) : (
                        <>
                          <b>{formatMoney(session.totalCost)}</b>
                          <small>ccusage</small>
                        </>
                      )}
                    </td>
                    <td className="session-col session-col--verdict session-row__verdict">
                      <SessionVerdictBadge verdict={annotationOf(session).verdict} />
                    </td>
                    <td
                      className="session-col session-col--actions session-row__actions"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => onEdit(session)}
                        aria-label="Edit annotation"
                        title="Edit annotation"
                      >
                        <PencilLine />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => void copySessionLink(session.sessionId)}
                        aria-label={
                          copiedSessionId === session.sessionId
                            ? "Session link copied"
                            : "Copy direct session link"
                        }
                        title={
                          copiedSessionId === session.sessionId
                            ? "Copied"
                            : "Copy direct session link"
                        }
                      >
                        {copiedSessionId === session.sessionId ? <Check /> : <Copy />}
                      </button>
                    </td>
                    <td
                      className="session-col session-col--toggle session-row__toggle"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <button
                        type="button"
                        className="session-detail-toggle"
                        onClick={() => void toggle(session)}
                        aria-label={
                          expanded === session.sessionId
                            ? "Close session details"
                            : "Open session details"
                        }
                        aria-expanded={expanded === session.sessionId}
                      >
                        <Plus />
                      </button>
                    </td>
                  </tr>
                  {expanded === session.sessionId && (
                    <tr className="session-detail-row">
                      <td colSpan={columnCount}>
                        <SessionDetailPanel
                          session={session}
                          detail={details[session.sessionId]}
                          loading={loadingDetail === session.sessionId}
                          loadError={detailErrors[session.sessionId]}
                          onRetry={() => void loadDetail(session)}
                          effortStatus={effortStatus}
                          rateCard={rateCard}
                          unpricedModels={unpricedModels}
                          showCache={showCache}
                          annotation={annotationOf(session)}
                          onAnnotationChange={patchAnnotation}
                        />
                      </td>
                    </tr>
                  )}
                  {eventDivider(trailingEvents, "below")}
                </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {!pageRows.length && (
          <Empty
            text={
              effortFilter === "all"
                ? "No sessions match those filters."
                : `No sessions match those filters with ${effortFilterLabel(effortFilter)}.`
            }
          />
        )}
        <div className="pagination">
          <span>{filtered.length} sessions</span>
          <div>
            <button
              type="button"
              disabled={page === 1}
              onClick={() => setPage((p) => p - 1)}
              aria-label="Previous session page"
            >
              <ChevronLeft aria-hidden="true" />
            </button>
            <PageJump
              page={page}
              pages={pages}
              label="session page"
              onChange={setPage}
            />
            <button
              type="button"
              disabled={page === pages}
              onClick={() => setPage((p) => p + 1)}
              aria-label="Next session page"
            >
              <ChevronRight aria-hidden="true" />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
