import type { EffortIndexStatus, EffortSummary } from "../../types";
import { capEffortLevels } from "../../effort-model";

/** Compact UI says "Effort"; help text says "provider-recorded reasoning effort". Effort is an
 * observed categorical value — never a capability, quality score, model tier, or recommendation. */
export const EFFORT_HELP = "Provider-recorded reasoning effort, as written by the agent into its own transcript. It is not a quality score and is never inferred.";

const fixedColors: Record<string, string> = {
  low: "var(--aqua)",
  medium: "var(--accent)",
  high: "var(--orange)",
  xhigh: "var(--violet)",
};

const fallbackPalette = ["#7fb3a5", "#b39ddb", "#e6b86a", "#8fa9d9", "#cf8fb1", "#86c58a"];
const neutral = "var(--line-bright)";

function stablePaletteColor(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index++) hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  return fallbackPalette[hash % fallbackPalette.length];
}

/** Values the providers add later still get a stable, repeatable colour rather than a random one
 * or a silent drop. Colour is never the only label. */
export function effortColor(effort: string) {
  if (effort === "unknown" || effort === "other" || effort === "") return neutral;
  const fixed = fixedColors[effort];
  if (fixed) return fixed;
  return stablePaletteColor(effort);
}

export function effortLabel(effort: string | null) {
  if (!effort) return "Unknown";
  if (effort === "xhigh") return "X-high";
  if (effort === "other") return "Other";
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

const fixedFamilyColors: Record<string, string> = {
  "claude-fable-5": "var(--violet)",
  "claude-opus-5": "var(--orange)",
  "claude-sonnet-5": "var(--accent)",
  "claude-haiku-4-5": "var(--aqua)",
  "gpt-5.6-sol": "#8fa9d9",
};

/** Model families need their own colours: provider colours would make every Claude or Codex
 * family indistinguishable. Unknown future families still get a stable palette entry. */
export function familyColor(family: string) {
  if (!family || family === "unknown") return neutral;
  return fixedFamilyColors[family.toLowerCase()] ?? stablePaletteColor(`family:${family.toLowerCase()}`);
}

/** Compact family label for pills and legends, without discarding the release family. */
export function familyLabel(family: string) {
  if (!family || family === "unknown") return "Unknown model";
  const withoutProvider = family
    .replace(/^claude[-_ ]/i, "")
    .replace(/^gpt[-_ ]/i, "GPT ");
  const words = withoutProvider
    .replace(/[-_]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase() === "gpt"
      ? "GPT"
      : word.charAt(0).toUpperCase() + word.slice(1));
  return words.join(" ").replace(/(\d) (\d)(?=$| )/g, "$1.$2");
}

export function SplitPill({
  left,
  right,
  trailing,
}: {
  left: { label: string; color: string };
  right: { label: string; color: string };
  trailing?: string;
}) {
  return (
    <span className="split-pill">
      <span style={{ ["--split-pill-color" as string]: left.color }}>{left.label}</span>
      <span style={{ ["--split-pill-color" as string]: right.color }}>{right.label}</span>
      {trailing && <b>{trailing}</b>}
    </span>
  );
}

const percent = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);

/** A present-but-tiny slice must not read as "0%", which looks like nothing at all. */
export function sharePercent(amount: number, total: number) {
  if (total <= 0) return "—";
  const share = (amount / total) * 100;
  if (amount > 0 && share < 0.5) return "<1%";
  return `${Math.round(share)}%`;
}
const compact = (value: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);

/** A session with two or more observed values reads as Mixed; its underlying distribution stays
 * available in the tooltip and in expanded detail. */
export function EffortBadge({ summary }: { summary: EffortSummary | null }) {
  if (!summary || summary.coverageState === "unavailable") {
    return <span className="effort-badge effort-badge-unknown" title={EFFORT_HELP}>Unknown</span>;
  }
  const label = summary.mixed ? "Mixed" : effortLabel(summary.dominant);
  const detail = summary.mixed
    ? summary.levels.map((level) => effortLabel(level.effort)).join(" · ")
    : `${effortLabel(summary.dominant)} by ${summary.dominantBasis ?? "observations"}`;
  const color = effortColor(summary.dominant ?? "");
  return (
    <span
      className={`effort-badge${summary.mixed ? " effort-badge-mixed" : ""}`}
      style={summary.mixed ? undefined : { borderColor: color, color }}
      title={`${detail} · ${percent(summary.tokenCoverage)} of tokens attributed`}
    >
      {label}
    </span>
  );
}

/** Horizontal token-share bar. Unknown stays in the denominator so a partial index can never
 * look like a complete one. */
export function EffortStack({
  summary,
  basis = "tokens",
  height = 8,
  showLegend = true,
}: {
  summary: EffortSummary;
  basis?: "tokens" | "observations";
  height?: number;
  showLegend?: boolean;
}) {
  const capped = capEffortLevels(summary.levels);
  const unknownAmount = basis === "tokens" ? summary.unknownTokens ?? 0 : summary.unknownObservations;
  const amountOf = (level: { tokens: number; observations: number }) => (basis === "tokens" ? level.tokens : level.observations);
  const total = capped.reduce((sum, level) => sum + amountOf(level), 0) + unknownAmount;
  const segments = [
    ...capped.map((level) => ({ effort: level.effort, amount: amountOf(level) })),
    ...(unknownAmount > 0 ? [{ effort: "unknown", amount: unknownAmount }] : []),
  ].filter((segment) => segment.amount > 0);

  // An empty scope, or one whose reconciliation failed, must not render a plausible-looking
  // stack. A positive delta is exactly the case `foldEffort` refused to compute shares for.
  if (total <= 0 || summary.reconciliationDeltaTokens > 0) {
    return (
      <p className="effort-empty">
        {summary.reconciliationDeltaTokens > 0
          ? `Token shares are suppressed: derived tokens exceed the scope total by ${compact(summary.reconciliationDeltaTokens)}.`
          : "No attributable effort activity in this scope."}
      </p>
    );
  }

  const summaryText = segments.map((segment) => `${effortLabel(segment.effort)} ${percent(segment.amount / total)}`).join(", ");
  return (
    <div className="effort-stack-wrap">
      <div className="effort-stack" style={{ height }} role="img" aria-label={`Effort by ${basis}: ${summaryText}`}>
        {segments.map((segment) => (
          <i
            key={segment.effort}
            className="effort-stack-segment"
            style={{ width: `${(segment.amount / total) * 100}%`, background: effortColor(segment.effort) }}
            title={`${effortLabel(segment.effort)} · ${compact(segment.amount)} ${basis} · ${percent(segment.amount / total)}`}
          />
        ))}
      </div>
      {showLegend && (
        <ul className="effort-legend">
          {segments.map((segment) => (
            <li key={segment.effort}>
              <i style={{ background: effortColor(segment.effort) }} aria-hidden="true" />
              <span>{effortLabel(segment.effort)}</span>
              <b>{percent(segment.amount / total)}</b>
            </li>
          ))}
        </ul>
      )}
      <p className="effort-stack-summary">{summaryText}</p>
    </div>
  );
}

/** Token coverage is always displayed; observation coverage only when the source supplied a
 * supported observation boundary. */
export function EffortCoverage({ summary, indexing = false }: { summary: EffortSummary; indexing?: boolean }) {
  const parts = [`${percent(summary.tokenCoverage)} of tokens have a recorded effort`];
  if (summary.observationCoverage !== null) {
    parts.push(`${percent(summary.observationCoverage)} of ${compact(summary.observedObservations + summary.unknownObservations)} observations`);
  }
  return (
    <p className="effort-coverage">
      {parts.join(" · ")}
      {indexing ? " · indexing in progress, coverage describes parsed observations only" : ""}
    </p>
  );
}

const stateCopy: Record<string, string> = {
  disabled: "Enable transcript-derived effort indexing in Data.",
  error: "Effort indexing reported an error; the last derived result is unchanged.",
  unavailable: "No supported effort metadata was found in this scope.",
};

/** Renders the reason effort is not being shown, or `children` once there is something real to
 * draw. Indexing is not a blank state: partial results render alongside the progress line. */
export function EffortState({
  status,
  summary,
  children,
}: {
  status: EffortIndexStatus | null;
  summary?: EffortSummary | null;
  children?: React.ReactNode;
}) {
  if (!status) return <p className="effort-empty">Effort information is unavailable right now.</p>;
  if (!status.enabled) return <p className="effort-empty">{stateCopy.disabled}</p>;
  if (status.phase === "error") return <p className="effort-empty">{stateCopy.error}{status.error ? ` (${status.error})` : ""}</p>;
  if (!summary || summary.coverageState === "unavailable") {
    if (status.phase !== "indexing") return <p className="effort-empty">{stateCopy.unavailable}</p>;
  }
  const usable = summary && summary.coverageState !== "unavailable";
  if (status.phase === "indexing") {
    const progress = status.progress;
    const done = progress && progress.indexedBytes + progress.pendingBytes > 0
      ? Math.round((progress.indexedBytes / (progress.indexedBytes + progress.pendingBytes)) * 100)
      : null;
    // Partial results are shown during a backfill, always paired with progress so the coverage
    // figure is never read as corpus-wide.
    return (
      <>
        {usable ? children : null}
        <p className="effort-empty" aria-live="polite">
          Indexing transcripts{done === null ? "" : ` · ${done}% of known bytes`}
          {progress ? ` · ${progress.pendingSessions} sessions pending` : ""}
        </p>
      </>
    );
  }
  if (status.quality === "stale") {
    return (
      <>
        {children}
        <p className="effort-empty">Showing the last derived result; the index is stale.</p>
      </>
    );
  }
  return <>{children}</>;
}

export function EffortIndexSummary({ status }: { status: EffortIndexStatus }) {
  return (
    <dl className="effort-provenance">
      <div><dt>Status</dt><dd>{status.phase}</dd></div>
      <div><dt>Quality</dt><dd>{status.quality}</dd></div>
      <div><dt>Parser version</dt><dd>{status.parserVersion}</dd></div>
      <div><dt>Indexed at</dt><dd>{status.indexedAt ?? "never"}</dd></div>
      <div><dt>Sessions indexed</dt><dd>{status.progress ? status.progress.indexedSessions : "—"}</dd></div>
      <div><dt>Sessions pending</dt><dd>{status.progress ? status.progress.pendingSessions : "—"}</dd></div>
      <div><dt>Parse errors</dt><dd>{status.parseErrors}</dd></div>
      <div><dt>Context gaps</dt><dd>{status.contextGaps}</dd></div>
      <div><dt>Skipped bytes</dt><dd>{compact(status.skippedBytes)}</dd></div>
    </dl>
  );
}
