import { Check, ChevronDown, Minus, Orbit } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DashboardData } from "../types";
import type { AgentEntry, AgentSelection, BranchState } from "../agent-filter";

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

/** A parent agent row and the model families nested beneath it. `parent` is absent for the
 * trailing group of families whose vendor could not be read from the name. */
export type AgentFilterGroup = {
  label: string;
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
  const summary = selection.length === 0
    ? "All agents"
    : selection.length === 1
      ? labelFor(selection[0]) ?? "1 selected"
      : `${selection.length} selected`;

  return (
    <div className="agent-filter" ref={root}>
      <button
        type="button"
        className="agent-filter__button"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen(!open)}
      >
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
                  <span className="overline">{group.label}</span>
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
            and published-rate price estimates
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
            {data.quotas.available
              ? "Provider-reported allowance data"
              : "Optional provider allowance service unavailable; no quota estimate is substituted"}
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
