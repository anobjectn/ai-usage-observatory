import { useId, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

/** The truncated tail of a tooltip list: a "+N more" row that carries the tail's
 * subtotals and opens accordion-style to reveal the rows it stands for. */
export function TooltipMoreDisclosure({
  className,
  label,
  tokens,
  cost,
  children,
}: {
  className?: string;
  label: string;
  tokens: ReactNode;
  cost: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <>
      <button
        type="button"
        className={`tooltip-more-row tooltip-more-toggle${className ? ` ${className}` : ""}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
      >
        <span>
          <ChevronRight aria-hidden="true" />
          {label}
        </span>
        <b>{tokens}</b>
        <b>{cost}</b>
      </button>
      <div id={panelId} className="tooltip-more-panel">
        {open && children}
      </div>
    </>
  );
}
