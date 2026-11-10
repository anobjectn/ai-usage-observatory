import { type CSSProperties, useId, useState } from "react";
import { ChevronRight, CircleDollarSign, Clock3, RefreshCw, Sparkles, Zap } from "lucide-react";
import {
  quotaPlanLabel,
  reachClockSummary,
  reachHourBuckets,
  reachTierBuckets,
  reachWeekBuckets,
} from "../quota-reaches";
import {
  buildAnthropicCreditView,
  buildCodexCreditView,
  formatCredit,
  type AnthropicCreditView,
  type CodexCreditView,
  type CreditFreshness,
} from "../quota-credits";
import { warpQuotaSummary } from "../warp-quota";
import { type QuotaNotice } from "../quota-notice";
import type { DashboardData, QuotaReach, QuotaProvider } from "../types";
import { ChartTooltipContext } from "./chart-pins";
import { PieGlyph } from "./pie-glyph";
import {
  formatDuration,
  formatDate,
  formatWarpCredits,
  formatCompactDate,
  resetCopy,
  expiryCopy,
} from "../app/format";
import { quotaCards, type QuotaBucket, type QuotaCard } from "../app/analytics";
import { saveQuotaDetailsOpen, savedQuotaDetailsOpen } from "../app/preferences";

function WarpQuotaDetails({ report }: { report: QuotaProvider | undefined }) {
  const summary = warpQuotaSummary(report);
  const freshness =
    summary.dataAgeMs === null ? "unknown" : `${formatDuration(summary.dataAgeMs)} ago`;
  const hasVoice =
    summary.voiceRequestsUsed !== null ||
    summary.voiceRequestLimit !== null ||
    summary.voiceUnlimited !== null;
  const hasCodebase =
    summary.codebaseIndicesLimit !== null ||
    summary.codebaseIndicesUnlimited !== null ||
    summary.maxFilesPerRepo !== null;
  const hasDetails =
    summary.remainingRequests !== null ||
    summary.dataAgeMs !== null ||
    summary.addonCredits !== null ||
    hasVoice ||
    hasCodebase;

  if (!hasDetails) return null;

  const addonMeta =
    summary.addonCreditNote ??
    (summary.addonCreditUpdatedAt === null
      ? "manually reported"
      : `updated ${formatDate(new Date(summary.addonCreditUpdatedAt).toISOString())}`);
  const voiceParts = [
    summary.voiceRequestsUsed === null
      ? null
      : `${summary.voiceRequestsUsed.toLocaleString()} used`,
    summary.voiceRequestLimit === null
      ? summary.voiceUnlimited === true
        ? "unlimited"
        : null
      : `of ${summary.voiceRequestLimit.toLocaleString()}`,
  ].filter((part): part is string => part !== null);

  return (
    <div className="warp-quota-details" aria-label="Warp quota details">
      <div className="warp-quota-facts">
        {summary.remainingRequests !== null && (
          <div>
            <span>Remaining</span>
            <b>{summary.remainingRequests.toLocaleString()} requests</b>
          </div>
        )}
        <div>
          <span>Freshness</span>
          <b>{freshness}</b>
        </div>
      </div>
      {summary.addonCredits !== null && (
        <div className="warp-quota-credit">
          <div className="warp-quota-detail-head">
            <span>Manual add-on credits</span>
            <b>{formatWarpCredits(summary.addonCredits)}</b>
          </div>
          <small>{addonMeta} · separate from the request pool</small>
        </div>
      )}
      {(hasVoice || hasCodebase) && (
        <div className="warp-quota-features">
          <div className="warp-quota-detail-head">
            <span>Feature limits</span>
            <small>provider reported</small>
          </div>
          <dl>
            {hasVoice && (
              <div>
                <dt>Voice requests</dt>
                <dd>{voiceParts.length ? voiceParts.join(" ") : "not reported"}</dd>
              </div>
            )}
            {summary.codebaseIndicesLimit !== null || summary.codebaseIndicesUnlimited !== null ? (
              <div>
                <dt>Codebase indices</dt>
                <dd>
                  {summary.codebaseIndicesUnlimited === true
                    ? "Unlimited"
                    : summary.codebaseIndicesLimit === null
                      ? "not reported"
                      : `max ${summary.codebaseIndicesLimit.toLocaleString()}`}
                </dd>
              </div>
            ) : null}
            {summary.maxFilesPerRepo !== null && (
              <div>
                <dt>Files per repository</dt>
                <dd>max {summary.maxFilesPerRepo.toLocaleString()}</dd>
              </div>
            )}
          </dl>
          <small>Feature limits are separate from monthly request usage.</small>
        </div>
      )}
    </div>
  );
}

export const CLAUDE_USAGE_URL = "https://claude.ai/new#settings/usage";

const freshnessLabel: Record<CreditFreshness, string> = {
  fresh: "fresh",
  aging: "aging",
  stale: "stale",
};

function importedAgo(capturedAt: number): string {
  const ms = Date.now() - capturedAt;
  if (ms < 60_000) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function FableCreditBox({
  fable,
  importedAt,
  importFreshness,
}: {
  fable: NonNullable<AnthropicCreditView["fable"]>;
  importedAt: number | null;
  importFreshness: CreditFreshness | null;
}) {
  return (
    <div className={`fable-credit${fable.expired ? " fable-credit--expired" : ""}`}>
      <div className="fable-credit__head">
        <span>
          <Sparkles /> Fable transition credit
        </span>
        {fable.expired && <i className="fable-credit__badge">expired</i>}
      </div>
      <strong>{formatCredit(fable.remaining, fable.currency)}</strong>
      <div className="fable-credit__meta">
        {fable.grant !== null && (
          <span>of {formatCredit(fable.grant, fable.currency)} granted</span>
        )}
        {fable.expiresOn && (
          <span>
            {fable.expired ? "expired" : "expires"} {fable.expiresOn}
          </span>
        )}
        {fable.campaignId && (
          <span>
            {fable.campaignId}
            {fable.campaignGranted === false ? " · not granted" : ""}
          </span>
        )}
        {importedAt !== null && (
          <span>
            imported {importedAgo(importedAt)}
            {importFreshness && importFreshness !== "fresh"
              ? ` · ${freshnessLabel[importFreshness]}`
              : ""}
          </span>
        )}
      </div>
    </div>
  );
}

function AnthropicCredits({
  view,
  onUpdate,
}: {
  view: AnthropicCreditView;
  onUpdate?: () => void;
}) {
  const { usageCredit, prepaid, fable, importedAt, importFreshness } = view;
  if (!usageCredit && !prepaid && !fable) {
    // Nothing to show, but still offer the import affordance so a first-time
    // user can seed the Claude Web snapshot.
    return onUpdate ? (
      <div className="quota-credits quota-credits--empty">
        <button type="button" className="ghost-button" onClick={onUpdate}>
          <CircleDollarSign /> Add Claude Web credits
        </button>
      </div>
    ) : null;
  }
  return (
    <div className="quota-credits">
      {usageCredit && (
        <div className="credit-line">
          <span className="credit-line__label">
            <Zap /> Usage credit spend
          </span>
          <b>
            {formatCredit(usageCredit.spent, usageCredit.currency)}
            {usageCredit.limit !== null && (
              <span className="credit-line__cap">
                {" / "}
                {formatCredit(usageCredit.limit, usageCredit.currency)}
              </span>
            )}
          </b>
          <small>
            {usageCredit.percent !== null ? `${usageCredit.percent.toFixed(0)}% used · ` : ""}
            {usageCredit.enabled ? "enabled" : "disabled"} · live OAuth
          </small>
        </div>
      )}
      {prepaid && (
        <div className="credit-line">
          <span className="credit-line__label">
            <CircleDollarSign /> Prepaid balance
          </span>
          <b>{formatCredit(prepaid.balance, prepaid.currency)}</b>
          <small>
            imported {importedAgo(prepaid.capturedAt)}
            {prepaid.freshness && prepaid.freshness !== "fresh"
              ? ` · ${freshnessLabel[prepaid.freshness]}`
              : ""}{" "}
            · Claude Web import
          </small>
        </div>
      )}
      {fable && fable.expired && (
        // An expired credit is a record, not headroom, so it stays folded.
        <details className="fable-credit-history">
          <summary>
            <span>
              <ChevronRight aria-hidden="true" />
              <Sparkles aria-hidden="true" /> Fable transition credit
            </span>
            <b>expired</b>
          </summary>
          <FableCreditBox fable={fable} importedAt={importedAt} importFreshness={importFreshness} />
        </details>
      )}
      {fable && !fable.expired && (
        <FableCreditBox fable={fable} importedAt={importedAt} importFreshness={importFreshness} />
      )}
      {onUpdate && (
        <button type="button" className="ghost-button credit-update" onClick={onUpdate}>
          <RefreshCw /> Update Claude Web snapshot
        </button>
      )}
    </div>
  );
}

function CodexCredits({ view }: { view: CodexCreditView }) {
  if (!view) return null;
  return (
    <div className="quota-credits">
      <div className="credit-line">
        <span className="credit-line__label">
          <Sparkles /> Codex credits
        </span>
        <b>{view.unlimited ? "Unlimited" : view.balance === null ? "—" : view.balance.toLocaleString()}</b>
        <small>{view.hasCredits ? "available · OpenAI account balance" : "not currently available · OpenAI account balance"}</small>
      </div>
    </div>
  );
}


/** The reach history as a pattern instead of a list: reaches per trailing week
 * (is this getting more frequent?) and a wall-clock strip (when do walls land?).
 * The raw timestamps stay available behind a disclosure. */
function ReachPattern({
  providerLabel,
  windowLabel,
  reachedAt,
  reaches,
  timeZone,
}: {
  providerLabel: string;
  windowLabel: string;
  reachedAt: number[];
  reaches?: QuotaReach[];
  timeZone: string;
}) {
  const weeks = reachWeekBuckets(reachedAt, timeZone);
  const hours = reachHourBuckets(reachedAt, timeZone);
  const clockSummary = reachClockSummary(hours);
  const weekMax = Math.max(1, ...weeks.map((week) => week.count));
  const hourMax = Math.max(1, ...hours.map((bucket) => bucket.count));
  const strip = weeks.length > 0 && weeks.some((week) => week.count > 0);
  const reachDetails = reachedAt.map((instant) =>
    reaches?.find((reach) => reach.reachedAt === instant) ?? {
      reachedAt: instant,
      plan: { id: null, label: null, source: "unknown" as const, effectiveFrom: null },
    },
  );
  const tierBuckets = reachTierBuckets(reachDetails);
  const tierSource = (source: QuotaReach["plan"]["source"]) =>
    source === "provider"
      ? "Provider reported"
      : source === "configured"
        ? "Configured plan assignment"
        : "No tier recorded";
  return (
    <div className="reach-pattern">
      {strip && (
        <div
          className="reach-pattern__weeks"
          role="img"
          aria-label={`${providerLabel} ${windowLabel} reaches per week: ${weeks
            .map((week) => `${week.label} ${week.count}`)
            .join(", ")}`}
        >
          {weeks.map((week) => (
            <div className="reach-pattern__week" key={week.key} title={`Week of ${week.label}: ${week.count === 1 ? "1 reach" : `${week.count} reaches`}`}>
              <i
                style={{ "--reach": `${Math.round((week.count / weekMax) * 100)}%` } as CSSProperties}
                data-empty={week.count === 0 ? "" : undefined}
              />
              <span>{week.count > 0 ? week.count : ""}</span>
            </div>
          ))}
        </div>
      )}
      {clockSummary && <small className="reach-pattern__clock">{clockSummary}</small>}
      {strip && (
        <div
          className="reach-pattern__hours"
          role="img"
          aria-label={`${providerLabel} ${windowLabel} reaches by hour of day`}
        >
          {hours.map((bucket) => (
            <i
              key={bucket.hour}
              style={{ "--reach": `${Math.round((bucket.count / hourMax) * 100)}%` } as CSSProperties}
              data-empty={bucket.count === 0 ? "" : undefined}
              title={`${bucket.hour}:00 · ${bucket.count === 1 ? "1 reach" : `${bucket.count} reaches`}`}
            />
          ))}
        </div>
      )}
      {reachedAt.length > 0 && (
        <details className="reach-pattern__log">
          <summary>
            {reachedAt.length === 1 ? "1 recorded reach" : `All ${reachedAt.length} reaches`}
          </summary>
          <div className="reach-pattern__tiers">
            <span>Reaches by account tier</span>
            <div>
              {tierBuckets.map((tier) => (
                <span
                  className={tier.source}
                  key={tier.key}
                  title={tierSource(tier.source)}
                >
                  {tier.label} <b>{tier.count}</b>
                </span>
              ))}
            </div>
            <small>Compare within one tier.</small>
          </div>
          <ol aria-label={`${providerLabel} ${windowLabel} quota reaches`}>
            {reachDetails.map((reach) => (
              <li key={reach.reachedAt}>
                <time dateTime={new Date(reach.reachedAt).toISOString()}>
                  {formatCompactDate(new Date(reach.reachedAt).toISOString(), { timeZone, separator: ", " })}
                </time>
                <span
                  className={`reach-pattern__tier ${reach.plan.source}`}
                  title={tierSource(reach.plan.source)}
                >
                  {quotaPlanLabel(reach.plan.label)}
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}
      <ChartTooltipContext
        className="reach-pattern__tier-note"
        description="The expanded log uses the plan recorded when each quota cycle first reached its limit. Compare reach frequency within the same tier."
      />
    </div>
  );
}

/* The dial fits about six characters inside its ring; the row beside it keeps the full word. */
function dialStateLabel(state: string): string {
  if (state === "unavailable") return "n/a";
  if (state === "suspended") return "paused";
  return state;
}

/* The glance names each window in a character or two; its info popover spells the window out. */
function glanceWindowLabel(windowLabel: string): string {
  if (windowLabel === "5-hour") return "5h";
  return windowLabel.charAt(0).toLowerCase();
}

/* Whole hours past the first hour: the glance answers "how long, roughly"; the popover is exact.
   On screen the units run together ("1d4h"); accessible names pass a space. */
function glanceCountdown(ms: number, gap = ""): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  if (days > 0) return hours > 0 ? `${days}d${gap}${hours}h` : `${days}d`;
  return hours > 0 ? `${hours}h` : `${minutes}m`;
}

/* A banked reset escalates as it nears expiry: tinted inside a week, glowing inside three days,
   pulsing red inside the last day. */
type ExpiryStage = "soon" | "near" | "lapsing" | null;
function expiryStage(ms: number): ExpiryStage {
  if (ms <= 86_400_000) return "lapsing";
  if (ms <= 3 * 86_400_000) return "near";
  if (ms <= 7 * 86_400_000) return "soon";
  return null;
}

/** Headroom the glance may present as current; an expired window's old percentage is not. */
function glanceLeft(bucket: QuotaBucket): number | null {
  if (bucket.usedPercent === null || bucket.state === "expired") return null;
  return Math.max(0, Math.min(100, 100 - bucket.usedPercent));
}

/** Label/value rows for a glance popover; the popover sizes to its longest row. */
function GlanceTip({
  title,
  aside,
  rows,
  note,
}: {
  title: string;
  aside?: string | null;
  rows: Array<[label: string, value: string] | false | null | undefined>;
  note?: string;
}) {
  return (
    <span className="quota-glance-tip">
      <span className="quota-glance-tip__head">
        <b>{title}</b>
        {aside && <i>{aside}</i>}
      </span>
      <span className="quota-glance-tip__rows">
        {rows.filter((row): row is [string, string] => Boolean(row)).map(([label, value]) => (
          <span key={label}>
            <span>{label}</span>
            <span>{value}</span>
          </span>
        ))}
      </span>
      {note && <small>{note}</small>}
    </span>
  );
}

function GlanceBucket({
  card,
  bucket,
  trackingSince,
}: {
  card: QuotaCard;
  bucket: QuotaBucket;
  trackingSince: string | null;
}) {
  const left = glanceLeft(bucket);
  const untilReset =
    left !== null && bucket.resetAt !== null && bucket.resetAt > Date.now()
      ? bucket.resetAt - Date.now()
      : null;
  const summary = `${bucket.windowLabel}: ${left === null ? bucket.state : `${left.toFixed(0)}% left`}${
    untilReset === null ? "" : `, ${bucket.resetVerb} in ${glanceCountdown(untilReset, " ")}`
  }`;
  const resetLabel = bucket.resetVerb === "renews" ? "Renews" : "Resets";
  return (
    <span
      className={`quota-glance__bucket ${bucket.state}${left !== null && left < 20 ? " is-low" : ""}`}
    >
      <b>{glanceWindowLabel(bucket.windowLabel)}</b>
      <PieGlyph share={(left ?? 0) / 100} label={summary} />
      {left === null ? (
        <small>{dialStateLabel(bucket.state)}</small>
      ) : (
        <>
          <span className="quota-glance__pct" aria-hidden="true">{left.toFixed(0)}%</span>
          {untilReset !== null && (
            <small className="quota-glance__reset">
              <Clock3 aria-hidden="true" />
              {glanceCountdown(untilReset)}
            </small>
          )}
        </>
      )}
      <ChartTooltipContext
        className="quota-glance__info"
        infoLabel={`${card.providerLabel} ${bucket.windowLabel} details`}
        description={
          <GlanceTip
            title={`${card.providerLabel} · ${bucket.windowLabel}`}
            aside={card.planLabel}
            rows={[
              left === null
                ? ["Status", bucket.detail]
                : ["Left", `${left.toFixed(0)}% · ${(100 - left).toFixed(0)}% used`],
              left !== null && bucket.detail !== `${left.toFixed(0)}% left` && ["Used", bucket.detail],
              bucket.state === "suspended"
                ? ["Status", "Rate limit temporarily suspended"]
                : [resetLabel, resetCopy(bucket.resetAt, bucket.resetVerb).replace(/^(resets|renews) /, "")],
              bucket.historyWindow && [
                "Limit hit",
                bucket.reachedCount === undefined
                  ? "not tracked"
                  : `${bucket.reachedCount}×${trackingSince ? ` since ${trackingSince}` : ""}`,
              ],
              card.state !== "ok" && ["Reading", card.stateLabel],
            ]}
            note={
              bucket.historyWindow && bucket.reachedCount !== undefined
                ? "Window levels are provider reported; limit hits are counted locally."
                : "Provider reported."
            }
          />
        }
      />
    </span>
  );
}

/** Banked resets restore headroom on demand; the glance lists when each unused one lapses. */
function GlanceResets({ card }: { card: QuotaCard }) {
  const now = Date.now();
  const credits = card.bankedResets
    .map((credit) => ({ ...credit, at: credit.expiresAt ? Date.parse(credit.expiresAt) : NaN }))
    .sort((a, b) => (Number.isFinite(a.at) ? a.at : Infinity) - (Number.isFinite(b.at) ? b.at : Infinity));
  const upcoming = credits.filter((credit) => Number.isFinite(credit.at) && credit.at > now);
  const lapsing = upcoming.some((credit) => expiryStage(credit.at - now) === "lapsing");
  return (
    <div
      className={`quota-glance__provider ${card.provider} quota-glance__resets${lapsing ? " has-lapsing" : ""}`}
    >
      <dt>Resets</dt>
      <dd>
        <span className="quota-glance__bucket">
          <b>{credits.length}</b>
          <small>banked</small>
        </span>
        {upcoming.length > 0 && (
          <span className="quota-glance__bucket quota-glance__expiries">
            <small>{upcoming.length === 1 ? "expires" : "expire"}</small>
            {upcoming.map((credit) => (
              <small
                className={`quota-glance__reset quota-glance__expiry${
                  expiryStage(credit.at - now) ? ` is-${expiryStage(credit.at - now)}` : ""
                }`}
                key={credit.id}
              >
                <Clock3 aria-hidden="true" />
                {glanceCountdown(credit.at - now)}
              </small>
            ))}
            <ChartTooltipContext
              className="quota-glance__info"
              infoLabel={`${card.providerLabel} banked reset expirations`}
              description={
                <GlanceTip
                  title={`${card.providerLabel} · banked resets`}
                  rows={credits.map((credit, index) => [
                    credits.length > 1 ? `${credit.title} ${index + 1}` : credit.title,
                    expiryCopy(credit.expiresAt).text.replace(/^expires /, ""),
                  ])}
                  note="Unused resets lapse at expiry."
                />
              }
            />
          </span>
        )}
      </dd>
    </div>
  );
}

export function QuotaDials({
  quotas,
  timeZone,
  onUpdateWebCredits,
}: {
  quotas: DashboardData["quotas"];
  timeZone: string;
  onUpdateWebCredits?: () => void;
}) {
  const cards = quotaCards(quotas);
  const codexCard = cards.find((card) => card.provider === "codex");
  // The glance strip always shows; the full cards (reset clocks, reach history, credits) fold
  // behind one toggle. The choice is saved locally, so a reader who keeps them open is not
  // re-opening them on every visit.
  const [detailsOpen, setDetailsOpen] = useState(savedQuotaDetailsOpen);
  const quotaGridId = useId();
  const anthropicCredits = buildAnthropicCreditView(
    quotas.usage?.providers.find((provider) => provider.provider === "anthropic"),
  );
  const codexCredits = buildCodexCreditView(
    quotas.usage?.providers.find((provider) => provider.provider === "codex"),
  );
  const warpReport = quotas.usage?.providers.find(
    (provider) => provider.provider === "warp",
  );
  const trackingSince = quotas.history?.trackingSince
    ? new Date(quotas.history.trackingSince).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })
    : null;
  return (
    <section className="quota-panel panel">
      {/* One heading line: the title and the toggle for the full provider cards. */}
      <div className="quota-panel__heading">
        <h2>Subscription windows</h2>
        <button
          type="button"
          className="quota-details-toggle"
          aria-expanded={detailsOpen}
          aria-controls={quotaGridId}
          aria-label="Provider details: reset times, reach history, credits"
          title="Reset times, reach history, credits"
          onClick={() => {
            const next = !detailsOpen;
            setDetailsOpen(next);
            saveQuotaDetailsOpen(next);
          }}
        >
          {detailsOpen ? "Hide details" : "Details"}
          <ChevronRight aria-hidden="true" />
        </button>
      </div>
      {/* Every provider's current headroom in a line or two: a pie, a short window name and the
          time to its reset, with the full reading behind each info button. Providers and the
          banked-reset group flow inline and wrap as whole groups. */}
      <dl className="quota-glance">
        {cards.map((card) => (
          <div className={`quota-glance__provider ${card.provider}`} key={card.provider}>
            <dt>
              {card.providerLabel}
              {card.state === "stale" && (
                <small className="quota-glance__state">{card.stateLabel}</small>
              )}
            </dt>
            <dd>
              {card.buckets.map((bucket) => (
                <GlanceBucket card={card} bucket={bucket} trackingSince={trackingSince} key={bucket.id} />
              ))}
            </dd>
          </div>
        ))}
        {codexCard && codexCard.bankedResets.length > 0 && <GlanceResets card={codexCard} />}
      </dl>
      <div
        className={`quota-grid${detailsOpen ? "" : " is-collapsed"}`}
        id={quotaGridId}
      >
        {cards.map((card) => {
          const stateLabel = card.stateLabel;
          return (
            <article
              className={`quota-card ${card.provider} ${card.state}`}
              key={card.provider}
            >
              <div className="quota-card__head">
                <span>
                  {card.providerLabel}
                  {card.planLabel && (
                    <b className="quota-card__plan" title="Subscription tier reported by the provider">
                      {card.planLabel}
                    </b>
                  )}
                </span>
                <i>{stateLabel}</i>
              </div>
              <div className="quota-buckets">
                {card.buckets.map((bucket) => {
                  const left =
                    bucket.usedPercent === null
                      ? null
                      : Math.max(0, Math.min(100, 100 - bucket.usedPercent));
                  return (
                    <div
                      className={`quota-bucket ${bucket.state}`}
                      key={bucket.id}
                      aria-label={`${card.providerLabel} ${bucket.windowLabel}: ${left === null ? bucket.state : `${left.toFixed(0)}% left`}`}
                    >
                      <div
                        className="quota-dial"
                        style={
                          {
                            "--fill": `${left ?? 0}%`,
                          } as React.CSSProperties
                        }
                      >
                        <div>
                          <strong>
                            {left === null ? "—" : `${left.toFixed(0)}%`}
                          </strong>
                          <span>
                            {left === null ? dialStateLabel(bucket.state) : "left"}
                          </span>
                        </div>
                      </div>
                      <div className="quota-bucket__copy">
                        <div className="quota-bucket__top">
                          <b>{bucket.windowLabel}</b>
                          <span>
                            {left === null ? bucket.state : bucket.detail}
                          </span>
                        </div>
                        <small>
                          {bucket.state === "suspended"
                            ? "Rate limit temporarily suspended"
                            : resetCopy(bucket.resetAt, bucket.resetVerb)}
                        </small>
                        {bucket.historyWindow && (
                          <div className="quota-history">
                            <div className="quota-history__head">
                              <span>Recorded reaches</span>
                              <b>
                                {bucket.reachedCount === undefined
                                  ? "Not tracked"
                                  : `${bucket.reachedCount}× observed${trackingSince ? ` since ${trackingSince}` : ""}`}
                              </b>
                            </div>
                            {bucket.reachedAt && bucket.reachedAt.length > 0 && (
                              <ReachPattern
                                providerLabel={card.providerLabel}
                                windowLabel={bucket.windowLabel}
                                reachedAt={bucket.reachedAt}
                                reaches={bucket.reaches}
                                timeZone={timeZone}
                              />
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {card.notice && <QuotaNoticeCallout notice={card.notice} />}
              {card.provider === "warp" && <WarpQuotaDetails report={warpReport} />}
              {card.provider === "anthropic" && (
                <AnthropicCredits
                  view={anthropicCredits}
                  onUpdate={onUpdateWebCredits}
                />
              )}
              {card.provider === "codex" && <CodexCredits view={codexCredits} />}
              {card.provider === "codex" && (
                <div className="banked-resets">
                  <div className="reset-summary">
                    <div className="reset-summary__heading">
                      <span>Banked resets</span>
                      <b>{card.bankedResets.length} available</b>
                    </div>
                    {card.bankedResets.map((credit) => {
                      const expiry = expiryCopy(credit.expiresAt);
                      return (
                        <small
                          className={expiry.urgent ? "expiring-soon" : undefined}
                          key={credit.id}
                        >
                          <Sparkles /> {credit.title} · {expiry.text}
                        </small>
                      );
                    })}
                  </div>
                  {/* Used resets are history, not headroom: they stay folded so the card ends
                      on what is still available. */}
                  <details className="reset-summary reset-use">
                    <summary className="reset-summary__heading">
                      <span>
                        <ChevronRight aria-hidden="true" />
                        Resets used
                      </span>
                      <b>
                        {quotas.history?.available
                          ? `${card.usedResetCount} observed`
                          : "Not tracked"}
                      </b>
                    </summary>
                    {card.usedResets.map((reset) => (
                      <small key={reset.id}>
                        <Sparkles /> {reset.title}
                        <time dateTime={new Date(reset.usedAt).toISOString()}>
                          {new Date(reset.usedAt).toLocaleString(undefined, {
                            month: "short",
                            day: "numeric",
                            ...(new Date(reset.usedAt).getFullYear() !== new Date().getFullYear()
                              ? { year: "numeric" as const }
                              : {}),
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                        </time>
                      </small>
                    ))}
                  </details>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}


/** Turns a provider collection failure into a next step. `compact` drops the
 * raw producer message for the quick-overview modal. */
export function QuotaNoticeCallout({
  notice,
  compact = false,
}: {
  notice: QuotaNotice;
  compact?: boolean;
}) {
  return (
    <details
      className={`quota-notice ${notice.kind}${compact ? " compact" : ""}`}
    >
      <summary><span className="quota-notice__mark" aria-hidden="true">
        {notice.kind === "act" ? "!" : "…"}
      </span><b>{notice.kind === "act" ? "Reading needs attention" : "Reading may be out of date"}</b></summary>
      <div>
        <b>{notice.headline}</b>
        <span>{notice.nextStep}</span>
        {!compact && <small>Reported: {notice.raw}</small>}
      </div>
    </details>
  );
}
