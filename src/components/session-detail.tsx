import { useCallback, useEffect, useLayoutEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ComboPill,
  EffortCoverage,
  EffortState,
  EFFORT_HELP,
  comboColor,
  effortLabel,
  sharePercent,
} from "./effort";
import { comboKey, comboLabel, compareComboKeys, type Combo, parseComboFacet } from "../combo";
import { providerFromAgent, providerFromModel, type ActivityProvider } from "../provider";
import { TokenTypeTable, TokenTypesNotice, cacheHiddenNotice, warpOnlyNotice } from "./token-types";
import { summarizeTokenTypes } from "../token-types";
import type { RateCardSummary } from "../types";
import { effortSummaryLabel, setSessionVerdict, type DecodedSessionEffort } from "../hooks/use-effort";
import {
  ChevronLeft,
  ChevronRight,
  Database,
  EllipsisVertical,
  ExternalLink,
  FileText,
  FolderOpen,
  RefreshCw,
} from "lucide-react";
import type {
  SessionAnnotation,
  SessionVerdict,
  EffortIndexStatus,
  Session,
  SessionDetail,
  SessionEffortCombo,
  SessionQuotaContext,
} from "../types";
import { sessionHref } from "../app/preferences";
import { formatPromptTimestamp, formatWarpCredits, formatCompact } from "../app/format";
import { sessionQuotaBalanceItems, quotaNumber, quotaRemainingRangeItems } from "../app/analytics";

type SessionDetailColumnKey =
  | "prompt"
  | "output"
  | "files"
  | "tools"
  | "models"
  | "effort"
  | "credits";

const initiallyCollapsedSessionColumns: SessionDetailColumnKey[] = [
  "tools",
  "models",
  "effort",
  "credits",
];

type SessionDetailSpineStat = {
  value: string;
  label?: string;
  tone?: "accent" | "positive" | "negative" | "warning";
};

type SessionExternalOpenAction = "reveal" | "vscode" | "default-editor";

type SessionExternalTarget =
  | { target: "transcript" }
  | { target: "file"; path: string };

type CompactActionMenuItem = {
  id: string;
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  hint?: string;
  onSelect: () => void | Promise<void>;
};

function CompactActionMenu({
  label,
  title,
  note,
  items,
  className = "",
}: {
  label: string;
  title: string;
  note: string;
  items: CompactActionMenuItem[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const placeMenu = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = 224;
    const height = menuRef.current?.offsetHeight ?? 154;
    const below = rect.bottom + 6;
    setPosition({
      left: Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width)),
      top:
        below + height <= window.innerHeight - 8
          ? below
          : Math.max(8, rect.top - height - 6),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(placeMenu);
    const close = () => setOpen(false);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open, placeMenu]);

  useEffect(() => {
    if (!open) return;
    const focusFrame = window.requestAnimationFrame(() => {
      placeMenu();
      menuRef.current
        ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus();
    });
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        menuRef.current?.contains(target)
      )
        return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, placeMenu]);

  const moveMenuFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
      return;
    const buttons = [
      ...(menuRef.current?.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      ) ?? []),
    ];
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : event.key === "ArrowUp"
            ? (current - 1 + buttons.length) % buttons.length
            : (current + 1) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <span className={`compact-action-menu ${className}`} data-open={open}>
      <button
        ref={triggerRef}
        type="button"
        className="compact-action-menu__trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        <EllipsisVertical aria-hidden="true" />
      </button>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            className="compact-action-popover"
            role="menu"
            aria-label={label}
            style={position}
            onKeyDown={moveMenuFocus}
          >
            <div className="compact-action-popover__head">
              <b>{title}</b>
              <small>{note}</small>
            </div>
            {items.map((item) => (
              <button
                type="button"
                role="menuitem"
                key={item.id}
                disabled={item.disabled}
                title={item.hint}
                onClick={() => {
                  setOpen(false);
                  window.requestAnimationFrame(() => triggerRef.current?.focus());
                  void item.onSelect();
                }}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </span>
  );
}

function SessionDetailSpineSummary({
  stats,
}: {
  stats: SessionDetailSpineStat[];
}) {
  return (
    <span className="session-detail__rail-summary" aria-hidden="true">
      {stats.map((stat, index) => (
        <span
          className={stat.tone ? `is-${stat.tone}` : undefined}
          key={`${stat.value}-${stat.label ?? index}`}
        >
          <b>{stat.value}</b>
          {stat.label && <i>{stat.label}</i>}
        </span>
      ))}
    </span>
  );
}

function SessionDetailColumn({
  column,
  label,
  aside,
  collapsedMeta,
  collapsedStats,
  collapsed,
  wide = false,
  className = "",
  title,
  onToggle,
  children,
}: {
  column: SessionDetailColumnKey;
  label: string;
  aside?: ReactNode;
  collapsedMeta?: string;
  collapsedStats?: SessionDetailSpineStat[];
  collapsed: boolean;
  wide?: boolean;
  className?: string;
  title?: string;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section
      className={`session-detail__section ${wide ? "session-detail__section--wide" : ""} ${collapsed ? "session-detail__section--collapsed" : ""} ${className}`}
      data-detail-column={column}
      data-state={collapsed ? "collapsed" : "expanded"}
    >
      {collapsed ? (
        <button
          type="button"
          className="session-detail__rail"
          onClick={onToggle}
          aria-expanded="false"
          aria-label={`Expand ${label}${collapsedMeta ? `, ${collapsedMeta}` : ""}`}
          title={`Expand ${label}`}
        >
          <ChevronRight aria-hidden="true" />
          <span className="session-detail__rail-label">{label}</span>
          {collapsedStats?.length ? (
            <SessionDetailSpineSummary stats={collapsedStats} />
          ) : (
            collapsedMeta && <small>{collapsedMeta}</small>
          )}
        </button>
      ) : (
        <>
          <div className="session-detail__head">
            <button
              type="button"
              className="session-detail__column-toggle"
              onClick={onToggle}
              aria-expanded="true"
              aria-label={`Collapse ${label}`}
              title={title ?? `Collapse ${label}`}
            >
              <ChevronLeft aria-hidden="true" />
              <span className="overline">{label}</span>
            </button>
            {aside && <div className="session-detail__head-aside">{aside}</div>}
          </div>
          <div className="session-detail__body">{children}</div>
        </>
      )}
    </section>
  );
}

function warpMetricLabel(value: string) {
  return value
    .replace(/_stats$/, "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function SessionTranscriptEntry({
  text,
  timestamp,
  label,
  truncated = false,
}: {
  text: string;
  timestamp: string | null;
  label: "Prompt" | "Output";
  truncated?: boolean;
}) {
  const [collapsible, setCollapsible] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const textRef = useRef<HTMLPreElement>(null);
  const contentId = `session-transcript-${useId()}`;

  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element) return;

    const measure = () => {
      const lineHeight = Number.parseFloat(window.getComputedStyle(element).lineHeight);
      const nextCollapsible = Number.isFinite(lineHeight) && lineHeight > 0
        ? element.scrollHeight > lineHeight * 1.25
        : text.split(/\r?\n/).length > 1;
      setCollapsible((current) => current === nextCollapsible ? current : nextCollapsible);
    };

    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  useEffect(() => {
    if (!collapsible) setExpanded(true);
  }, [collapsible]);

  const time = (
    <time
      className="session-prompt-time"
      dateTime={timestamp ?? undefined}
      title={timestamp ?? undefined}
    >
      {formatPromptTimestamp(timestamp)}
    </time>
  );

  return (
    <li className={collapsible ? "session-transcript-list__item--collapsible" : undefined}>
      {collapsible ? (
        <button
          type="button"
          className="session-transcript-toggle"
          aria-controls={contentId}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${label.toLowerCase()} from ${formatPromptTimestamp(timestamp)}`}
          title={`${expanded ? "Collapse" : "Expand"} ${label.toLowerCase()}`}
          onClick={() => setExpanded((current) => !current)}
        >
          {time}
          <ChevronRight aria-hidden="true" />
        </button>
      ) : (
        <div className="session-transcript-header">{time}</div>
      )}
      <div
        id={contentId}
        className="session-transcript-content"
        aria-hidden={collapsible ? !expanded : undefined}
      >
        <div className="session-transcript-content__inner">
          <pre ref={textRef}>{text}</pre>
          {truncated && (
            <small className="session-output-clipped">
              Sample clipped after 4,000 characters
            </small>
          )}
        </div>
      </div>
    </li>
  );
}

function quotaResourceLabel(id: string) {
  if (id === "fiveHour") return "5-hour window";
  if (id === "weekly") return "Weekly window";
  if (id === "monthly") return "Monthly pool";
  if (id.startsWith("model:")) return `${id.slice(6)} model window`;
  return id;
}

function quotaResourceCompactLabel(id: string) {
  if (id === "fiveHour") return "5h window";
  if (id === "weekly") return "w window";
  if (id === "monthly") return "m pool";
  if (id.startsWith("model:")) return `${id.slice(6)} window`;
  return id;
}

export function SessionQuotaBalanceCell({
  context,
  loading,
  provider,
}: {
  context: SessionQuotaContext | null | undefined;
  loading: boolean;
  provider: ActivityProvider | null;
}) {
  const balances = sessionQuotaBalanceItems(context);
  const providerClass = provider ?? "unknown";
  if (loading) return <span className={`session-quota-balance ${providerClass} is-loading`} aria-label="Loading remaining quota">•••</span>;
  if (!balances.length) {
    return (
      <span
        className={`session-quota-balance ${providerClass} is-empty`}
        title={context?.reason ?? "No account quota reading is available near this session's end."}
      >
        —
      </span>
    );
  }
  return (
    <span
      className={`session-quota-balance ${providerClass}`}
      title={`${context!.basis === "embedded_account_observation"
        ? "Account quota remaining at the last embedded reading during this session's activity."
        : "Account quota remaining at the first reading after this session's last activity."} The account is shared: other sessions, devices, and surfaces move the same counter.`}
    >
      {balances.map((balance) => (
        <span
          key={balance.id}
          className={`${balance.remainingUnits !== null ? "is-pool" : ""} ${balance.stale ? "is-low" : ""} ${balance.remainingPercent === null && balance.remainingUnits === null ? "is-unavailable" : ""}`.trim() || undefined}
          title={balance.remainingPercent === null && balance.remainingUnits === null
            ? balance.reason ?? `No closing ${balance.label} reading is available.`
            : undefined}
        >
          {balance.remainingPercent === null && balance.remainingUnits === null ? (
            <>
              <b>--</b>
              <i>{balance.label}</i>
            </>
          ) : balance.remainingUnits !== null ? (
            <>
              <b
                className="session-quota-balance__credits"
                aria-label={`${formatWarpCredits(balance.remainingUnits)} credits`}
              >
                <span aria-hidden="true">{formatWarpCredits(balance.remainingUnits)}</span>
                <span aria-hidden="true">credits</span>
              </b>
              <i>remaining</i>
            </>
          ) : (
            <>
              <b>{quotaNumber(balance.remainingPercent ?? 0)}%</b>
              <i>{balance.label}</i>
            </>
          )}
        </span>
      ))}
    </span>
  );
}

function quotaImpactSummary(context: SessionQuotaContext | null | undefined) {
  if (!context) return [];
  return context.resources.flatMap((resource) => quotaRemainingRangeItems(resource).map((range) => ({
    label: quotaResourceCompactLabel(resource.id),
    range: range.text,
  })));
}

function shortSessionId(sessionId: string) {
  return sessionId.length > 22 ? `${sessionId.slice(0, 9)}…${sessionId.slice(-8)}` : sessionId;
}

function overlapDurationLabel(overlapMs: number) {
  const minutes = Math.round(overlapMs / 60_000);
  return minutes < 1 ? "<1m overlap" : `${minutes}m overlap`;
}

export function SessionQuotaContextPanel({ context, sessionId }: { context: SessionQuotaContext; sessionId?: string }) {
  const providerLabel = context.provider === "anthropic" ? "Claude" : context.provider === "codex" ? "Codex" : "Warp";
  const sameProvider = context.concurrency.distinctOtherSameProviderSessions;
  const evidence = context.basis === "embedded_account_observation" ? "Embedded snapshots" : "Bracketed snapshots";
  const balances = sessionQuotaBalanceItems(context);
  const availableBalances = balances.filter((balance) => balance.remainingPercent !== null || balance.remainingUnits !== null);
  const titleId = `session-quota-context-title-${useId()}`;
  const concurrentSessions = context.concurrency.sessions ?? [];
  const observedChanges = context.resources.flatMap((resource) => quotaRemainingRangeItems(resource).map((range) => ({
    label: quotaResourceLabel(resource.id),
    magnitudeValue: range.magnitudeValue,
    unit: range.unit,
  })));
  return (
    <section className={`session-quota-context session-quota-context--impact is-${context.confidence}`} aria-labelledby={titleId}>
      <header>
        <div>
          <span className="overline">Quota impact</span>
          <h4 id={titleId}>Observed account movement while this session ran</h4>
        </div>
        <span className="session-quota-context__confidence">{context.confidence} confidence</span>
      </header>
      {context.resources.length > 0 ? (
        <div className="session-quota-context__resources">
          {context.resources.map((resource) => {
            const ranges = quotaRemainingRangeItems(resource);
            const blanked = resource.deltaPercentagePoints === null && resource.deltaUnits === null;
            const movement = resource.confidence === "insufficient"
              ? "Unresolved"
              : blanked || !ranges.length
                ? "Movement unavailable"
                : "";
            return (
              <div key={resource.id} className={`is-${resource.confidence}`}>
                <span>{quotaResourceLabel(resource.id)}</span>
                <strong className="session-quota-context__movement" title={resource.confidence === "insufficient" || blanked ? undefined : "Remaining account quota while this session was active, oldest cycle first. A jump back up is a window reset; nothing is summed across resets."}>
                  {ranges.length > 0 && resource.confidence !== "insufficient" && !blanked ? ranges.map((range) => (
                    <span className="session-quota-context__range" key={`${resource.id}-${range.text}`}>
                      <span className="session-quota-context__readout">
                        <b>{range.value}</b>
                        <i>{range.unit}</i>
                        <em>remaining</em>
                      </span>
                      <span className="session-quota-context__change">
                        <b>{range.magnitudeValue}{range.unit === "%" ? "%" : ""}</b>
                        {range.unit !== "%" && <i>{range.unit}</i>}
                        <small>observed account change</small>
                      </span>
                    </span>
                  )) : movement}
                </strong>
                <small>
                  {resource.confidence === "insufficient"
                    ? resource.reason
                    : `${resource.cycleCount} resolved ${resource.cycleCount === 1 ? "cycle" : "cycles"}${resource.episodes.length > resource.cycleCount ? ` · ${resource.episodes.length} active episodes` : ""} · ${resource.confidence} confidence`}
                  {resource.limitChanged ? " · pool limit changed" : ""}
                </small>
                {resource.confidence !== "insufficient" && (resource.reason ?? (blanked ? context.reason : null)) ? (
                  <small className="session-quota-context__caveat">{resource.reason ?? context.reason}</small>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="session-quota-context__empty">{context.reason ?? "The available observations cannot resolve account movement for this session."}</p>
      )}
      {availableBalances.length > 0 && (
        <p className="session-quota-context__balance">
          Closing reading: {availableBalances.map((balance) => balance.remainingUnits !== null
            ? `${formatWarpCredits(balance.remainingUnits)} credits`
            : `${quotaNumber(balance.remainingPercent ?? 0)}% (${balance.label})`).join(" · ")} remaining.
        </p>
      )}
      <div className="session-quota-context__evidence">
        <span>
          {evidence} · {context.confidence} confidence
          {context.coverage.observationCadenceMs === null
            ? ""
            : ` · ${Math.round(context.coverage.observationCadenceMs / 1000)}s snapshot cadence`}
        </span>
        <span>
          {sameProvider > 0
            ? `Up to ${context.concurrency.maxOtherSameProviderSessions} other local ${providerLabel} ${context.concurrency.maxOtherSameProviderSessions === 1 ? "session" : "sessions"} overlapped`
            : `No other local ${providerLabel} session overlap detected`}
        </span>
      </div>
      <div className="session-quota-context__attribution">
        <p>
          <b>Observed account movement.</b>{" "}
          {observedChanges.length
            ? <>
                {observedChanges.map((change, index) => (
                  <span key={`${change.label}-${change.magnitudeValue}-${change.unit}`}>
                    {index > 0 ? " · " : ""}{change.label}: {change.magnitudeValue}{change.unit === "%" ? "%" : ` ${change.unit}`}
                  </span>
                ))}.
              </>
            : "No measurable movement was resolved."}{" "}
          These are changes in the shared provider counter, not amounts assigned to one session.
        </p>
        <p>
          {sessionId ? (
            <>Focused session <a href={sessionHref(sessionId)} title={sessionId}>{shortSessionId(sessionId)}</a> observed this movement.</>
          ) : "This focused session observed this movement."}{" "}
          {concurrentSessions.length ? (
            <>Possible concurrent observers: {concurrentSessions.map((other, index) => (
              <span key={other.sessionId}>
                {index > 0 ? ", " : " "}
                <a href={sessionHref(other.sessionId)} title={`${other.sessionId} · ${sessionProviderLabels[other.provider]}`}>
                  {shortSessionId(other.sessionId)}
                </a>{" "}<small>({sessionProviderLabels[other.provider]}, {overlapDurationLabel(other.overlapMs)})</small>
              </span>
            ))}. No causal split is available, so do not add the same account movement across these sessions.
          </>) : "No local session overlap was recorded. Web, mobile, cloud, another machine, and other local processes remain unknown."}
        </p>
      </div>
      <details>
        <summary>How to read this</summary>
        <p>
          These are account or seat-level observations, not charges assigned to this thread. Provider web, mobile, cloud,
          another machine, or another local process may have contributed. Local concurrency is incomplete and external
          activity is unknown; overlapping sessions observe the same shared counter, so values are never additive.
          Ranges show remaining quota, oldest cycle first: 25→0%, 100→75% means the account counter fell from 25% to 0%
          remaining, the window reset, then fell from 100% to 75% while this session was active. Nothing is summed
          across resets. {context.basis === "embedded_account_observation"
            ? "The closing balance uses the last embedded account reading during this session's activity."
            : "The closing balance uses the first account snapshot after this session's last activity."}
        </p>
        {context.concurrency.distinctOtherProviderSessions > 0 && (
          <p>{context.concurrency.distinctOtherProviderSessions} local session on another provider also overlapped.</p>
        )}
      </details>
    </section>
  );
}

export function SessionDetailPanel({
  session,
  detail,
  loading,
  loadError = null,
  onRetry,
  effortStatus,
  rateCard = null,
  unpricedModels = [],
  showCache = true,
  annotation,
  onAnnotationChange,
}: {
  session: Session;
  detail?: SessionDetail;
  loading: boolean;
  loadError?: string | null;
  onRetry?: () => void;
  effortStatus: EffortIndexStatus | null;
  rateCard?: RateCardSummary | null;
  unpricedModels?: string[];
  showCache?: boolean;
  annotation?: SessionAnnotation;
  onAnnotationChange?: (sessionId: string, annotation: SessionAnnotation) => void;
}) {
  const [promptOrder, setPromptOrder] = useState<"newest" | "oldest">(
    "oldest",
  );
  const [collapsedColumns, setCollapsedColumns] = useState(
    () => new Set<SessionDetailColumnKey>(initiallyCollapsedSessionColumns),
  );
  const [externalStatus, setExternalStatus] = useState<{
    kind: "pending" | "success" | "error";
    message: string;
  } | null>(null);
  const externalStatusTimer = useRef<number | null>(null);
  const showExternalStatus = useCallback(
    (
      kind: "pending" | "success" | "error",
      message: string,
      duration = kind === "error" ? 5_000 : 2_600,
    ) => {
      if (externalStatusTimer.current !== null)
        window.clearTimeout(externalStatusTimer.current);
      setExternalStatus({ kind, message });
      externalStatusTimer.current =
        kind === "pending"
          ? null
          : window.setTimeout(() => setExternalStatus(null), duration);
    },
    [],
  );
  useEffect(
    () => () => {
      if (externalStatusTimer.current !== null)
        window.clearTimeout(externalStatusTimer.current);
    },
    [],
  );
  const openExternalTarget = useCallback(
    async (
      action: SessionExternalOpenAction,
      target: SessionExternalTarget,
      label: string,
    ) => {
      const actionLabel =
        action === "reveal"
          ? "Opening Finder"
          : action === "vscode"
            ? "Opening Visual Studio Code"
            : "Opening the default text editor";
      showExternalStatus("pending", `${actionLabel} for ${label}…`);
      try {
        const response = await fetch(
          `/api/sessions/${encodeURIComponent(session.sessionId)}/external-open`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action, ...target }),
          },
        );
        const result = (await response.json().catch(() => null)) as {
          error?: unknown;
          message?: unknown;
        } | null;
        if (!response.ok)
          throw new Error(
            typeof result?.error === "string"
              ? result.error
              : "The local application could not open that path.",
          );
        showExternalStatus(
          "success",
          typeof result?.message === "string"
            ? result.message
            : `${label} opened.`,
        );
      } catch (error) {
        showExternalStatus(
          "error",
          error instanceof Error
            ? error.message
            : "The local application could not open that path.",
        );
      }
    },
    [session.sessionId, showExternalStatus],
  );
  const toggleColumn = (column: SessionDetailColumnKey) => {
    setCollapsedColumns((current) => {
      const next = new Set(current);
      if (next.has(column)) next.delete(column);
      else next.add(column);
      return next;
    });
  };
  // Warp reaches the same panel through the same columns. What differs is where a
  // column's numbers come from, and that Warp records no file paths and no
  // transcript file to open — never the shape of the panel.
  const warp = session.source === "warp" ? (session.warp ?? null) : null;
  if (loading)
    return (
      <div className="session-detail session-detail--loading">
        Reading the local session record…
      </div>
    );
  if (loadError)
    return (
      <div className="session-detail session-detail--empty session-detail--error" role="alert">
        <span>{loadError}</span>
        {onRetry && (
          <button type="button" className="secondary-button" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    );
  if (!warp && !detail?.available)
    return (
      <div className="session-detail session-detail--empty">
        The indexed record is no longer available locally.
      </div>
    );
  const models = session.modelBreakdowns.length
    ? session.modelBreakdowns.map((model) => ({
        modelName: model.modelName,
        tokens:
          model.inputTokens +
          model.outputTokens +
          model.cacheReadTokens +
          model.cacheCreationTokens,
      }))
    : session.modelsUsed.map((modelName) => ({ modelName, tokens: null }));
  const prompts =
    promptOrder === "newest" ? [...(detail?.prompts ?? [])].reverse() : (detail?.prompts ?? []);
  const outputs = detail?.outputs ?? [];
  const clippedOutputs = outputs.filter((output) => output.truncated).length;
  // Warp reports the same facts as a transcript, just already tallied: it counts tool
  // calls and changed files itself rather than leaving them to be derived from events.
  const tools = warp
    ? Object.entries(warp.toolUsage)
        .filter(([, count]) => count > 0)
        .map(([name, count]) => ({ name: warpMetricLabel(name), count }))
        .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
    : (detail?.tools ?? []);
  const files = detail?.files ?? [];
  const fileCount = warp ? warp.filesChanged : files.length;
  const additions = warp ? warp.linesAdded : (detail?.additions ?? 0);
  const deletions = warp ? warp.linesRemoved : (detail?.deletions ?? 0);
  const eventsRead = warp ? (detail?.eventsRead || warp.turns) : (detail?.eventsRead ?? 0);
  const toolCalls = tools.reduce((total, tool) => total + tool.count, 0);
  const externalItems = (
    target: SessionExternalTarget,
    label: string,
    deleted = false,
  ): CompactActionMenuItem[] => [
    {
      id: "reveal",
      label: deleted ? "Reveal containing folder" : "Reveal in Finder",
      icon: <FolderOpen aria-hidden="true" />,
      onSelect: () => openExternalTarget("reveal", target, label),
    },
    {
      id: "vscode",
      label: "Open in VS Code",
      icon: <ExternalLink aria-hidden="true" />,
      disabled: deleted,
      hint: deleted ? "This session deleted the file." : undefined,
      onSelect: () => openExternalTarget("vscode", target, label),
    },
    {
      id: "default-editor",
      label: "Open in default text editor",
      icon: <FileText aria-hidden="true" />,
      disabled: deleted,
      hint: deleted ? "This session deleted the file." : undefined,
      onSelect: () => openExternalTarget("default-editor", target, label),
    },
  ];
  const quotaSummary = quotaImpactSummary(detail?.quotaContext);
  return (
    <div className={`session-detail${warp ? " session-detail--warp" : ""}`}>
      <div className={`session-detail__summary${quotaSummary.length > 0 ? " session-detail__summary--with-quota" : ""}`}>
        <div className="session-detail__verdict">
          <span>YOUR VERDICT</span>
          <strong>
            <SessionVerdictControl
              sessionId={session.sessionId}
              verdict={(annotation ?? session.annotation).verdict}
              onChange={onAnnotationChange ?? (() => {})}
            />
          </strong>
        </div>
        <div>
          <span>{warp ? "RECORDED EVENTS" : "TRANSCRIPT EVENTS"}</span>
          <strong>{eventsRead}</strong>
        </div>
        <div>
          <span>TOOL CALLS</span>
          <strong>{toolCalls}</strong>
        </div>
        <div>
          <span>FILES TOUCHED</span>
          <strong>{fileCount}</strong>
        </div>
        <div className="diff-count">
          <span>PATCH SUMMARY</span>
          <strong>
            <i>+{additions}</i>
            <em>−{deletions}</em>
          </strong>
        </div>
        {quotaSummary.length > 0 && (
          <div
            className="session-detail__quota-meta"
            title="Observed movement in the shared provider quota counter. It is not a charge assigned to this session."
          >
            <span>QUOTA IMPACT</span>
            <strong className="session-detail__quota-values">
              {quotaSummary.map((item) => (
                <span className="session-detail__quota-item" key={`${item.range}-${item.label}`}>
                  <b>{item.range}</b>
                  <small>{item.label}</small>
                </span>
              ))}
            </strong>
          </div>
        )}
        {warp && (
          <>
            <div><span>WARP CREDITS</span><strong>{formatWarpCredits(warp.credits)}</strong></div>
            <div>
              <span>CONTEXT WINDOW</span>
              <strong>{warp.contextWindowUsage === null ? "—" : `${Math.round(warp.contextWindowUsage * 100)}%`}</strong>
            </div>
          </>
        )}
      </div>
      <div className="session-detail__columns">
        <SessionDetailColumn
          column="prompt"
          label="Prompt"
          collapsed={collapsedColumns.has("prompt")}
          collapsedMeta={`${prompts.length} prompt${prompts.length === 1 ? "" : "s"}`}
          collapsedStats={[
            {
              value: formatCompact(prompts.length),
              label: "prompts",
            },
          ]}
          wide
          className="session-prompts"
          onToggle={() => toggleColumn("prompt")}
          aside={
            <div className="session-detail__head-actions">
              {prompts.length ? (
                <button
                  type="button"
                  className="prompt-order"
                  onClick={() =>
                    setPromptOrder((current) =>
                      current === "newest" ? "oldest" : "newest",
                    )
                  }
                  aria-label={`Show prompts ${promptOrder === "newest" ? "oldest" : "newest"} first`}
                >
                  {promptOrder === "newest" ? "Newest first ↓" : "Oldest first ↑"}
                </button>
              ) : (
                <small>No prompt events detected</small>
              )}
              {!warp && (
                <CompactActionMenu
                  label="Open Prompt source actions"
                  title="Prompt source"
                  note="Shared session JSONL"
                  items={externalItems(
                    { target: "transcript" },
                    "the session transcript",
                  )}
                />
              )}
            </div>
          }
        >
          {prompts.length ? (
            <ol className="session-transcript-list">
              {prompts.map((prompt, index) => (
                <SessionTranscriptEntry
                  key={`${index}-${prompt.text.slice(0, 24)}`}
                  text={prompt.text}
                  timestamp={prompt.timestamp}
                  label="Prompt"
                />
              ))}
            </ol>
          ) : (
            <p>
              {warp
                ? "This conversation recorded no typed prompt of its own."
                : "Prompt text was not available in this session format."}
            </p>
          )}
        </SessionDetailColumn>
        <SessionDetailColumn
          column="output"
          label="Output"
          collapsed={collapsedColumns.has("output")}
          collapsedMeta={`${outputs.length} sample${outputs.length === 1 ? "" : "s"}`}
          collapsedStats={[
            { value: formatCompact(outputs.length), label: "samples" },
            ...(clippedOutputs
              ? [
                  {
                    value: formatCompact(clippedOutputs),
                    label: "clipped",
                    tone: "warning" as const,
                  },
                ]
              : []),
          ]}
          wide
          className="session-outputs"
          onToggle={() => toggleColumn("output")}
          aside={
            <div className="session-detail__head-actions">
              <small>
                {outputs.length
                  ? `${outputs.length} recent sample${outputs.length === 1 ? "" : "s"}${outputs.some((output) => output.truncated) ? " · clipped" : ""}`
                  : "No assistant text detected"}
              </small>
              {!warp && (
                <CompactActionMenu
                  label="Open Output source actions"
                  title="Output source"
                  note="Shared session JSONL"
                  items={externalItems(
                    { target: "transcript" },
                    "the session transcript",
                  )}
                />
              )}
            </div>
          }
        >
          {outputs.length ? (
            <ol className="session-transcript-list">
              {outputs.map((output, index) => (
                <SessionTranscriptEntry
                  key={`${index}-${output.text.slice(0, 24)}`}
                  text={output.text}
                  timestamp={output.timestamp}
                  label="Output"
                  truncated={output.truncated}
                />
              ))}
            </ol>
          ) : (
            <p>
              {warp
                ? "Warp kept no local copy of this conversation's replies."
                : "Assistant-visible output text was not available in this session format."}
            </p>
          )}
        </SessionDetailColumn>
        <SessionDetailColumn
          column="files"
          label="Files & Patches"
          collapsed={collapsedColumns.has("files")}
          collapsedMeta={`${fileCount} file${fileCount === 1 ? "" : "s"}, ${additions} additions, ${deletions} deletions`}
          collapsedStats={[
            { value: formatCompact(fileCount), label: "files" },
            { value: `+${formatCompact(additions)}`, tone: "positive" },
            { value: `−${formatCompact(deletions)}`, tone: "negative" },
          ]}
          onToggle={() => toggleColumn("files")}
          aside={
            <small>
              {fileCount
                ? `${fileCount} files · +${additions} −${deletions}`
                : "No patch payload found"}
            </small>
          }
        >
          {files.length ? (
            <ul className="file-list">
              {files.map((file) => (
                <li key={file.path}>
                  <span className={`file-status ${file.status}`}>
                    {file.status[0]}
                  </span>
                  <code className="file-path-tail" title={file.path}>
                    <span dir="ltr">{file.path}</span>
                  </code>
                  <span
                    className={`file-diff ${file.additions === null || file.deletions === null ? "is-unavailable" : ""}`}
                    aria-label={
                      file.additions === null || file.deletions === null
                        ? "Line counts unavailable for this file"
                        : `${file.additions} ${file.additions === 1 ? "addition" : "additions"} and ${file.deletions} ${file.deletions === 1 ? "deletion" : "deletions"}`
                    }
                    title={
                      file.additions === null || file.deletions === null
                        ? "Line counts unavailable for this transcript record"
                        : undefined
                    }
                  >
                    <i>+{file.additions?.toLocaleString() ?? "—"}</i>
                    <em>−{file.deletions?.toLocaleString() ?? "—"}</em>
                  </span>
                  <CompactActionMenu
                    className="file-action-menu"
                    label={`Open actions for ${file.path}`}
                    title={file.path.split(/[\\/]/).at(-1) ?? file.path}
                    note={file.status === "deleted" ? "Deleted path" : "Local file"}
                    items={externalItems(
                      { target: "file", path: file.path },
                      file.path.split(/[\\/]/).at(-1) ?? "the file",
                      file.status === "deleted",
                    )}
                  />
                </li>
              ))}
            </ul>
          ) : warp ? (
            // Warp tallies its own edits but keeps no list of the paths, so the counts
            // are shown without pretending a file list exists.
            <ul className="model-list">
              <li><span>Files changed</span><b>{warp.filesChanged}</b></li>
              <li><span>Lines added</span><b>+{warp.linesAdded}</b></li>
              <li><span>Lines removed</span><b>−{warp.linesRemoved}</b></li>
              <li><span>Commands executed</span><b>{warp.commandsExecuted}</b></li>
              <li><span>Failed commands</span><b>{warp.failedCommands}</b></li>
              <li><span>Compaction observed</span><b>{warp.wasSummarized ? "Yes" : "No"}</b></li>
            </ul>
          ) : (
            <p>File changes are detected from structured patch calls only.</p>
          )}
        </SessionDetailColumn>
        <SessionDetailColumn
          column="tools"
          label="Tools"
          collapsed={collapsedColumns.has("tools")}
          collapsedMeta={`${toolCalls} call${toolCalls === 1 ? "" : "s"} across ${tools.length} tool type${tools.length === 1 ? "" : "s"}`}
          collapsedStats={[
            { value: formatCompact(toolCalls), label: "calls" },
            { value: formatCompact(tools.length), label: "types" },
          ]}
          onToggle={() => toggleColumn("tools")}
          aside={
            <small>
              {tools.length
                ? "Observed calls"
                : "No tool calls detected"}
            </small>
          }
        >
          {tools.length ? (
            <ul className="tool-list">
              {tools.map((tool) => (
                <li key={tool.name}>
                  <code>{tool.name}</code>
                  <b>×{tool.count}</b>
                </li>
              ))}
            </ul>
          ) : (
            <p>No structured tool calls were found.</p>
          )}
        </SessionDetailColumn>
        <SessionModelEffortSection
          models={models}
          detail={detail}
          agent={session.agent}
          status={effortStatus}
          collapsed={collapsedColumns.has("models")}
          onToggle={() => toggleColumn("models")}
        />
        {warp && (
          <SessionDetailColumn
            column="credits"
            label="Credits"
            collapsed={collapsedColumns.has("credits")}
            collapsedMeta={`${formatWarpCredits(warp.credits)} credits, ${formatCompact(warp.tokensBySource.total)} recorded tokens`}
            collapsedStats={[
              { value: formatWarpCredits(warp.credits), label: "credits" },
              { value: formatCompact(warp.tokensBySource.total), label: "tokens" },
            ]}
            onToggle={() => toggleColumn("credits")}
            aside={<small>{warp.status}</small>}
          >
            <ul className="model-list">
              <li><span>Credits spent</span><b>{formatWarpCredits(warp.credits)}</b></li>
              <li>
                <span>Last turn</span>
                <b>{warp.lastTurnCredits === null ? "—" : formatWarpCredits(warp.lastTurnCredits)}</b>
              </li>
              <li><span>Agent turns</span><b>{warp.turns}</b></li>
              <li><span>Warp-managed tokens</span><b>{formatCompact(warp.tokensBySource.warp)}</b></li>
              <li><span>BYOK tokens</span><b>{formatCompact(warp.tokensBySource.byok)}</b></li>
              <li><span>Custom endpoint</span><b>{formatCompact(warp.tokensBySource.customEndpoint)}</b></li>
              {Object.entries(warp.tokensByCategory)
                .sort((left, right) => right[1] - left[1])
                .map(([name, value]) => (
                  <li key={name}><span>{warpMetricLabel(name)}</span><b>{formatCompact(value)}</b></li>
                ))}
            </ul>
          </SessionDetailColumn>
        )}
      </div>
      <div className={`session-detail__metrics-row${detail?.quotaContext ? " session-detail__metrics-row--with-quota" : ""}`}>
        {!showCache ? (
          <TokenTypesNotice>{cacheHiddenNotice}</TokenTypesNotice>
        ) : warp ? (
          <TokenTypesNotice>{warpOnlyNotice}</TokenTypesNotice>
        ) : (
          <TokenTypeTable
            summary={summarizeTokenTypes(
              session.modelBreakdowns.map((breakdown) => ({ agent: session.agent, breakdown })),
              rateCard,
              unpricedModels,
            )}
            context={{
              reasoning: detail?.effort?.reasoning ?? null,
              effortIndexEnabled: effortStatus?.enabled,
              rateCard,
            }}
          />
        )}
        {detail?.quotaContext && (
          <SessionQuotaContextPanel
            context={detail.quotaContext}
            sessionId={session.sessionId}
          />
        )}
      </div>
      {warp && (
        <p className="scope-note">
          <Database /> Read from Warp's local database on this computer: prompts from its
          query log, replies from its stored agent runs. Reasoning summaries are counted
          but not imported, and raw command output is left out.
        </p>
      )}
      {externalStatus && (
        <div
          className={`session-external-status is-${externalStatus.kind}`}
          role="status"
          aria-live="polite"
        >
          {externalStatus.kind === "pending" ? (
            <RefreshCw aria-hidden="true" />
          ) : (
            <ExternalLink aria-hidden="true" />
          )}
          <span>{externalStatus.message}</span>
        </div>
      )}
    </div>
  );
}

export const sessionProviderLabels: Record<ActivityProvider, string> = {
  anthropic: "Anthropic",
  codex: "OpenAI",
  warp: "Warp",
};

export const sessionProviderColors: Record<ActivityProvider, string> = {
  anthropic: "var(--anthropic-color)",
  codex: "var(--openai-color)",
  warp: "var(--warp-color)",
};

export type SessionMixCombo = Combo & { tokens: number; observations: number };

export type SessionMixGroup = {
  provider: ActivityProvider | "unknown";
  label: string;
  color: string;
  /** Null when the usage records carried no token total for one of this provider's models. */
  tokens: number | null;
  combos: SessionMixCombo[];
  attributed: number;
  /** Provider tokens no model × effort row accounts for. Coverage, not a combo of its own. */
  unattributed: number;
};


/** One session's spend as provider totals with model × effort subtotals. A provider total is the
 * decision-sized number; `High` alone is not a unit, so every subtotal names the model that
 * recorded it.
 *
 * The two levels come from different places and are never summed: a provider total is the
 * session's own usage record, while the combos under it are read from the transcript. Whatever
 * the combos do not account for stays visible as `unattributed` rather than being dropped or
 * folded into the smallest combo. */
export function sessionProviderMix(
  models: Array<{ modelName: string; tokens: number | null }>,
  combos: SessionEffortCombo[],
  fallbackProvider: ActivityProvider | null,
) {
  const groups = new Map<string, SessionMixGroup>();
  const groupFor = (model: string) => {
    const provider = providerFromModel(model) ?? fallbackProvider ?? "unknown";
    const existing = groups.get(provider);
    if (existing) return existing;
    const created: SessionMixGroup = {
      provider,
      label: provider === "unknown" ? "Unknown provider" : sessionProviderLabels[provider],
      color: provider === "unknown" ? "var(--line-bright)" : sessionProviderColors[provider],
      tokens: null,
      combos: [],
      attributed: 0,
      unattributed: 0,
    };
    groups.set(provider, created);
    return created;
  };

  // A model with no recorded token total leaves its provider total null: a partial sum presented
  // as a total would understate the provider without saying so.
  const incomplete = new Set<string>();
  for (const model of models) {
    const group = groupFor(model.modelName);
    if (model.tokens === null) incomplete.add(group.provider);
    else group.tokens = (group.tokens ?? 0) + model.tokens;
  }
  for (const combo of combos) {
    // The raw name is tried first; a family carries the vendor only when the transcript recorded
    // a name this app cannot read a provider from.
    const group = groupFor(providerFromModel(combo.model) ? combo.model : combo.family);
    const key = comboKey(combo);
    const existing = group.combos.find((entry) => comboKey(entry) === key);
    if (existing) {
      existing.tokens += combo.tokens;
      existing.observations += combo.observations;
    } else {
      group.combos.push({
        family: combo.family,
        effort: combo.effort,
        tokens: combo.tokens,
        observations: combo.observations,
      });
    }
    group.attributed += combo.tokens;
  }

  const ordered = [...groups.values()].map((group) => ({
    ...group,
    tokens: incomplete.has(group.provider) ? null : group.tokens,
    combos: group.combos.sort((left, right) =>
      right.tokens - left.tokens || compareComboKeys(comboKey(left), comboKey(right))),
    unattributed: incomplete.has(group.provider) || group.tokens === null
      ? 0
      : Math.max(0, group.tokens - group.attributed),
  }));
  ordered.sort((left, right) =>
    (right.tokens ?? right.attributed) - (left.tokens ?? left.attributed)
    || left.label.localeCompare(right.label));

  return {
    groups: ordered,
    comboCount: ordered.reduce((count, group) => count + group.combos.length, 0),
    /** Session total on the usage-record basis, so it matches the provider totals above it. */
    tokens: ordered.reduce<number | null>(
      (sum, group) => (sum === null || group.tokens === null ? null : sum + group.tokens),
      ordered.length ? 0 : null,
    ),
  };
}


/** One provider's total, the combos that made it up, and whatever the combos leave unaccounted
 * for. Colour is never the only label: each combo names its model and effort as text. */
export function SessionMixGroupBreakdown({
  label,
  title,
  color,
  tokens,
  combos,
  unattributed = 0,
}: {
  label: string;
  title?: string;
  color?: string;
  tokens: number | null;
  combos: SessionMixCombo[];
  unattributed?: number;
}) {
  const attributed = combos.reduce((sum, combo) => sum + combo.tokens, 0);
  const basis = attributed + unattributed;
  const shareText = [
    ...combos.map((combo) => `${comboLabel(combo)} ${sharePercent(combo.tokens, basis)}`),
    ...(unattributed > 0 ? [`unattributed ${sharePercent(unattributed, basis)}`] : []),
  ].join(", ");
  return (
    <>
      <div className="session-mix__head">
        {color && <i className="session-mix__dot" style={{ background: color }} aria-hidden="true" />}
        <span title={title ?? label}>{label}</span>
        <b>{tokens === null ? "—" : formatCompact(tokens)}</b>
      </div>
      {basis > 0 && (
        <div
          className="session-mix__bar"
          role="img"
          aria-label={`${label} by model and effort: ${shareText}`}
        >
          {combos
            .filter((combo) => combo.tokens > 0)
            .map((combo) => (
              <i
                key={comboKey(combo)}
                style={{ width: `${(combo.tokens / basis) * 100}%`, background: comboColor(combo) }}
                title={`${comboLabel(combo)} · ${formatCompact(combo.tokens)} tokens · ${sharePercent(combo.tokens, basis)}`}
              />
            ))}
          {unattributed > 0 && (
            <i
              className="is-unattributed"
              style={{ width: `${(unattributed / basis) * 100}%` }}
              title={`No model × effort recorded · ${formatCompact(unattributed)} tokens · ${sharePercent(unattributed, basis)}`}
            />
          )}
        </div>
      )}
      {(combos.length > 0 || unattributed > 0) && (
        <ul className="session-mix__combos">
          {combos.map((combo) => (
            <li
              key={comboKey(combo)}
              title={`${comboLabel(combo)} · ${formatCompact(combo.tokens)} tokens · ${formatCompact(combo.observations)} observations · ${sharePercent(combo.tokens, basis)} of ${label}`}
            >
              <ComboPill combo={combo} />
              <b>{formatCompact(combo.tokens)}</b>
              <small>
                {sharePercent(combo.tokens, basis)} · {formatCompact(combo.observations)} obs
              </small>
            </li>
          ))}
          {/* The untagged share is measured the same way as the tagged one. Reporting it as a
              share and an observation count is what keeps a high observation coverage from
              reading as full coverage when those observations reach few of the tokens. */}
          {unattributed > 0 && (
            <li
              className="session-mix__unattributed"
              title={`${formatCompact(unattributed)} ${label} tokens (${sharePercent(unattributed, basis)}) that no recorded observation accounts for, so no effort could be read for them. They stay in the provider total.`}
            >
              {/* One neutral slot, not a model × effort pair: neither was recorded for these
                  tokens. It keeps the pill shape so it reads as part of the same list. */}
              <span className="split-pill">
                <span>No effort recorded</span>
              </span>
              <b>{formatCompact(unattributed)}</b>
              <small>{sharePercent(unattributed, basis)} · no observations</small>
            </li>
          )}
        </ul>
      )}
    </>
  );
}


/** Every known value stays visible for a mixed session; Unknown activity and coverage are never
 * hidden, and provenance says where the numbers came from. */
function SessionModelEffortSection({
  models,
  detail,
  agent,
  status,
  collapsed,
  onToggle,
}: {
  models: Array<{ modelName: string; tokens: number | null }>;
  detail: SessionDetail | undefined;
  agent: string;
  status: EffortIndexStatus | null;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const summary = detail?.effort ?? null;
  const summaryAvailable = summary && summary.coverageState !== "unavailable";
  const { groups, comboCount, tokens } = sessionProviderMix(
    models,
    detail?.effortCombos ?? [],
    providerFromAgent(agent),
  );
  const providerText = groups.length === 1
    ? groups[0].label
    : `${groups.length} provider${groups.length === 1 ? "" : "s"}`;
  const comboText = summaryAvailable
    ? `${comboCount} model × effort combo${comboCount === 1 ? "" : "s"}`
    : "effort unknown";
  // Partial coverage is named on the rail too. A collapsed column that shows only a dominant
  // effort would present a 7%-tagged session exactly like a fully tagged one.
  const partialCoverage = summaryAvailable
    && summary.tokenCoverage !== null
    && summary.tokenCoverage < 1;
  const collapsedStats: SessionDetailSpineStat[] = [
    summaryAvailable
      ? { value: formatCompact(comboCount), label: comboCount === 1 ? "combo" : "combos" }
      : { value: formatCompact(models.length), label: models.length === 1 ? "model" : "models" },
    summaryAvailable
      ? summary.mixed
        ? { value: "mixed", tone: "accent" }
        : { value: effortLabel(summary.dominant), label: "effort" }
      : { value: "—", label: "effort" },
    ...(partialCoverage
      ? [{
          value: sharePercent(summary.attributedTokens, summary.eligibleTokens),
          label: "tagged",
          tone: "warning" as const,
        }]
      : []),
  ];
  return (
    <SessionDetailColumn
      column="models"
      label="Models & Effort"
      collapsed={collapsed}
      collapsedMeta={`${providerText}, ${comboText}${partialCoverage ? `, ${sharePercent(summary.attributedTokens, summary.eligibleTokens)} of tokens tagged` : ""}`}
      collapsedStats={collapsedStats}
      onToggle={onToggle}
      title={EFFORT_HELP}
      // Pills carry a model, an effort, and a value on one line, so this column needs the wider
      // basis to spell them out rather than ellipsize them.
      wide
      className="session-mix"
      aside={
        <small>
          {`${providerText} · ${
            summaryAvailable
              ? `${comboCount} combo${comboCount === 1 ? "" : "s"}${partialCoverage ? `, ${sharePercent(summary.attributedTokens, summary.eligibleTokens)} tagged` : ""}`
              : "effort unknown"
          }`}
        </small>
      }
    >
      <ul className="session-mix__providers">
        {groups.map((group) => (
          <li key={group.provider}>
            <SessionMixGroupBreakdown
              label={group.label}
              title={
                group.tokens === null
                  ? `${group.label} · no token total in this session's usage records`
                  : `${group.label} · ${formatCompact(group.tokens)} tokens in this session's usage records`
              }
              color={group.color}
              tokens={group.tokens}
              combos={group.combos}
              unattributed={group.unattributed}
            />
          </li>
        ))}
      </ul>
      <EffortState status={status} summary={summary}>
        {summary && (
          <>
            {groups.length > 1 && (
              <div className="session-mix__totals">
                <SessionMixGroupBreakdown
                  label="All providers"
                  title="Every provider this session recorded, by model and effort"
                  tokens={tokens}
                  combos={groups.flatMap((group) => group.combos)}
                  unattributed={groups.reduce((sum, group) => sum + group.unattributed, 0)}
                />
              </div>
            )}
            <EffortCoverage
              summary={summary}
              indexing={status?.phase === "indexing"}
              detail
            />
          </>
        )}
      </EffortState>
      <details className="session-mix__about">
        <summary>What effort means here</summary>
        <p>{EFFORT_HELP}</p>
        <p>
          Provider totals come from this session's usage records. Each model × effort subtotal is
          read from the session's own transcript · parser v{status?.parserVersion ?? "—"}
        </p>
      </details>
    </SessionDetailColumn>
  );
}


/** Every model × effort the session recorded, dominant first. Effort alone was never a decision
 * unit, so each pill names the model that recorded it; a session that switched combos shows all
 * of them rather than hiding the rest behind a count. */
export function SessionEffortCell({
  decoded,
  enabled,
}: {
  decoded: DecodedSessionEffort | undefined;
  enabled: boolean;
}) {
  if (!enabled)
    return (
      <span className="effort-badge effort-badge-unknown" title={EFFORT_HELP}>
        Off
      </span>
    );
  if (!decoded || !decoded.dominantCombo)
    return (
      <span
        className="effort-badge effort-badge-unknown"
        title={
          decoded?.unjoinable
            ? "This session has no transcript match, so no effort could be read."
            : EFFORT_HELP
        }
      >
        Unknown
      </span>
    );
  const coverage =
    decoded.tokenCoverage === null
      ? "coverage unavailable"
      : `${Math.round(decoded.tokenCoverage * 100)}% of tokens attributed`;
  const dominantKey = comboKey(decoded.dominantCombo);
  const rest = decoded.combos
    .filter((combo) => comboKey(combo) !== dominantKey)
    .sort((left, right) => compareComboKeys(comboKey(left), comboKey(right)));
  return (
    <span
      className="session-combo-cell"
      title={`${effortSummaryLabel(decoded)} · ${coverage}${decoded.mixed ? " · mixed effort" : ""}`}
    >
      <ComboPill combo={decoded.dominantCombo} />
      {rest.map((combo) => (
        <ComboPill key={comboKey(combo)} combo={combo} />
      ))}
    </span>
  );
}


/** Names the active facet in words, so an empty state says which selection produced it. */
export function effortFilterLabel(filter: string) {
  if (filter === "mixed") return "mixed effort";
  if (filter === "unknown") return "unknown effort";
  const combo = parseComboFacet(filter);
  if (combo) return comboLabel(combo);
  return `${effortLabel(filter.startsWith("value:") ? filter.slice("value:".length) : filter)} effort`;
}

const verdictOptions = [
  { value: "good", label: "Good", icon: "＋" },
  { value: "mixed", label: "Mixed", icon: "～" },
  { value: "bad", label: "Bad", icon: "−" },
] as const;


/** The row shows the verdict; rating happens in the expanded detail. Three
 * always-visible buttons per row drowned the one signal that is user-supplied. */
export function SessionVerdictBadge({ verdict }: { verdict: SessionVerdict | null }) {
  if (!verdict) {
    return (
      <span
        className="session-verdict-badge is-unrated"
        title="Not rated — expand the row to rate this session"
      >
        —
      </span>
    );
  }
  const option = verdictOptions.find((entry) => entry.value === verdict);
  return (
    <span
      className={`session-verdict-badge is-${verdict}`}
      title={`Rated ${option?.label.toLowerCase()} — expand the row to change it`}
    >
      <i aria-hidden="true">{option?.icon}</i>
      <span className="sr-only">Rated {option?.label}</span>
    </span>
  );
}


/** One-click, keyboard-reachable rating. It is the user's own judgement: nothing here infers a
 * verdict, and clicking the active option clears it rather than locking it in. */
function SessionVerdictControl({
  sessionId,
  verdict,
  onChange,
}: {
  sessionId: string;
  verdict: SessionVerdict | null;
  onChange: (sessionId: string, annotation: SessionAnnotation) => void;
}) {
  const [pending, setPending] = useState<SessionVerdict | null | "none">("none");
  const [error, setError] = useState<string | null>(null);
  const busy = pending !== "none";

  const write = async (next: SessionVerdict | null) => {
    setPending(next);
    setError(null);
    try {
      onChange(sessionId, await setSessionVerdict(sessionId, next));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending("none");
    }
  };

  return (
    <span
      className={`session-verdict${busy ? " is-busy" : ""}`}
      role="group"
      aria-label={`Session verdict: ${verdict ?? "not rated"}`}
      aria-busy={busy}
    >
      {verdictOptions.map((option) => {
        const active = verdict === option.value;
        return (
          <button
            key={option.value}
            type="button"
            className={active ? "active" : ""}
            aria-pressed={active}
            disabled={busy}
            title={active ? `Clear the ${option.label.toLowerCase()} rating` : `Rate this session ${option.label.toLowerCase()}`}
            onClick={(event) => {
              event.stopPropagation();
              void write(active ? null : option.value);
            }}
          >
            <i aria-hidden="true">{option.icon}</i>
            <span className="sr-only">{active ? `Clear ${option.label} rating` : `Rate ${option.label}`}</span>
          </button>
        );
      })}
      {error && <em role="alert" title={error}>!</em>}
    </span>
  );
}
