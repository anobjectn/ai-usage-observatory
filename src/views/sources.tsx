import {
  CircleDollarSign,
  Clock3,
  Database,
  ExternalLink,
  Gauge,
  RefreshCw,
  Sparkles,
  Tag,
} from "lucide-react";
import { buildAnthropicCreditView, formatCredit } from "../quota-credits";
import { quotaProviderNotice } from "../quota-notice";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DashboardData } from "../types";
import { Empty, PageTitle } from "./chrome";
import { type AgentSelection } from "../agent-filter";
import { type DateRange } from "../time-range";
import { UsageIntelligence } from "./data/intelligence";
import { type DataFacets } from "./data/insights";
import { DateStamp, formatDuration, formatWarpCredits, formatCompact } from "../app/format";
import { QuotaNoticeCallout, CLAUDE_USAGE_URL } from "../components/quota-cards";

const ALLOWANCE_HELP_URL =
  "https://support.claude.com/en/articles/11647753-understanding-usage-and-length-limits";

const EXTRA_USAGE_HELP_URL =
  "https://support.claude.com/en/articles/12429409-extra-usage-for-paid-claude-plans";

function QuotaProvenance({
  data,
  onUpdateWebCredits,
}: {
  data: DashboardData;
  onUpdateWebCredits: () => void;
}) {
  const anthropic = data.quotas.usage?.providers.find(
    (provider) => provider.provider === "anthropic",
  );
  const snapshot = anthropic?.snapshot?.kind === "window" ? anthropic.snapshot : null;
  const credits = anthropic?.anthropicWebCredits ?? null;
  const view = buildAnthropicCreditView(anthropic);
  const anthropicNotice = quotaProviderNotice(anthropic);
  const history = data.quotas.history;
  if (!data.quotas.available && !credits) return null;
  return (
    <section className="panel provenance">
      <div className="panel-heading">
        <div>
          <span className="overline">QUOTA EVIDENCE</span>
          <h2>Where each allowance value comes from</h2>
        </div>
        <a href={ALLOWANCE_HELP_URL} target="_blank" rel="noreferrer" className="text-link">
          Usage &amp; length limits <ExternalLink />
        </a>
      </div>
      <div className="evidence-groups">
        <article className="evidence-group live">
          <header>
            <span className="source-symbol provider">
              <Gauge />
            </span>
            <div>
              <span className="overline">PROVIDER QUOTA API · LIVE</span>
              <code>api.anthropic.com/api/oauth/usage</code>
            </div>
            <span className={`status-label ${anthropic?.status ?? "unknown"}`}>
              {anthropic?.status ?? "unknown"}
            </span>
          </header>
          {anthropicNotice && <QuotaNoticeCallout notice={anthropicNotice} />}
          <dl className="evidence-facts">
            <div>
              <dt>Captured</dt>
              <dd>{anthropic?.capturedAt ? <DateStamp value={new Date(anthropic.capturedAt).toISOString()} /> : "—"}</dd>
            </div>
            <div>
              <dt>Data age</dt>
              <dd>{formatDuration(anthropic?.dataAgeMs)}</dd>
            </div>
            {anthropic?.servingLastGood && anthropic.lastAttemptAt ? (
              <div>
                <dt>Last attempt</dt>
                <dd><DateStamp value={new Date(anthropic.lastAttemptAt).toISOString()} /></dd>
              </div>
            ) : null}
            {snapshot?.fiveHour && (
              <div>
                <dt>5-hour</dt>
                <dd>{snapshot.fiveHour.usedPercent.toFixed(0)}% used</dd>
              </div>
            )}
            {snapshot?.weekly && (
              <div>
                <dt>Weekly</dt>
                <dd>{snapshot.weekly.usedPercent.toFixed(0)}% used</dd>
              </div>
            )}
            {Object.entries(snapshot?.modelWindows ?? {}).map(([model, window]) => (
              <div key={model}>
                <dt>{model} window</dt>
                <dd>{window.usedPercent.toFixed(0)}% used</dd>
              </div>
            ))}
            {view.usageCredit && (
              <div>
                <dt>Monthly spend</dt>
                <dd>
                  {formatCredit(view.usageCredit.spent, view.usageCredit.currency)}
                  {view.usageCredit.limit !== null
                    ? ` / ${formatCredit(view.usageCredit.limit, view.usageCredit.currency)}`
                    : ""}
                </dd>
              </div>
            )}
          </dl>
          <div className="evidence-actions">
            <a href="/api/quotas" target="_blank" rel="noreferrer" className="text-link">
              Raw normalized quota JSON <ExternalLink />
            </a>
            <a href="/api/quota-comparisons" target="_blank" rel="noreferrer" className="text-link">
              Observed tier cohorts <ExternalLink />
            </a>
          </div>
          {Array.isArray(snapshot?.extra?.rawLimits) && snapshot!.extra!.rawLimits!.length > 0 && (
            <details className="raw-evidence">
              <summary>Raw provider limits</summary>
              <pre>{JSON.stringify(snapshot!.extra!.rawLimits, null, 2)}</pre>
            </details>
          )}
        </article>

        <article className="evidence-group imported">
          <header>
            <span className="source-symbol budget">
              <CircleDollarSign />
            </span>
            <div>
              <span className="overline">CLAUDE WEB CREDITS · IMPORTED</span>
              <code>claude.ai/api/organizations/…/prepaid/credits</code>
            </div>
            <span className="method-chip budget">
              <i /> user imported
            </span>
          </header>
          <p className="evidence-boundary">
            Claude Code&apos;s OAuth token returns <code>403 account_session_invalid</code> for
            these web-session endpoints, so these values are a timestamped manual
            observation — never live provider data.
          </p>
          {credits ? (
            <>
              <dl className="evidence-facts">
                <div>
                  <dt>Observed</dt>
                  <dd><DateStamp value={new Date(credits.capturedAt).toISOString()} /></dd>
                </div>
                <div>
                  <dt>Stored</dt>
                  <dd><DateStamp value={new Date(credits.updatedAt).toISOString()} /></dd>
                </div>
                {view.prepaid && (
                  <div>
                    <dt>Prepaid balance</dt>
                    <dd>{formatCredit(view.prepaid.balance, view.prepaid.currency)}</dd>
                  </div>
                )}
              </dl>
              {view.fable && (
                <div className={`fable-credit${view.fable.expired ? " fable-credit--expired" : ""}`}>
                  <div className="fable-credit__head">
                    <span>
                      <Sparkles /> Fable transition credit
                    </span>
                    {view.fable.expired && <i className="fable-credit__badge">expired</i>}
                  </div>
                  <strong>{formatCredit(view.fable.remaining, view.fable.currency)}</strong>
                  <div className="fable-credit__meta">
                    {view.fable.grant !== null && (
                      <span>of {formatCredit(view.fable.grant, view.fable.currency)} granted</span>
                    )}
                    {view.fable.expiresOn && (
                      <span>
                        {view.fable.expired ? "expired" : "expires"} {view.fable.expiresOn}
                      </span>
                    )}
                    {view.fable.campaignId && <span>{view.fable.campaignId}</span>}
                  </div>
                </div>
              )}
            </>
          ) : (
            <p>No Claude Web snapshot imported yet.</p>
          )}
          <div className="evidence-actions">
            <button type="button" className="secondary-button" onClick={onUpdateWebCredits}>
              <RefreshCw /> {credits ? "Update snapshot" : "Import snapshot"}
            </button>
            <a href={CLAUDE_USAGE_URL} target="_blank" rel="noreferrer" className="text-link">
              Claude Settings → Usage <ExternalLink />
            </a>
            <a href={EXTRA_USAGE_HELP_URL} target="_blank" rel="noreferrer" className="text-link">
              Extra usage policy <ExternalLink />
            </a>
          </div>
        </article>

        <article className="evidence-group local">
          <header>
            <span className="source-symbol local">
              <Database />
            </span>
            <div>
              <span className="overline">LOCAL QUOTA HISTORY</span>
              <code>~/.quota-service/quota.db</code>
            </div>
            <span className="method-chip local">
              <i /> locally counted
            </span>
          </header>
          <p>
            Locally observed quota reaches and reset-credit consumption over time.
            This is AIUO&apos;s own record of what was seen, not a provider-authoritative
            ledger — the provider reports only the current window state.
          </p>
          <dl className="evidence-facts">
            <div>
              <dt>Tracking since</dt>
              <dd>
                {history?.trackingSince
                  ? <DateStamp value={new Date(history.trackingSince).toISOString()} />
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>Windows reached</dt>
              <dd>
                {history?.windows.reduce((sum, window) => sum + window.reachedCount, 0) ?? 0}× observed
              </dd>
            </div>
            <div>
              <dt>Resets consumed</dt>
              <dd>{history?.codexBankedResets.usedCount ?? 0}</dd>
            </div>
          </dl>
        </article>
      </div>
    </section>
  );
}

export function Sources({
  data,
  onRules,
  onUpdateWebCredits,
  days,
  dateRange,
  agent,
  pathTag,
  showCache,
  facets,
  onFacets,
  onOpenSession,
}: {
  data: DashboardData;
  onRules: () => void;
  onUpdateWebCredits: () => void;
  days: string;
  dateRange: DateRange | null;
  agent: AgentSelection;
  pathTag: string;
  showCache: boolean;
  facets: DataFacets;
  onFacets: (next: Partial<DataFacets>) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const warpDays = data.warp.daily.filter((day) => day.credits > 0 || day.sessions > 0);
  return (
    <div className="view-stack page-enter">
      <PageTitle
        eyebrow="USAGE INTELLIGENCE & PROVENANCE"
        title="Usage intelligence & provenance."
        description="Local activity and provider allowances remain explicitly separate."
        actions={
          <button className="secondary-button" onClick={onRules}>
            <Tag /> Path rules
          </button>
        }
      />
      <UsageIntelligence
        data={data}
        days={days}
        dateRange={dateRange}
        agent={agent}
        pathTag={pathTag}
        showCache={showCache}
        facets={facets}
        onFacets={onFacets}
        onOpenSession={onOpenSession}
      />
      <section className="sources-grid">
        <article className="panel distinction">
          <span className="source-symbol provider">
            <Gauge />
          </span>
          <span className="overline">PROVIDER QUOTA</span>
          <h2>
            {data.quotas.sourceState === "disabled" ? "Not enabled"
              : data.quotas.sourceState === "history_only" ? "History only"
                : data.quotas.sourceState === "degraded" ? "Partially connected"
                  : data.quotas.available ? "Connected" : "Not connected"}
          </h2>
          <p>
            {data.quotas.sourceState === "disabled"
              ? "Optional provider allowance collection is off."
              : data.quotas.sourceState === "history_only"
                ? "Recognized read-only history is available. Live collection is off."
                : data.quotas.sourceState === "degraded"
                  ? "Valid provider data remains available, but one or more quota sources failed."
                  : data.quotas.available
                    ? "Authoritative allowance data from quota-service."
                    : "Configured quota-service is unreachable. Analytics continue normally."}
          </p>
          <span className="method-chip">
            <i /> provider reported
          </span>
        </article>
        <article className="panel distinction">
          <span className="source-symbol local">
            <Clock3 />
          </span>
          <span className="overline">LOCAL ACTIVITY BLOCK</span>
          <h2>
            {data.blocks.find((b) => b.isActive)
              ? "Active window"
              : "Recent window"}
          </h2>
          <p>Reconstructed by ccusage from local {data.blockScope} records.</p>
          <span className="method-chip local">
            <i /> locally calculated
          </span>
        </article>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <span className="overline">DATA SOURCE HEALTH</span>
            <h2>Collection boundaries</h2>
          </div>
          <span>Updated <DateStamp value={data.collectedAt} timeZone={data.timeZone} /> · {data.timeZone} calendar</span>
        </div>
        <div className="source-list">
          {data.sources.map((source) => (
            <div key={source.name}>
              <span className={`status-dot ${source.status}`} />
              <div>
                <b>{source.name}</b>
                <small>{source.kind}</small>
              </div>
              <p>{source.detail}</p>
              <span className={`status-label ${source.status}`}>
                {source.status}
              </span>
            </div>
          ))}
        </div>
      </section>
      <section className="panel warp-ledger-panel">
        <div className="panel-heading">
          <div>
            <span className="overline">WARP LOCAL LEDGER</span>
            <h2>Credits beyond the countdown</h2>
            <p>Conversation snapshots, model/token metadata, tool categories, and credit burn gathered from Warp’s local SQLite database.</p>
          </div>
          <span className={`status-label ${data.warp.available ? "healthy" : "unavailable"}`}>
            {data.warp.available ? "read-only" : "unavailable"}
          </span>
        </div>
        {data.warp.available ? (
          <>
            <div className="warp-ledger-stats">
              <div><span>Conversation snapshots</span><b>{data.warp.sessionCount}</b></div>
              <div><span>Recorded credits</span><b>{formatWarpCredits(data.warp.totals.credits)}</b></div>
              <div><span>Query coverage</span><b>{Math.round(data.warp.queryCoverage * 100)}%</b></div>
              <div><span>Last observed</span><b><DateStamp value={data.warp.observedAt} /></b></div>
            </div>
            {warpDays.length ? (
              <div className="warp-credit-chart" role="img" aria-label="Warp credits recorded by day">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={warpDays} margin={{ top: 12, right: 12, left: -18, bottom: 0 }}>
                    <defs>
                      <linearGradient id="warpCreditsArea" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--warp-color)" stopOpacity={0.6} />
                        <stop offset="100%" stopColor="var(--warp-color)" stopOpacity={0.08} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#26312e" strokeDasharray="2 5" vertical={false} />
                    <XAxis dataKey="date" tickFormatter={(value) => new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })} tick={{ fill: "#71807b", fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={24} />
                    <YAxis tickFormatter={formatCompact} tick={{ fill: "#71807b", fontSize: 11 }} tickLine={false} axisLine={false} />
                    <Tooltip
                      cursor={{ stroke: "#71807b", strokeDasharray: "3 3" }}
                      contentStyle={{ background: "#0c1715", border: "1px solid #30413c", borderRadius: 8 }}
                      labelFormatter={(value) => new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { dateStyle: "medium" })}
                      formatter={(value) => [`${formatWarpCredits(Number(value))} credits`, "Warp"]}
                    />
                    <Area type="monotone" dataKey="credits" name="Warp credits" stroke="var(--warp-color)" strokeWidth={2} fill="url(#warpCreditsArea)" activeDot={{ r: 4, fill: "#07100f", stroke: "var(--warp-color)", strokeWidth: 2 }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : <Empty text="No credit observations are available yet." />}
            <p className="warp-machine-note"><Database /> Warp data is machine-specific. It comes from <code>{data.warp.sourceFile ?? "Warp's local database"}</code>, reflects this computer’s stored conversation snapshots, and is not a complete account-wide ledger across other devices. The app reads it read-only. Prompts you typed and the replies you got back are read from Warp’s query log and its stored agent runs. Reasoning summaries and raw command output stay out.</p>
          </>
        ) : (
          <p className="scope-note"><Database /> {data.warp.error ?? "Warp’s local database is unavailable on this machine."}</p>
        )}
      </section>
      <QuotaProvenance data={data} onUpdateWebCredits={onUpdateWebCredits} />
    </div>
  );
}
