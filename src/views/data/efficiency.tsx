import { useState } from "react";
import { ArrowUpRight, Lightbulb } from "lucide-react";
import { familyColor, familyLabel, effortColor, effortLabel, SplitPill } from "../../components/effort";
import { effortSummaryLabel, type DecodedSessionEffort } from "../../hooks/use-effort";
import { familyOf } from "../../model-family";
import { compactTokens, type DataFacets, type Insights, percent, providerColor, providerLabel, sessionHref, shortDate } from "./insights";

const pageSize = 12;

export function EfficiencyFindings({
  insights,
  facets,
  onChange,
  onOpenSession,
  effortBySession,
  aside,
}: {
  insights: Insights;
  facets: DataFacets;
  onChange: (next: Partial<DataFacets>) => void;
  onOpenSession: (sessionId: string) => void;
  effortBySession: Map<string, DecodedSessionEffort>;
  /** Rendered beside the findings list. Both read the same facets, so they belong to one section
   * rather than two stacked ones. */
  aside?: React.ReactNode;
}) {
  const [limit, setLimit] = useState(pageSize);
  const { rules, findings, truncated, totals } = insights.efficiency;
  const active = rules.find((rule) => rule.id === facets.finding);
  const visible = findings.slice(0, limit);

  return (
    <section className="data-section">
      <header className="data-section__head">
        <div>
          <span className="overline">EFFICIENCY FINDINGS</span>
          <h2>What to do differently next time.</h2>
        </div>
        <p>
          Six heuristics over your own session token buckets, each comparing a session against others
          of the same provider and model family rather than an absolute target. They are probabilistic
          suggestions about past sessions, not verdicts — a deliberately long research thread will
          look identical to one that should have been split.
        </p>
      </header>

      <div className="finding-summary">
        <div className="finding-summary__stat">
          <b>{totals.flaggedSessions}</b>
          <span>sessions flagged</span>
          <small>{percent(totals.sessionShare, 1)} of sessions in view · {totals.findings} findings</small>
        </div>
        <div className="finding-summary__stat">
          <b>{compactTokens.format(totals.recoverable)}</b>
          <span>tokens plausibly avoidable</span>
          <small>{percent(totals.recoverableShare, 1)} of processed tokens, from the two rules where a counterfactual is defensible</small>
        </div>
      </div>

      <div className="rule-chips" role="group" aria-label="Filter findings by rule">
        <button type="button" className={facets.finding === "all" ? "active" : ""} onClick={() => { onChange({ finding: "all" }); setLimit(pageSize); }}>
          All findings <b>{totals.findings}</b>
        </button>
        {rules.map((rule) => (
          <button
            type="button"
            key={rule.id}
            className={`${facets.finding === rule.id ? "active" : ""} severity-${rule.severity}`}
            disabled={rule.count === 0}
            onClick={() => { onChange({ finding: rule.id }); setLimit(pageSize); }}
            title={rule.question}
          >
            {rule.label} <b>{rule.count}</b>
          </button>
        ))}
      </div>

      {active && (
        <div className="rule-basis">
          <Lightbulb />
          <div>
            <b>{active.question}</b>
            <p>{active.basis}</p>
          </div>
        </div>
      )}

      <div className={aside ? "findings-split" : undefined}>
        <div className="findings-split__list">
      {visible.length === 0 ? (
        <p className="data-empty">
          No session in the current scope trips {active ? `the ${active.label.toLowerCase()} rule` : "any rule"}. Widen
          the range or switch the session-type facet to see more.
        </p>
      ) : (
        <ol className="finding-list">
          {visible.map((finding) => (
            <li key={`${finding.ruleId}-${finding.sessionId}`} className={`finding severity-${finding.severity}`}>
              <div className="finding__top">
                <span className="finding__rule">{rules.find((rule) => rule.id === finding.ruleId)?.label ?? finding.ruleId}</span>
                {(() => {
                  const family = familyOf(finding.model);
                  const decoded = effortBySession.get(finding.sessionId);
                  const effort = effortSummaryLabel(decoded);
                  const labelledEffort = decoded?.dominant
                    ? effort.replace(decoded.dominant, effortLabel(decoded.dominant))
                    : effort;
                  return (
                    <SplitPill
                      left={{ label: familyLabel(family), color: familyColor(family) }}
                      right={{
                        label: labelledEffort.charAt(0).toUpperCase() + labelledEffort.slice(1),
                        color: effortColor(decoded?.dominant ?? ""),
                      }}
                    />
                  );
                })()}
                <span className="finding__meta">
                  <i style={{ background: providerColor(finding.provider) }} />
                  {providerLabel(finding.provider)} · {finding.project} · {shortDate(finding.date)}
                </span>
                <a
                  className="finding__open"
                  href={sessionHref(finding.sessionId)}
                  onClick={(event) => { if (event.metaKey || event.ctrlKey || event.shiftKey) return; event.preventDefault(); onOpenSession(finding.sessionId); }}
                >
                  Open session <ArrowUpRight />
                </a>
              </div>
              <p className="finding__headline">{finding.headline}</p>
              <dl className="finding__metrics">
                {finding.metrics.map((metric) => (
                  <div key={metric.label}>
                    <dt>{metric.label}</dt>
                    <dd>{metric.value}</dd>
                  </div>
                ))}
                {finding.recoverable !== null && (
                  <div className="finding__recoverable">
                    <dt>Plausibly avoidable</dt>
                    <dd>{compactTokens.format(finding.recoverable)} tokens</dd>
                  </div>
                )}
              </dl>
            </li>
          ))}
        </ol>
      )}

      {(limit < findings.length || truncated > 0) && (
        <div className="data-more">
          {limit < findings.length && (
            <button type="button" className="secondary-button" onClick={() => setLimit(limit + pageSize * 2)}>
              Show {Math.min(pageSize * 2, findings.length - limit)} more
            </button>
          )}
          {truncated > 0 && <small>{truncated} further findings are outside the served window — narrow the range or pick a single rule.</small>}
        </div>
      )}
        </div>
        {aside && <div className="findings-split__aside">{aside}</div>}
      </div>
    </section>
  );
}
