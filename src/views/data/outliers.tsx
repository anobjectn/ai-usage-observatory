import { useState } from "react";
import { ArrowUpRight, Gauge } from "lucide-react";
import { compactTokens, type Insights, percent, providerColor, providerLabel, sessionHref, shortDate } from "./insights";

const pageSize = 8;
const reasonText: Record<string, string> = {
  "long-context": "far more total tokens than its cohort",
  "cache-heavy": "far more cache reads than its cohort",
  "output-heavy": "far more generated output than its cohort",
};

export function OutlierSessions({ insights, onOpenSession }: { insights: Insights; onOpenSession: (sessionId: string) => void }) {
  const [limit, setLimit] = useState(pageSize);
  const { outliers } = insights;
  const visible = outliers.sessions.slice(0, limit);

  return (
    <section className="data-section">
      <header className="data-section__head">
        <div>
          <span className="overline">OUTLIER SESSIONS</span>
          <h2>The sessions that move every average.</h2>
        </div>
        <p>
          Detected within cohorts of the same provider, model family, and cache mode using a modified
          z-score over log token counts — never against your whole history. Cohorts under eight
          sessions are skipped rather than guessed at. Nothing here is dropped from any total; use the
          session-type facet above to see what a figure looks like without them.
        </p>
      </header>

      <div className="outlier-summary">
        <div>
          <Gauge />
          <div>
            <b>{outliers.count}</b>
            <span>outlier sessions</span>
          </div>
        </div>
        <p>
          {percent(outliers.sessionShare, 1)} of sessions in scope carry {percent(outliers.tokenShare, 1)} of
          processed tokens. {outliers.cohortsEvaluated} cohort{outliers.cohortsEvaluated === 1 ? "" : "s"} were large
          enough to test{outliers.cohortsSkipped ? `; ${outliers.cohortsSkipped} were too small` : ""}.
        </p>
      </div>

      {visible.length === 0 ? (
        <p className="data-empty">No cohort in this scope produced an outlier. That is a result, not a gap — every session sat within 3.5 modified z-scores of its cohort median.</p>
      ) : (
        <ul className="outlier-list">
          {visible.map((row) => (
            <li key={row.sessionId}>
              <div className="outlier-list__head">
                <span className="outlier-list__id">
                  <i style={{ background: providerColor(row.provider) }} />
                  {providerLabel(row.provider)} · {row.project}
                </span>
                <span className="outlier-list__when">
                  {row.date ? <time dateTime={row.date}>{shortDate(row.date)}</time> : shortDate(row.date)}
                </span>
                <a
                  href={sessionHref(row.sessionId)}
                  onClick={(event) => { if (event.metaKey || event.ctrlKey || event.shiftKey) return; event.preventDefault(); onOpenSession(row.sessionId); }}
                >
                  Open session <ArrowUpRight />
                </a>
              </div>
              <p className="outlier-list__why">
                {row.timesCohortMedian === null
                  ? "No cohort median to compare against"
                  : row.timesCohortMedian >= 1
                    ? `${row.timesCohortMedian.toFixed(1)}x the ${row.family} median of ${compactTokens.format(row.cohortMedian)}`
                    : `Smaller than the ${row.family} median of ${compactTokens.format(row.cohortMedian)}, but skewed in shape`}
                {" — "}
                {row.reasons.map((reason) => reasonText[reason] ?? reason).join("; ")}.
              </p>
              <dl>
                <div>
                  <dt>Processed</dt>
                  <dd>{compactTokens.format(row.processed)}</dd>
                </div>
                <div>
                  <dt>Output</dt>
                  <dd>{compactTokens.format(row.output)}</dd>
                </div>
                <div>
                  <dt>Cache read</dt>
                  <dd>{compactTokens.format(row.cacheRead)}</dd>
                </div>
                <div>
                  <dt>Cache write</dt>
                  <dd>{row.cacheCreation ? compactTokens.format(row.cacheCreation) : "N/A"}</dd>
                </div>
                <div>
                  <dt>Est. turns</dt>
                  <dd>{row.estimatedTurns ?? "N/A"}</dd>
                </div>
                <div>
                  <dt>Model</dt>
                  <dd>{row.model}</dd>
                </div>
                <div>
                  <dt>API-equivalent</dt>
                  <dd>${row.cost.toFixed(2)}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}

      {limit < outliers.sessions.length && (
        <div className="data-more">
          <button type="button" className="secondary-button" onClick={() => setLimit(limit + pageSize * 2)}>
            Show {Math.min(pageSize * 2, outliers.sessions.length - limit)} more
          </button>
        </div>
      )}
    </section>
  );
}
