import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  ComboPill,
  EffortBadge,
  EffortCoverage,
  EffortStack,
  EffortState,
  EFFORT_HELP,
  sharePercent,
} from "../components/effort";
import { comboKey, comboOf } from "../combo";
import { PageJump } from "../components/page-jump";
import {
  TokenTypeTable,
  TokenTypesNotice,
  cacheHiddenNotice,
  warpOnlyNotice,
} from "../components/token-types";
import { summarizeTokenTypes } from "../token-types";
import {
  decodeEffortDigest,
  useEffortAggregate,
  useEffortRefreshOnIndexChange,
  useEffortSessions,
  useEffortStatus,
} from "../hooks/use-effort";
import { ArrowUpRight, ChevronLeft, ChevronRight, ChevronUp, Search, Plus } from "lucide-react";
import type { DashboardData, MetricRow, Session } from "../types";
import { Empty, PageTitle } from "./chrome";
import { toggleModel } from "../agent-filter";
import { type DateRange } from "../time-range";
import { aggregateModels } from "../model-aggregation";
import {
  modelIdsFromUrl,
  useUserScrollIntent,
  initialView,
  userScrollCancelWindowMs,
  autoScrollDelayMs,
  modelsHref,
  palette,
  sessionHref,
} from "../app/preferences";
import {
  providerKey,
  formatCompact,
  formatMoney,
  formatWarpCredits,
  friendlyProject,
  DateStamp,
} from "../app/format";
import {
  type ModelSort,
  type ModelTableRow,
  compareModelRows,
  type ModelSortKey,
  MODEL_TABLE_COLUMN_COUNT,
  modelTokenTypeInputs,
} from "../app/analytics";
import { timeEffortScope, modelAvatarLetter } from "../components/activity-charts";
import { SessionEffortCell } from "../components/session-detail";

export function Models({
  data,
  daily,
  sessions,
  dateRange,
  showCache,
  onOpenSession,
}: {
  data: DashboardData;
  daily: MetricRow[];
  sessions: Session[];
  dateRange: DateRange | null;
  showCache: boolean;
  onOpenSession: (sessionId: string) => void;
}) {
  const [openModels, setOpenModels] = useState<Set<string>>(
    () => new Set(modelIdsFromUrl()),
  );
  const [pages, setPages] = useState<Record<string, number>>({});
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ModelSort>({ key: "output", direction: "desc" });
  const tableRef = useRef<HTMLTableElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollModel = useRef<string | null>(modelIdsFromUrl().at(-1) ?? null);
  const lastUserScrollAt = useUserScrollIntent();
  const models = useMemo(
    () => aggregateModels(daily, data.unpricedModels),
    [daily, data.unpricedModels],
  );
  const effortRequest = useEffortAggregate(
    "model",
    timeEffortScope(dateRange, "timeline"),
  );
  const digestRequest = useEffortSessions(timeEffortScope(dateRange, "sessions"));
  const statusRequest = useEffortStatus();
  useEffortRefreshOnIndexChange(statusRequest.data?.indexVersion, [
    effortRequest.load,
    digestRequest.load,
  ]);
  useEffect(() => {
    const syncOpenModels = () => {
      if (initialView() !== "models") return;
      const models = modelIdsFromUrl();
      pendingScrollModel.current = models.at(-1) ?? null;
      setOpenModels(new Set(models));
    };
    window.addEventListener("popstate", syncOpenModels);
    return () => window.removeEventListener("popstate", syncOpenModels);
  }, []);
  const effortByModel = useMemo(
    () => new Map((effortRequest.data?.rows ?? []).map((row) => [row.key, row.summary])),
    [effortRequest.data],
  );
  const effortCombosByModel = useMemo(
    () => new Map(
      (effortRequest.data?.rows ?? []).map((row) => {
        const combos = row.summary.levels
          .filter((level) => level.effort && level.tokens > 0)
          .map((level) => ({ ...comboOf(row.key, level.effort), tokens: level.tokens }))
          .sort((left, right) => right.tokens - left.tokens || left.effort.localeCompare(right.effort));
        return [row.key, combos] as const;
      }),
    ),
    [effortRequest.data],
  );
  const effortBySession = useMemo(
    () => decodeEffortDigest(digestRequest.data),
    [digestRequest.data],
  );
  // Sessions are grouped once per model; every derived column reads from this row so sorting
  // and rendering never recompute the join.
  const rows = useMemo<ModelTableRow[]>(
    () =>
      models.map((model, index) => {
        const modelSessions = sessions
          .filter((session) => session.modelsUsed.includes(model.model))
          .sort((left, right) =>
            String(right.metadata?.lastActivity ?? right.period).localeCompare(
              String(left.metadata?.lastActivity ?? left.period),
            ),
          );
        const warpOnly =
          model.agents.length > 0 &&
          model.agents.every((agent) => providerKey(agent) === "warp");
        // Credits follow the session's lead model so a mixed-model Warp session never counts
        // its credits twice across rows.
        const warpCredits = modelSessions.reduce(
          (sum, session) =>
            session.source === "warp" && session.modelsUsed[0] === model.model
              ? sum + (session.warp?.credits ?? 0)
              : sum,
          0,
        );
        return {
          model,
          index,
          sessions: modelSessions,
          warpOnly,
          warpCredits,
          perMtok:
            model.priced && model.pricedTokens > 0
              ? model.cost / (model.pricedTokens / 1_000_000)
              : null,
          outputShare: !warpOnly && model.tokens > 0 ? model.outputTokens / model.tokens : null,
        };
      }),
    [models, sessions],
  );
  const maxCost = Math.max(...models.map((model) => model.cost), 1);
  const visibleRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return rows
      .filter(({ model }) =>
        `${model.model} ${model.agents.join(" ")}`.toLowerCase().includes(normalizedQuery),
      )
      .sort((left, right) => compareModelRows(left, right, sort));
  }, [rows, query, sort]);
  useEffect(() => {
    const model = pendingScrollModel.current;
    if (!model) return;
    pendingScrollModel.current = null;
    const timeout = window.setTimeout(() => {
      if (performance.now() - lastUserScrollAt.current < userScrollCancelWindowMs)
        return;
      const row = [
        ...(tableRef.current?.querySelectorAll<HTMLElement>(".model-row") ?? []),
      ].find((candidate) => candidate.dataset.modelKey === model);
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
  }, [openModels]);
  // The table can be wider than its scroll box. An opened row's detail is pinned to the visible
  // width instead, so it never has to be scrolled sideways to be read in full.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || typeof ResizeObserver === "undefined") return;
    const sync = () =>
      scroller.style.setProperty("--model-table-viewport", `${scroller.clientWidth}px`);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [visibleRows.length]);
  const pageSize = 5;
  const sortBy = (key: ModelSortKey) =>
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: key === "model" ? "asc" : "desc" },
    );
  const toggleModel = (model: string) => {
    const next = new Set(openModels);
    const opening = !next.has(model);
    if (opening) next.add(model);
    else next.delete(model);
    pendingScrollModel.current = opening ? model : null;
    window.history.pushState(
      { ...window.history.state, view: "models", models: [...next] },
      "",
      modelsHref(next),
    );
    setOpenModels(next);
  };
  const header = (key: ModelSortKey, label: string, numeric = false, title?: string) => (
    <th
      className={`model-col model-col--${key}${numeric ? " num" : ""}`}
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
        title={title}
      >
        {label}
        <span aria-hidden="true">
          {sort.key === key ? (sort.direction === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </button>
    </th>
  );
  const indexing = statusRequest.data?.phase === "indexing";
  return (
    <div className="view-stack page-enter">
      <PageTitle
        eyebrow="MODEL SPECTROGRAPH"
        title="Model mix and efficiency"
        description="One row per model. Sort any column to compare API-equivalent cost, output volume, and cache behavior; open a row for token types, effort distribution, and its sessions. Warp models contribute recorded tokens, while provider credits stay separate from dollar estimates."
        actions={
          <div className="model-controls">
            <label className="search model-search">
              <Search aria-hidden="true" />
              <span className="sr-only">Filter models</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter models…"
              />
              {query && (
                <button
                  type="button"
                  className="search-clear"
                  onClick={() => setQuery("")}
                  aria-label="Clear model filter"
                >
                  Clear
                </button>
              )}
            </label>
          </div>
        }
      />
      {!models.length ? (
        <Empty text="No model usage found in this period." />
      ) : !visibleRows.length ? (
        <Empty text="No models match that filter." />
      ) : (
        <section className="panel table-panel model-table-panel">
          <div className="table-scroll" ref={scrollRef}>
            <table className="model-table" ref={tableRef}>
              <thead>
                <tr>
                  {header("model", "Model")}
                  <th className="model-col model-col--effort">
                    <span title={EFFORT_HELP}>Effort</span>
                  </th>
                  {header("sessions", "Sessions", true)}
                  {header("total", "Total", true, "Input, output, cache read, and cache write together.")}
                  {header("output", "Output", true, "Warp-only models show their recorded tokens here.")}
                  {header("input", "Input", true)}
                  {header("cacheRead", "Cache read", true)}
                  {header("cacheWrite", "Cache write", true)}
                  {header("cost", "Cost", true, "API-equivalent cost from ccusage published rates. Warp credits never become dollars.")}
                  {header("perMtok", "$/Mtok", true, "Blended over priced traffic only; Warp tokens carry no dollar cost and stay out of the rate. A cache-heavy model reads cheap — a cost-tier proxy, never a capability ranking.")}
                  {header("outputShare", "Out share", true, "Output tokens as a share of everything this model processed — the rest is context moved into it.")}
                  <th className="model-col model-col--toggle">
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => {
                  const { model, index, warpOnly, warpCredits } = row;
                  const modelSessions = row.sessions;
                  const open = openModels.has(model.model);
                  const pageCount = Math.max(1, Math.ceil(modelSessions.length / pageSize));
                  const page = Math.min(pages[model.model] ?? 1, pageCount);
                  const pageSessions = modelSessions.slice(
                    (page - 1) * pageSize,
                    page * pageSize,
                  );
                  const panelId = `model-detail-${index}`;
                  const effortSummary = effortByModel.get(model.model) ?? null;
                  const effortUsable =
                    Boolean(statusRequest.data?.enabled) &&
                    effortSummary !== null &&
                    effortSummary.coverageState !== "unavailable";
                  const effortCombos = effortCombosByModel.get(model.model) ?? [];
                  const color = palette[index % palette.length];
                  return (
                    <Fragment key={model.model}>
                      <tr
                        className={`model-row${open ? " model-row--open" : ""}`}
                        data-model-key={model.model}
                        tabIndex={0}
                        aria-expanded={open}
                        aria-controls={panelId}
                        onClick={(event) => {
                          if ((event.target as HTMLElement).closest("a,button,input,select")) return;
                          toggleModel(model.model);
                        }}
                        onKeyDown={(event) => {
                          if (event.target !== event.currentTarget) return;
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            toggleModel(model.model);
                          }
                        }}
                      >
                        <td className="model-col model-col--model">
                          <div className="model-identity">
                            <span className="model-mark" style={{ background: color }} aria-hidden="true">
                              {modelAvatarLetter(model.model)}
                            </span>
                            <div>
                              <b title={model.model}>{model.model}</b>
                              <small>{model.agents.join(" · ")}</small>
                            </div>
                          </div>
                        </td>
                        <td className="model-col model-col--effort">
                          <div className="model-effort-cell">
                            <div>
                              <EffortBadge summary={effortUsable ? effortSummary : null} />
                              {indexing && <small>indexing</small>}
                            </div>
                            {effortUsable && effortSummary && (
                              <EffortStack summary={effortSummary} height={5} showLegend={false} />
                            )}
                          </div>
                        </td>
                        <td className="model-col num">{modelSessions.length}</td>
                        <td className="model-col num">{formatCompact(model.tokens)}</td>
                        <td className="model-col num">
                          {formatCompact(warpOnly ? model.tokens : model.outputTokens)}
                          {warpOnly && <small>recorded</small>}
                        </td>
                        <td className="model-col num">{formatCompact(model.inputTokens)}</td>
                        <td className="model-col num">{formatCompact(model.cacheReadTokens)}</td>
                        <td className="model-col num">{formatCompact(model.cacheCreationTokens)}</td>
                        <td className="model-col num model-col--cost">
                          <div className="model-cost-cell">
                            {model.priced ? (
                              <b>{formatMoney(model.cost)}</b>
                            ) : warpCredits > 0 ? (
                              <>
                                <b title="Summed from this model's Warp sessions; a mixed-model session's credits follow its lead model.">
                                  {formatWarpCredits(warpCredits)}
                                </b>
                                <small>Warp credits</small>
                              </>
                            ) : (
                              <em title={warpOnly ? "Warp reports credits, not tokens priced in dollars." : "ccusage has no rate card for this model."}>{warpOnly ? "Not priced" : "No rate card"}</em>
                            )}
                            {model.priced && warpCredits > 0 && (
                              <small title="Warp credits, summed from this model's Warp sessions; a mixed-model session's credits follow its lead model. Credits never become dollars.">
                                +{formatWarpCredits(warpCredits)} credits
                              </small>
                            )}
                            <span className={`meter${model.priced ? "" : " meter--unpriced"}`} aria-hidden="true">
                              <i
                                style={
                                  model.priced
                                    ? { width: `${(model.cost / maxCost) * 100}%`, background: color }
                                    : { width: "100%" }
                                }
                              />
                            </span>
                          </div>
                        </td>
                        <td className="model-col num">
                          {row.perMtok === null ? "—" : `$${row.perMtok.toFixed(2)}`}
                        </td>
                        <td className="model-col num">
                          {row.outputShare === null ? "—" : `${(row.outputShare * 100).toFixed(2)}%`}
                        </td>
                        <td className="model-col model-col--toggle">
                          <button
                            type="button"
                            className="session-detail-toggle"
                            aria-expanded={open}
                            aria-controls={panelId}
                            aria-label={open ? `Close ${model.model} details` : `Open ${model.model} details`}
                            onClick={() => toggleModel(model.model)}
                          >
                            <Plus aria-hidden="true" />
                          </button>
                        </td>
                      </tr>
                      {open && (
                        <tr className="model-detail-row" id={panelId}>
                          <td colSpan={MODEL_TABLE_COLUMN_COUNT}>
                            <div className="model-detail">
                              {effortCombos.length > 0 && (
                                <div className="model-effort-combos">
                                  <span>MODEL × EFFORT</span>
                                  <div>
                                    {effortCombos.map((combo) => (
                                      <ComboPill
                                        key={comboKey(combo)}
                                        combo={combo}
                                        trailing={sharePercent(combo.tokens, effortSummary?.attributedTokens ?? 0)}
                                      />
                                    ))}
                                  </div>
                                </div>
                              )}
                              {!showCache ? (
                                <TokenTypesNotice>{cacheHiddenNotice}</TokenTypesNotice>
                              ) : warpOnly ? (
                                <TokenTypesNotice>{warpOnlyNotice}</TokenTypesNotice>
                              ) : (
                                <TokenTypeTable
                                  summary={summarizeTokenTypes(
                                    modelTokenTypeInputs(daily, model.model),
                                    data.rateCard,
                                    data.unpricedModels,
                                  )}
                                  context={{
                                    reasoning: effortSummary?.reasoning ?? null,
                                    effortIndexEnabled: statusRequest.data?.enabled,
                                    rateCard: data.rateCard,
                                  }}
                                />
                              )}
                              <section className="model-effort-detail">
                                <EffortState status={statusRequest.data} summary={effortSummary}>
                                  {effortSummary && (
                                    <>
                                      <div>
                                        <span className="overline">TOKEN DISTRIBUTION</span>
                                        <EffortStack summary={effortSummary} basis="tokens" height={8} />
                                        <EffortCoverage summary={effortSummary} indexing={indexing} />
                                      </div>
                                      <div>
                                        <span className="overline">OBSERVATION DISTRIBUTION</span>
                                        <EffortStack summary={effortSummary} basis="observations" height={8} />
                                      </div>
                                    </>
                                  )}
                                </EffortState>
                              </section>
                              <div className="model-sessions">
                                {pageSessions.length ? (
                                  <ol>
                                    {pageSessions.map((session) => (
                                      <li key={session.sessionId}>
                                        <a
                                          href={sessionHref(session.sessionId)}
                                          onClick={(event) => {
                                            if (
                                              event.metaKey ||
                                              event.ctrlKey ||
                                              event.shiftKey ||
                                              event.altKey
                                            )
                                              return;
                                            event.preventDefault();
                                            onOpenSession(session.sessionId);
                                          }}
                                        >
                                          <span>
                                            <b>
                                              {friendlyProject(
                                                session.cwd ?? "Path unavailable",
                                              )}
                                            </b>
                                            <small>
                                              {session.metadata?.lastActivity
                                                ? <DateStamp value={session.metadata.lastActivity} />
                                                : session.period}
                                            </small>
                                          </span>
                                          <span className="model-session-usage">
                                            <b>{formatCompact(session.totalTokens)}</b>
                                            <small>{session.source === "warp" ? `${formatWarpCredits(session.warp?.credits ?? 0)} credits` : formatMoney(session.totalCost)}</small>
                                          </span>
                                          <SessionEffortCell
                                            decoded={effortBySession.get(session.sessionId)}
                                            enabled={Boolean(statusRequest.data?.enabled)}
                                          />
                                          <ArrowUpRight aria-hidden="true" />
                                        </a>
                                      </li>
                                    ))}
                                  </ol>
                                ) : (
                                  <p>No indexed sessions use this model.</p>
                                )}
                                <div className="model-sessions-footer">
                                  {modelSessions.length > pageSize && (
                                    <div
                                      className="model-session-pagination"
                                      aria-label={`Session pages for ${model.model}`}
                                    >
                                      <button
                                        type="button"
                                        disabled={page === 1}
                                        aria-label="Previous session page"
                                        onClick={() =>
                                          setPages((current) => ({
                                            ...current,
                                            [model.model]: page - 1,
                                          }))
                                        }
                                      >
                                        <ChevronLeft />
                                      </button>
                                      <PageJump
                                        page={page}
                                        pages={pageCount}
                                        label={`session page for ${model.model}`}
                                        onChange={(next) =>
                                          setPages((current) => ({
                                            ...current,
                                            [model.model]: next,
                                          }))
                                        }
                                      />
                                      <button
                                        type="button"
                                        disabled={page === pageCount}
                                        aria-label="Next session page"
                                        onClick={() =>
                                          setPages((current) => ({
                                            ...current,
                                            [model.model]: page + 1,
                                          }))
                                        }
                                      >
                                        <ChevronRight />
                                      </button>
                                    </div>
                                  )}
                                  <button
                                    type="button"
                                    className="model-collapse"
                                    aria-controls={panelId}
                                    onClick={() => toggleModel(model.model)}
                                  >
                                    <span>Collapse</span>
                                    <ChevronUp aria-hidden="true" />
                                  </button>
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
