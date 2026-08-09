import { useMemo, useState } from "react";
import { Database, RefreshCw, Trash2 } from "lucide-react";
import type { EffortGroupRow } from "../../types";
import {
  decodeEffortDigest,
  deleteEffortDerivedObservations,
  setEffortIndexing,
  useEffortAggregate,
  useEffortRefreshOnIndexChange,
  useEffortSessions,
  useEffortStatus,
  type EffortScopeInput,
} from "../../hooks/use-effort";
import {
  EffortBadge,
  EffortCoverage,
  EffortIndexSummary,
  EffortStack,
  EffortState,
  EFFORT_HELP,
} from "../../components/effort";
import type { DataFacets } from "./insights";
import type { DateRange } from "../../time-range";

function Breakdown({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: EffortGroupRow[];
  empty: string;
}) {
  const visible = rows
    .filter((row) => row.summary.coverageState !== "unavailable")
    .slice(0, 10);
  return (
    <article className="effort-analysis-card">
      <span className="overline">{title}</span>
      {visible.length ? (
        <ol className="effort-breakdown-list">
          {visible.map((row) => (
            <li key={row.key}>
              <div>
                <b>{row.label}</b>
                <EffortBadge summary={row.summary} />
              </div>
              <EffortStack summary={row.summary} height={6} showLegend={false} />
              <EffortCoverage summary={row.summary} />
            </li>
          ))}
        </ol>
      ) : (
        <p className="effort-empty">{empty}</p>
      )}
    </article>
  );
}

export function useReasoningEffort({
  days,
  dateRange,
  providers,
  modelFamilies,
  pathTag,
  facets,
}: {
  days: string;
  dateRange: DateRange | null;
  providers: string[];
  modelFamilies: string[];
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
  const models = useEffortAggregate("model", scope);
  const projects = useEffortAggregate("project", scope);
  const digest = useEffortSessions(scope);
  useEffortRefreshOnIndexChange(statusRequest.data?.indexVersion, [
    models.load,
    projects.load,
    digest.load,
  ]);

  const decoded = useMemo(() => decodeEffortDigest(digest.data), [digest.data]);
  const status = statusRequest.data ?? models.data?.status ?? projects.data?.status ?? null;
  const [busy, setBusy] = useState<"toggle" | "delete" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = async () => {
    await Promise.all([
      statusRequest.load(),
      models.load(),
      projects.load(),
      digest.load(),
    ]);
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

  return { status, models, projects, decoded, busy, actionError, toggle, remove };
}

export function ReasoningEffortAnalysis({
  effort,
}: {
  effort: ReturnType<typeof useReasoningEffort>;
}) {
  const { status, models, projects } = effort;

  return (
    <section className="panel effort-analysis">
      <div className="panel-heading">
        <div>
          <span className="overline">RAW REASONING EFFORT</span>
          <h2>Provider-recorded effort evidence</h2>
        </div>
        <span className="method-chip local"><i /> transcript derived</span>
      </div>
      <p className="effort-help">{EFFORT_HELP}</p>
      <EffortState status={status} summary={models.data?.total ?? projects.data?.total}>
        <div className="effort-analysis-grid">
          <Breakdown title="MODEL BREAKDOWN" rows={models.data?.rows ?? []} empty="No event-recorded model effort is available in this scope." />
          <Breakdown title="PROJECT BREAKDOWN" rows={projects.data?.rows ?? []} empty="No project-linked effort is available in this scope." />
        </div>
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
