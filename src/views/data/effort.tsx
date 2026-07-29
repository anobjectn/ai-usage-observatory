import { useMemo, useState } from "react";
import { ArrowUpRight, Database, RefreshCw, Trash2 } from "lucide-react";
import type { DashboardData, EffortAggregate, EffortGroupRow } from "../../types";
import { providerFromAgent } from "../../provider";
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
  effortColor,
  effortLabel,
} from "../../components/effort";
import type { DataFacets } from "./insights";
import { sessionHref } from "./insights";

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

export function ReasoningEffortAnalysis({
  data,
  days,
  provider,
  pathTag,
  facets,
  onOpenSession,
}: {
  data: DashboardData;
  days: string;
  provider: string;
  pathTag: string;
  facets: DataFacets;
  onOpenSession: (sessionId: string) => void;
}) {
  const statusRequest = useEffortStatus();
  const scope = useMemo<EffortScopeInput>(() => ({
    basis: "sessions",
    rangeDays: days === "all" ? null : Number(days),
    provider: provider === "all" ? "all" : providerFromAgent(provider) ?? "all",
    pathTag,
    effort: facets.effort,
  }), [days, facets.effort, pathTag, provider]);
  const providers = useEffortAggregate("provider", scope);
  const models = useEffortAggregate("model", scope);
  const projects = useEffortAggregate("project", scope);
  const digest = useEffortSessions(scope);
  useEffortRefreshOnIndexChange(statusRequest.data?.indexVersion, [
    providers.load,
    models.load,
    projects.load,
    digest.load,
  ]);

  const decoded = useMemo(() => decodeEffortDigest(digest.data), [digest.data]);
  const supporting = useMemo(
    () => data.sessions
      .filter((session) => decoded.has(session.sessionId))
      .sort((left, right) => {
        const leftMixed = decoded.get(left.sessionId)?.mixed ? 1 : 0;
        const rightMixed = decoded.get(right.sessionId)?.mixed ? 1 : 0;
        return rightMixed - leftMixed
          || String(right.metadata?.lastActivity ?? right.period)
            .localeCompare(String(left.metadata?.lastActivity ?? left.period));
      })
      .slice(0, 8),
    [data.sessions, decoded],
  );
  const status = statusRequest.data ?? providers.data?.status ?? null;
  const [busy, setBusy] = useState<"toggle" | "delete" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = async () => {
    await Promise.all([
      statusRequest.load(),
      providers.load(),
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

  return (
    <>
      <section className="panel effort-analysis">
        <div className="panel-heading">
          <div>
            <span className="overline">RAW REASONING EFFORT</span>
            <h2>Provider-recorded effort evidence</h2>
          </div>
          <span className="method-chip local"><i /> transcript derived</span>
        </div>
        <p className="effort-help">{EFFORT_HELP}</p>
        <EffortState status={status} summary={providers.data?.total}>
          {providers.data?.total && (
            <>
              <EffortStack summary={providers.data.total} height={12} />
              <EffortCoverage
                summary={providers.data.total}
                indexing={status?.phase === "indexing"}
              />
              <div className="effort-provider-grid">
                {providers.data.rows.map((row) => (
                  <article key={row.key}>
                    <div>
                      <h3>{row.label}</h3>
                      <EffortBadge summary={row.summary} />
                    </div>
                    <EffortStack summary={row.summary} height={8} />
                    <EffortCoverage summary={row.summary} />
                  </article>
                ))}
              </div>
            </>
          )}
        </EffortState>
        <div className="effort-analysis-grid">
          <Breakdown title="MODEL BREAKDOWN" rows={models.data?.rows ?? []} empty="No event-recorded model effort is available in this scope." />
          <Breakdown title="PROJECT BREAKDOWN" rows={projects.data?.rows ?? []} empty="No project-linked effort is available in this scope." />
          <article className="effort-analysis-card">
            <span className="overline">SUPPORTING SESSIONS</span>
            {supporting.length ? (
              <ol className="effort-session-links">
                {supporting.map((session) => (
                  <li key={session.sessionId}>
                    <a
                      href={sessionHref(session.sessionId)}
                      onClick={(event) => {
                        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                        event.preventDefault();
                        onOpenSession(session.sessionId);
                      }}
                    >
                      <span>
                        <b>{session.modelsUsed[0] ?? "Unknown model"}</b>
                        <small>{session.cwd ?? "Path unavailable"}</small>
                      </span>
                      {(() => {
                        const value = decoded.get(session.sessionId);
                        const label = value?.mixed ? "Mixed" : effortLabel(value?.dominant ?? null);
                        const color = effortColor(value?.dominant ?? "");
                        return (
                          <span
                            className={`effort-badge${value?.mixed ? " effort-badge-mixed" : value?.dominant ? "" : " effort-badge-unknown"}`}
                            style={!value?.mixed && value?.dominant ? { borderColor: color, color } : undefined}
                          >
                            {label}
                          </span>
                        );
                      })()}
                      <ArrowUpRight />
                    </a>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="effort-empty">No supporting sessions match this scope.</p>
            )}
          </article>
        </div>
      </section>

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
    </>
  );
}
