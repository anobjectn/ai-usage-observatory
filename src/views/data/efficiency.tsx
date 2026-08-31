import { ArrowUpRight, ChevronLeft, ChevronRight, Lightbulb } from "lucide-react";
import { ComboPill } from "../../components/effort";
import { type DecodedSessionEffort } from "../../hooks/use-effort";
import { familyOf } from "../../model-family";
import { compactTokens, type DataFacets, type Insights, percent, providerColor, providerLabel, sessionHref, shortDate } from "./insights";

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
  const { rules, groups, groupPage, groupPages, totals } = insights.efficiency;
  const active = rules.find((rule) => rule.id === facets.finding);

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
        <button type="button" className={facets.finding === "all" ? "active" : ""} onClick={() => onChange({ finding: "all", findingPage: 1 })}>
          All findings <b>{totals.findings}</b>
        </button>
        {rules.map((rule) => (
          <button
            type="button"
            key={rule.id}
            className={`${facets.finding === rule.id ? "active" : ""} severity-${rule.severity}`}
            disabled={rule.count === 0}
            onClick={() => onChange({ finding: rule.id, findingPage: 1 })}
            title={`${rule.question}${rule.recoverable > 0 ? ` · ${compactTokens.format(rule.recoverable)} tokens plausibly avoidable under this rule` : ""}`}
          >
            {rule.label} <b>{rule.count}</b>
            {rule.recoverable > 0 && <small>{compactTokens.format(rule.recoverable)}</small>}
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
      {groups.length === 0 ? (
        <p className="data-empty">
          No session in the current scope trips {active ? `the ${active.label.toLowerCase()} rule` : "any rule"}. Widen
          the range or switch the session-type facet to see more.
        </p>
      ) : (
        <ol className="finding-list">
          {groups.map((group) => (
            <li key={group.sessionId} className="finding-group">
              <div className="finding__top">
                {(() => {
                  // The dominant combo the digest recorded, falling back to this session's own
                  // dominant model with no effort rather than inventing one.
                  const decoded = effortBySession.get(group.sessionId);
                  const combo = decoded?.dominantCombo ?? { family: familyOf(group.model), effort: "" };
                  const extra = (decoded?.combos.length ?? 1) - 1;
                  return <ComboPill combo={combo} trailing={extra > 0 ? `+${extra}` : undefined} />;
                })()}
                <span className="finding__meta">
                  <i style={{ background: providerColor(group.provider) }} />
                  {providerLabel(group.provider)} · {group.project} ·{" "}
                  {group.date ? <time dateTime={group.date}>{shortDate(group.date)}</time> : shortDate(group.date)}
                </span>
                <span className="finding-group__totals">
                  {compactTokens.format(group.processed)} tokens · ${group.cost.toFixed(2)}
                  {group.recoverable > 0 && <b> · {compactTokens.format(group.recoverable)} avoidable</b>}
                </span>
                <a
                  className="finding__open"
                  href={sessionHref(group.sessionId)}
                  onClick={(event) => { if (event.metaKey || event.ctrlKey || event.shiftKey) return; event.preventDefault(); onOpenSession(group.sessionId); }}
                >
                  Open session <ArrowUpRight />
                </a>
              </div>
              <ol className="finding-group__findings">
                {group.findings.map((finding) => (
                  <li key={`${finding.ruleId}-${finding.headline}`} className={`finding severity-${finding.severity}`}>
                    <div className="finding__top">
                      <span className="finding__rule">{rules.find((rule) => rule.id === finding.ruleId)?.label ?? finding.ruleId}</span>
                      <p className="finding__headline">{finding.headline}</p>
                    </div>
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
            </li>
          ))}
        </ol>
      )}

      {groupPages > 1 && (
        <nav className="data-more finding-pagination" aria-label="Flagged session pages">
          <button
            type="button"
            className="secondary-button"
            disabled={groupPage <= 1}
            onClick={() => onChange({ findingPage: groupPage - 1 })}
          >
            <ChevronLeft aria-hidden="true" /> Previous
          </button>
          <small>
            page {groupPage} of {groupPages} · {totals.flaggedSessions} flagged sessions
          </small>
          <button
            type="button"
            className="secondary-button"
            disabled={groupPage >= groupPages}
            onClick={() => onChange({ findingPage: groupPage + 1 })}
          >
            Next <ChevronRight aria-hidden="true" />
          </button>
        </nav>
      )}
        </div>
        {aside && <div className="findings-split__aside">{aside}</div>}
      </div>
    </section>
  );
}
