import { CalendarRange, Check, ChevronDown, Minus, Orbit } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DashboardData } from "../types";
import type { AgentEntry, AgentSelection, BranchState } from "../agent-filter";
import {
  dateRangeLabel,
  validDateRange,
  type DateRange,
  type MetricRange,
} from "../time-range";

export function PageTitle({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-title">
      <div>
        <span className="overline">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions}
    </header>
  );
}

export function Segmented({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  label?: string;
}) {
  return (
    <div className="segmented" aria-label={label}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          className={value === option.value ? "active" : ""}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const timeOptions = [
  { value: "1", short: "1d", long: "1 day" },
  { value: "7", short: "7d", long: "7 days" },
  { value: "14", short: "14d", long: "14 days" },
  { value: "30", short: "30d", long: "30 days" },
  { value: "120", short: "120d", long: "120 days" },
  { value: "all", short: "All", long: "All time" },
] satisfies Array<{ value: MetricRange; short: string; long: string }>;

export function TimeRangeControl({
  value,
  customRange,
  availableRange,
  resolvedRange,
  onChange,
  expandedLabels = false,
  label = "Dashboard time span",
}: {
  value: MetricRange;
  customRange: DateRange | null;
  availableRange: DateRange | null;
  resolvedRange: DateRange | null;
  onChange: (value: MetricRange, customRange?: DateRange) => void;
  expandedLabels?: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange>(() =>
    customRange ?? resolvedRange ?? availableRange ?? { from: "", to: "" },
  );
  const root = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const firstInput = useRef<HTMLInputElement | null>(null);
  const valid = validDateRange(draft);

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) window.setTimeout(() => trigger.current?.focus(), 0);
  };

  useEffect(() => {
    if (!open) return;
    setDraft(customRange ?? resolvedRange ?? availableRange ?? { from: "", to: "" });
    const focusTimer = window.setTimeout(() => firstInput.current?.focus(), 0);
    const onPointerDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, customRange, resolvedRange, availableRange]);

  return (
    <div className="time-range-control" ref={root}>
      <div className="segmented time-range-segmented" aria-label={label}>
        {timeOptions.map((option) => (
          <button
            type="button"
            key={option.value}
            className={value === option.value ? "active" : ""}
            aria-pressed={value === option.value}
            onClick={() => {
              close();
              onChange(option.value);
            }}
          >
            {expandedLabels ? option.long : option.short}
          </button>
        ))}
        <button
          ref={trigger}
          type="button"
          className={`time-range-custom${value === "custom" ? " active" : ""}`}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-pressed={value === "custom"}
          aria-label={
            value === "custom"
              ? `Custom dates, ${dateRangeLabel(customRange)}`
              : "Choose custom dates"
          }
          title={value === "custom" ? dateRangeLabel(customRange) : "Choose custom dates"}
          onClick={() => setOpen((current) => !current)}
        >
          <CalendarRange aria-hidden="true" />
          <span>{expandedLabels ? "Custom" : "Dates"}</span>
        </button>
      </div>
      {open && (
        <div className="date-range-popover" role="dialog" aria-label="Choose custom date range">
          <div className="date-range-popover__head">
            <span className="overline">CUSTOM INTERVAL</span>
            <b>Select inclusive dates</b>
          </div>
          <div className="date-range-fields">
            <label>
              <span>From</span>
              <input
                ref={firstInput}
                type="date"
                value={draft.from}
                min={availableRange?.from}
                max={draft.to || availableRange?.to}
                onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))}
              />
            </label>
            <label>
              <span>To</span>
              <input
                type="date"
                value={draft.to}
                min={draft.from || availableRange?.from}
                max={availableRange?.to}
                onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))}
              />
            </label>
          </div>
          {!valid && <small className="date-range-error">Choose a valid start date on or before the end date.</small>}
          <div className="date-range-actions">
            <button type="button" onClick={() => close(true)}>Cancel</button>
            <button
              type="button"
              className="primary-button"
              disabled={!valid}
              onClick={() => {
                if (!valid) return;
                onChange("custom", draft);
                close(true);
              }}
            >
              Apply range
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A parent agent row and the model families nested beneath it. `parent` is absent for the
 * trailing group of families whose vendor could not be read from the name. */
export type AgentFilterGroup = {
  label: string;
  summaryColor?: string;
  note?: string;
  parent?: { label: string; state: BranchState; onToggle: () => void };
  options: Array<{ value: AgentEntry; label: string; checked: boolean; onToggle: () => void }>;
};

/** A checkbox that can also render the "some, but not all" state. `indeterminate` is a DOM
 * property with no HTML attribute, so it has to be assigned through a ref. */
function TriCheckbox({
  state,
  onToggle,
  label,
}: {
  state: BranchState;
  onToggle: () => void;
  label: string;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (input.current) input.current.indeterminate = state === "indeterminate";
  }, [state]);
  return (
    <>
      <input
        ref={input}
        type="checkbox"
        checked={state === "checked"}
        aria-checked={state === "indeterminate" ? "mixed" : state === "checked"}
        onChange={onToggle}
      />
      <i aria-hidden="true" data-state={state}>
        {state === "checked" ? <Check /> : state === "indeterminate" ? <Minus /> : null}
      </i>
      <span>{label}</span>
    </>
  );
}

/** The one Agent control. Coarse agents and model families are checkable in the same popover
 * because they answer the same question at two grains; keeping them in separate selects made the
 * two look like independent filters that could disagree.
 *
 * Checking an agent means every model under it. Unchecking one of those children leaves the rest
 * checked and drops the agent to the mixed state, so "all of Claude except Fable" is expressible
 * without a second control. */
export function AgentFilter({
  selection,
  onChange,
  groups,
}: {
  selection: AgentSelection;
  onChange: (next: AgentSelection) => void;
  groups: AgentFilterGroup[];
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // An empty selection is "All agents" rather than "nothing", so the summary never reads as a
  // filter that hides everything. A single entry names itself; anything else is counted, because
  // a checked agent and a lone model both occupy one slot but read very differently.
  const labelFor = (entry: AgentEntry) => {
    for (const group of groups) {
      const option = group.options.find((candidate) => candidate.value === entry);
      if (option) return option.label;
      if (group.parent && entry === `agent:${group.label}`) return group.parent.label;
    }
    return null;
  };
  const modelCount = groups.reduce(
    (sum, group) =>
      sum + group.options.filter((option) => option.checked).length,
    0,
  );
  const summary = selection.length === 0
    ? "All agents"
    : selection.length === 1
      ? labelFor(selection[0]) ?? "1 selected"
      : `${modelCount} selected`;
  const summaryColors = [
    ...new Set(
      groups
        .filter(
          (group) =>
            group.summaryColor &&
            (selection.length === 0 ||
              group.options.some((option) => option.checked)),
        )
        .map((group) => group.summaryColor!),
    ),
  ];

  return (
    <div className="agent-filter" ref={root}>
      <button
        type="button"
        className="agent-filter__button"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen(!open)}
      >
        {summaryColors.length > 0 && (
          <span className="agent-filter__provider-marks" aria-hidden="true">
            {summaryColors.map((color) => (
              <i key={color} style={{ background: color }} />
            ))}
          </span>
        )}
        <span>{summary}</span>
        <ChevronDown />
      </button>
      {open && (
        <div className="agent-filter__menu" role="group" aria-label="Agent and model filter">
          <div className="agent-filter__menu-head">
            <span>{selection.length === 0 ? "No filter — showing all" : summary}</span>
            <button type="button" onClick={() => onChange([])} disabled={selection.length === 0}>
              Clear
            </button>
          </div>
          <div className="agent-filter__list">
            {groups.map((group) => (
              <div className="agent-filter__group" key={group.label}>
                {group.parent ? (
                  <label className="agent-filter__parent">
                    <TriCheckbox
                      state={group.parent.state}
                      onToggle={group.parent.onToggle}
                      label={group.parent.label}
                    />
                  </label>
                ) : (
                  <>
                    <span className="overline">{group.label}</span>
                    {group.note && (
                      <small className="agent-filter__group-note">
                        {group.note}
                      </small>
                    )}
                  </>
                )}
                {group.options.map((option) => (
                  <label key={option.value} className={group.parent ? "agent-filter__child" : undefined}>
                    <TriCheckbox
                      state={option.checked ? "checked" : "unchecked"}
                      onToggle={option.onToggle}
                      label={option.label}
                    />
                  </label>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return (
    <div className="empty">
      <Orbit />
      <p>{text}</p>
    </div>
  );
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.2.8-.5v-2.2c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.9 1.3 1.9 1.3 1.1 1.9 2.8 1.4 3.5 1.1.1-.8.4-1.4.8-1.7-2.7-.3-5.6-1.4-5.6-6.1 0-1.4.5-2.5 1.3-3.4-.1-.3-.6-1.6.1-3.3 0 0 1.1-.4 3.6 1.3a12.4 12.4 0 0 1 6.5 0c2.5-1.7 3.6-1.3 3.6-1.3.7 1.7.3 3 .1 3.3.8.9 1.3 2 1.3 3.4 0 4.7-2.9 5.8-5.6 6.1.4.4.8 1.1.8 2.2v3.2c0 .3.2.6.8.5A12 12 0 0 0 12 .3Z"
      />
    </svg>
  );
}

export function InformationSources({ data }: { data: DashboardData }) {
  return (
    <footer className="information-sources" aria-label="Information sources">
      <div>
        <span className="overline">INFORMATION SOURCES</span>
        <p>Local analytics, metadata, and optional provider allowance data.</p>
      </div>
      <ul>
        <li>
          <a
            href="https://github.com/ccusage/ccusage"
            target="_blank"
            rel="noreferrer"
          >
            ccusage
          </a>
          <span>
            v{data.ccusageVersion} by ryoppippi · MIT · local usage analytics
            and published-rate price estimates · {data.timeZone} calendar
          </span>
        </li>
        <li>
          <b>Local agent records</b>
          <span>
            Claude Code and Codex session headers · working-directory metadata
            only
          </span>
        </li>
        <li>
          <a
            href="https://github.com/anobjectn/quota-service"
            target="_blank"
            rel="noreferrer"
          >
            quota-service
          </a>
          <span>
            {data.quotas.sourceState === "disabled"
              ? "Optional provider allowance collection is off"
              : data.quotas.sourceState === "history_only"
                ? "Read-only local allowance history; live collection is off"
                : data.quotas.available
                  ? "Provider-reported allowance data"
                  : "Configured provider allowance service is unavailable; no quota estimate is substituted"}
          </span>
        </li>
      </ul>
      <a
        className="information-sources__repository"
        href="https://github.com/anobjectn/ai-usage-observatory"
        target="_blank"
        rel="noreferrer"
      >
        <GitHubMark />
        <span>AI Usage Observatory</span>
      </a>
    </footer>
  );
}
