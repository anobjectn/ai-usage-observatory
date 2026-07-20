import { Orbit } from "lucide-react";
import type { ReactNode } from "react";
import type { DashboardData } from "../types";

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
            and offline price estimates
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
