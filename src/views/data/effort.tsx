import { useMemo, useState } from "react";
import { Database, RefreshCw, Trash2 } from "lucide-react";
import type { EffortComboBoardRow, EffortComboContrast } from "../../types";
import { LED_SESSION_FLOOR, RATED_SESSION_FLOOR } from "../../types";
import {
  decodeEffortDigest,
  deleteEffortDerivedObservations,
  setEffortIndexing,
  useEffortAggregate,
  useEffortComboBoard,
  useEffortRefreshOnIndexChange,
  useEffortSessions,
  useEffortStatus,
  type EffortScopeInput,
} from "../../hooks/use-effort";
import {
  ComboPill,
  EffortCoverage,
  EffortIndexSummary,
  EffortState,
  EFFORT_HELP,
  familyLabel,
} from "../../components/effort";
import { comboLabel, effortLabel, parseComboFacet } from "../../combo";
import type { DataFacets } from "./insights";
import { dateRangeLabel, type DateRange } from "../../time-range";

/** Reads the Model × effort facet the way its select labels it. */
function effortFacetLabel(value: string) {
  const combo = parseComboFacet(value);
  if (combo) return comboLabel(combo);
  if (value.startsWith("value:")) return `${effortLabel(value.slice("value:".length))} effort`;
  if (value === "mixed") return "mixed effort";
  if (value === "unknown") return "unknown effort";
  return "all efforts";
}

/** One filter the card inherits from the page. `active` means it narrows the evidence. */
export type InheritedFilter = { label: string; active: boolean };

/** The page filters the evidence card inherits, in the order the page shows them. The card states
 * them because a narrow scope otherwise reads as missing data. */
function inheritedFilters({ days, dateRange, agentSummary, pathTag, facets }: {
  days: string;
  dateRange: DateRange | null;
  agentSummary: string;
  pathTag: string;
  facets: DataFacets;
}): InheritedFilter[] {
  return [
    { label: days === "all" ? "all history" : days === "custom" ? dateRangeLabel(dateRange) : days === "1" ? "the last day" : `the last ${days} days`, active: days !== "all" },
    { label: agentSummary, active: agentSummary !== "all agents" },
    { label: pathTag === "all" ? "all path tags" : `path ${pathTag}`, active: pathTag !== "all" },
    { label: facets.outliers === "typical" ? "typical sessions only" : facets.outliers === "only" ? "outlier sessions only" : "all sessions", active: facets.outliers !== "all" },
    { label: effortFacetLabel(facets.effort), active: facets.effort !== "all" },
  ];
}

export function useReasoningEffort({
  days,
  dateRange,
  providers,
  modelFamilies,
  agentSummary,
  pathTag,
  facets,
}: {
  days: string;
  dateRange: DateRange | null;
  providers: string[];
  modelFamilies: string[];
  /** The global Agent filter as the facet row words it. */
  agentSummary: string;
  pathTag: string;
  facets: DataFacets;
}) {
  const statusRequest = useEffortStatus();
  const providerKey = providers.join(",");
  const familyKey = modelFamilies.join(",");
  const scope = useMemo<EffortScopeInput>(() => ({
    basis: "sessions",
    rangeDays: days === "all" ? null : Number(days),
    fromDate: dateRange?.from,
    toDate: dateRange?.to,
    providers: providerKey ? providerKey.split(",") : [],
    modelFamilies: familyKey ? familyKey.split(",") : [],
    pathTag,
    effort: facets.effort,
    outliers: facets.outliers,
  }), [days, dateRange, facets.effort, facets.outliers, pathTag, providerKey, familyKey]);
  // A local project selector combines with the global path-tag scope rather than replacing it,
  // so one control never silently overrides the other.
  const [project, setProject] = useState<string>("all");
  const boardScope = useMemo<EffortScopeInput>(
    () => ({ ...scope, project: project === "all" ? null : project }),
    [scope, project],
  );
  const board = useEffortComboBoard(boardScope);
  // The project picker is built from this, not from the dashboard's all-time project list: it is
  // the same scope as the board minus the project itself, so every option has evidence to show.
  const projectEvidence = useEffortAggregate("project", scope);
  const digest = useEffortSessions(scope);
  useEffortRefreshOnIndexChange(statusRequest.data?.indexVersion, [board.load, digest.load, projectEvidence.load]);

  const decoded = useMemo(() => decodeEffortDigest(digest.data), [digest.data]);
  const filters = useMemo(
    () => inheritedFilters({ days, dateRange, agentSummary, pathTag, facets }),
    [days, dateRange, agentSummary, pathTag, facets],
  );
  const status = statusRequest.data ?? board.data?.status ?? null;
  const [busy, setBusy] = useState<"toggle" | "delete" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = async () => {
    await Promise.all([statusRequest.load(), board.load(), digest.load(), projectEvidence.load()]);
  };
  const toggle = async () => {
    if (!status) return;
    setBusy("toggle");
    setActionError(null);
    try {
      await setEffortIndexing(!status.enabled);
      await reload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    if (!window.confirm("Delete all derived effort observations? Transcripts and usage snapshots will not be changed.")) return;
    setBusy("delete");
    setActionError(null);
    try {
      await deleteEffortDerivedObservations();
      await reload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return { status, board, filters, projectRows: projectEvidence.data?.rows ?? null, decoded, busy, actionError, toggle, remove, project, setProject, pathTag };
}

const compactNumber = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const money = (value: number) => `$${value < 10 ? value.toFixed(2) : Math.round(value)}`;
const percentOf = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);
const projectName = (projectId: string) => projectId.split("/").filter(Boolean).at(-1) ?? projectId;

/** Every session-level column measures whole sessions, so every one of them carries this. */
const OUTCOME_HELP = "Whole-session statistic over sessions this combo uniquely led; observational, not causal.";

type SortKey = "tokens" | "sessionsAppeared" | "sessionsLed" | "medianTokensPerLedSession" | "medianCostPerLedSession" | "flagRate" | "reasoningShare" | "verdict";

const columns: Array<{ key: SortKey; label: string; help?: string; outcome?: boolean }> = [
  { key: "tokens", label: "Attributable volume", help: "Tokens recorded against this family and effort. This is the one figure a combo is directly responsible for." },
  { key: "sessionsAppeared", label: "Appeared in", help: "Distinct sessions containing this combo at all." },
  { key: "sessionsLed", label: "Led", help: "Sessions where this combo recorded strictly more tokens than every other. Ties lead nothing." },
  { key: "medianTokensPerLedSession", label: "Median tokens", outcome: true },
  { key: "medianCostPerLedSession", label: "Median cost", outcome: true },
  { key: "flagRate", label: "Flag rate", outcome: true },
  { key: "reasoningShare", label: "Reasoning", help: "Reasoning output over total output, where the provider reported it. Blank means the provider reports no reasoning at all — not that there was none." },
  { key: "verdict", label: "Verdict", outcome: true },
];

const sortValue = (row: EffortComboBoardRow, key: SortKey) => {
  if (key === "verdict") return row.verdict.goodRate ?? -1;
  const value = row[key];
  return typeof value === "number" ? value : -1;
};

const kindBadge: Record<EffortComboBoardRow["kind"], string | null> = {
  interactive: null,
  automated: "automated",
  synthetic: "synthetic",
  unknown: "unrecorded model",
};

function OutcomeCell({ row, children }: { row: EffortComboBoardRow; children: React.ReactNode }) {
  if (row.kind !== "interactive") return <td className="effort-board__muted">Not human work</td>;
  if (row.sessionsLed < LED_SESSION_FLOOR) return <td className="effort-board__muted">Too few led sessions</td>;
  return <td>{children}</td>;
}

function VerdictCell({ row }: { row: EffortComboBoardRow }) {
  const { rated, good, goodRate } = row.verdict;
  if (rated === 0) return <td className="effort-board__muted" title="Verdicts are user-supplied. Nothing here is inferred.">—</td>;
  return (
    <td>
      <b>{goodRate === null ? "—" : `${Math.round(goodRate * 100)}% good`}</b>
      <small>
        {rated} of {row.sessionsLed} led sessions rated
        {goodRate === null ? ` · too few ratings for a rate` : ""}
      </small>
      {goodRate === null && <small className="sr-only">{good} rated good</small>}
    </td>
  );
}

/** One observational sentence. It states what was recorded and how large the cohorts were, and
 * deliberately never says "best", "better", or "use". */
function contrastSentence(contrast: EffortComboContrast) {
  const combo = `${familyLabel(contrast.family)} · ${effortLabel(contrast.effort)}`;
  const where = `In ${projectName(contrast.projectId)}, ${combo} led ${contrast.cohortSessions} of ${contrast.baselineSessions} attributed sessions`;
  if (contrast.metric === "cost") {
    // A cohort well below the baseline is as informative as one above it, so small ratios keep
    // their precision instead of rounding to a flat "0.0×".
    const ratio = contrast.value >= 10 ? contrast.value.toFixed(0) : contrast.value >= 1 ? contrast.value.toFixed(1) : contrast.value.toFixed(2);
    return `${where}; its median session cost was ${ratio}× the project median (${money(contrast.cohortValue)} against ${money(contrast.baselineValue)}).`;
  }
  const points = Math.abs(contrast.value * 100);
  return `${where}; its efficiency-rule flag rate was ${percentOf(contrast.cohortValue)} against the project's ${percentOf(contrast.baselineValue)}, a ${points.toFixed(0)}-point gap.`;
}

export function ReasoningEffortAnalysis({
  effort,
  projects,
}: {
  effort: ReturnType<typeof useReasoningEffort>;
  /** Project ids the dashboard knows about, already ordered and disambiguated for display. */
  projects: Array<{ id: string; label: string }>;
}) {
  const { status, board, filters, project, setProject } = effort;
  const [sort, setSort] = useState<{ key: SortKey; direction: "asc" | "desc" }>({ key: "tokens", direction: "desc" });
  const data = board.data;
  const rows = useMemo(() => {
    const ordered = [...(data?.rows ?? [])].sort((a, b) => sortValue(a, sort.key) - sortValue(b, sort.key));
    return sort.direction === "desc" ? ordered.reverse() : ordered;
  }, [data, sort]);
  const sortBy = (key: SortKey) =>
    setSort((current) => (current.key === key ? { key, direction: current.direction === "desc" ? "asc" : "desc" } : { key, direction: "desc" }));

  const projectLabel = project === "all" ? "all projects" : projects.find((option) => option.id === project)?.label ?? projectName(project);
  // Range, agent, and path tag always show, so the scope reads in full; the session facets show
  // only when they narrow it.
  const scopeText = filters.filter((filter, index) => index < 3 || filter.active).map((filter) => filter.label).join(" · ");
  const narrowing = [...(project === "all" ? [] : [projectLabel]), ...filters.filter((filter) => filter.active).map((filter) => filter.label)];

  const emptyMessage = narrowing.length > 0
    ? `No model × effort evidence matches ${narrowing.join(" · ")}. Widen the range or clear a filter to see more.`
    : "No model × effort evidence has been recorded yet.";

  return (
    <section className="panel effort-analysis">
      <div className="panel-heading">
        <div>
          <span className="overline">MODEL × EFFORT EVIDENCE</span>
          <h2>What works where</h2>
          <p>{projectLabel}</p>
        </div>
        <div className="effort-board__controls">
          <label>
            <span className="sr-only">Project</span>
            <select value={project} onChange={(event) => setProject(event.target.value)}>
              <option value="all">All projects</option>
              {projects.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </label>
          <span className="method-chip local"><i /> transcript derived</span>
        </div>
      </div>
      <p className="effort-help">{EFFORT_HELP}</p>
      <p className="effort-scope-note">
        Filtered by the page to <b>{scopeText}</b>. A narrow scope can leave few or no rows, and the project
        list includes only projects with evidence in it.
      </p>
      <EffortState status={status} summary={data ? { coverageState: data.coverageState } : null} unavailableMessage={emptyMessage}>
        {rows.length === 0 ? (
          <p className="effort-empty">{emptyMessage}</p>
        ) : (
          <>
            <div className="table-scroll effort-board">
              <table>
                <thead>
                  <tr>
                    <th>Model × effort</th>
                    {columns.map((column) => (
                      <th
                        key={column.key}
                        aria-sort={sort.key === column.key ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
                      >
                        <button
                          type="button"
                          className={`sort-header ${sort.key === column.key ? "active" : ""}`}
                          onClick={() => sortBy(column.key)}
                          title={column.outcome ? OUTCOME_HELP : column.help}
                        >
                          {column.label}
                          <span aria-hidden="true">{sort.key === column.key ? (sort.direction === "asc" ? "↑" : "↓") : "↕"}</span>
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={`${row.family}\u0000${row.effort}`}>
                      <td className="effort-board__combo">
                        <ComboPill combo={row} />
                        {kindBadge[row.kind] && <i className="effort-board__kind">{kindBadge[row.kind]}</i>}
                      </td>
                      <td>
                        <b>{compactNumber.format(row.tokens)}</b>
                        <small>{compactNumber.format(row.observations)} observations</small>
                      </td>
                      <td>{row.sessionsAppeared}</td>
                      <td>
                        <b>{row.sessionsLed}</b>
                        {row.tiesExcluded > 0 && <small>{row.tiesExcluded} tied</small>}
                      </td>
                      <OutcomeCell row={row}>{compactNumber.format(row.medianTokensPerLedSession ?? 0)}</OutcomeCell>
                      <OutcomeCell row={row}>{money(row.medianCostPerLedSession ?? 0)}</OutcomeCell>
                      <OutcomeCell row={row}>{percentOf(row.flagRate)}</OutcomeCell>
                      <td>{row.reasoningShare === null ? <span className="effort-board__muted" title="This provider reports no reasoning tokens.">not reported</span> : percentOf(row.reasoningShare)}</td>
                      <VerdictCell row={row} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data && <EffortCoverage summary={data.coverage} indexing={data.status.phase === "indexing"} />}
            <p className="effort-coverage">
              {data?.sessionsScoped ?? 0} sessions match the current filters.
              {(data?.tiedSessions ?? 0) > 0 && ` ${data!.tiedSessions} tied sessions excluded from outcome cohorts.`}
              {` Outcome columns need ${LED_SESSION_FLOOR} led sessions; verdict rates need ${RATED_SESSION_FLOOR} ratings.`}
            </p>
            {(data?.contrasts.length ?? 0) > 0 && (
              <div className="effort-board__contrasts">
                <span className="overline">RECORDED DEVIATIONS</span>
                <ul>
                  {data!.contrasts.map((contrast) => (
                    <li key={`${contrast.projectId}\u0000${contrast.family}\u0000${contrast.effort}\u0000${contrast.metric}`}>
                      {contrastSentence(contrast)}
                    </li>
                  ))}
                </ul>
                <small>
                  These are observed differences between cohorts of whole sessions. They do not control for task
                  difficulty and are not a reason to change model or effort.
                </small>
              </div>
            )}
          </>
        )}
      </EffortState>
    </section>
  );
}

export function EffortProvenance({ effort }: { effort: ReturnType<typeof useReasoningEffort> }) {
  const { status, busy, actionError, toggle, remove } = effort;
  return (
    <section className="panel effort-privacy">
      <div className="panel-heading">
        <div>
          <span className="overline">PROVENANCE &amp; PRIVACY</span>
          <h2>Derived observation index</h2>
        </div>
        <Database />
      </div>
      {status ? <EffortIndexSummary status={status} /> : <p className="effort-empty">Index status is unavailable.</p>}
      <div className="effort-privacy-grid">
        <div>
          <h3>Stored fields</h3>
          <p>Session id, local date, provider, model, normalized effort label, token buckets, observation counts, parser offsets, hashes, and quality counters.</p>
        </div>
        <div>
          <h3>Never stored by this index</h3>
          <p>Prompts, responses, reasoning text, commands, tool arguments or results, file contents, and transcript fragments.</p>
        </div>
      </div>
      <div className="effort-index-actions">
        <button className="secondary-button" type="button" onClick={() => void toggle()} disabled={!status || busy !== null}>
          {busy === "toggle" ? <RefreshCw className="spin" /> : <Database />}
          {status?.enabled ? "Disable indexing" : "Enable indexing"}
        </button>
        <button className="secondary-button danger" type="button" onClick={() => void remove()} disabled={!status?.progress?.indexedSessions || busy !== null}>
          {busy === "delete" ? <RefreshCw className="spin" /> : <Trash2 />}
          Delete derived observations
        </button>
        <p>Disabling keeps derived rows but excludes them from analysis. Deleting also disables indexing and leaves source transcripts untouched.</p>
      </div>
      {actionError && <p className="effort-action-error" role="alert">{actionError}</p>}
    </section>
  );
}
