import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { RefreshCw } from "lucide-react";
import { TesseractCore, useSceneEffects } from "../scene";

/**
 * Client-side paging usually commits in a frame or two, so a raw `isPending`
 * flag flickers the indicator too fast to read as anything but a glitch. Hold
 * it open for a beat once shown.
 */
const MIN_LOADING_MS = 480;

/**
 * Page indicator shared by every paginator. Two pages or fewer read fine as a
 * static "1 / 2" glyph next to the prev/next buttons, so the jump control only
 * appears once skipping ahead is actually useful (3+ pages): a numeric field
 * plus a dropdown of every page.
 *
 * The dropdown is hand-rolled rather than a native `<datalist>` because the
 * browser filters datalist options against the field's current text — after
 * typing "19" the only surviving option is "19", which reads as an empty menu.
 */
export function PageJump({
  page,
  pages,
  onChange,
  label = "page",
}: {
  /** Current page, 1-based. */
  page: number;
  pages: number;
  onChange: (page: number) => void;
  /** Used in the accessible name, e.g. "session page". */
  label?: string;
}) {
  const effects = useSceneEffects();
  const listId = useId();
  const [draft, setDraft] = useState(String(page));
  const [open, setOpen] = useState(false);
  const [activeOption, setActiveOption] = useState(page);
  const [isPending, startTransition] = useTransition();
  const [holding, setHolding] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => setDraft(String(page)), [page]);

  useEffect(() => {
    if (!holding) return;
    const timer = setTimeout(() => setHolding(false), MIN_LOADING_MS);
    return () => clearTimeout(timer);
  }, [holding]);

  // Close on outside pointer down so the menu never outlives its trigger.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // `scrollIntoView` would scroll every scrollable ancestor, which yanks the
  // whole page away from the paginator the moment the menu opens. Only the
  // menu's own scrollTop may move.
  useLayoutEffect(() => {
    if (!open) return;
    const list = listRef.current;
    const active = list?.querySelector<HTMLElement>('[data-active="true"]')
      ?.parentElement;
    const first = list?.firstElementChild as HTMLElement | null;
    if (!list || !active || !first) return;
    // Landing on a whole multiple of the row height is what keeps the first and
    // last rows from being sliced through the middle of their digits.
    const rowHeight = active.offsetHeight;
    const index = Math.round((active.offsetTop - first.offsetTop) / rowHeight);
    const visibleRows = Math.max(1, Math.floor(list.clientHeight / rowHeight));
    list.scrollTop =
      Math.max(0, index - Math.floor((visibleRows - 1) / 2)) * rowHeight;
  }, [open]);

  if (pages <= 2) {
    return (
      <span className="page-jump page-jump--static">
        {page} / {pages}
      </span>
    );
  }

  const clamp = (value: number) => Math.min(pages, Math.max(1, value));

  const go = (next: number) => {
    setDraft(String(next));
    if (next === page) return;
    setHolding(true);
    startTransition(() => onChange(next));
  };

  const loading = isPending || holding;

  const commit = () => {
    const parsed = Number.parseInt(draft, 10);
    if (!Number.isFinite(parsed)) {
      setDraft(String(page));
      return;
    }
    go(clamp(parsed));
  };

  const openMenu = () => {
    setActiveOption(page);
    setOpen(true);
  };

  return (
    <span
      className={`page-jump${loading ? " page-jump--loading" : ""}`}
      ref={wrapRef}
    >
      <span className="page-jump__status" aria-live="polite">
        {loading && (
          <>
            {effects.tesseract ? (
              <TesseractCore className="page-jump__tesseract" />
            ) : (
              <RefreshCw className="page-jump__busy-icon spin" aria-hidden="true" />
            )}
            <span className="page-jump__status-text">page loading…</span>
          </>
        )}
      </span>
      <span className="page-jump__field">
        <input
          ref={inputRef}
          className="page-jump__input"
          type="text"
          inputMode="numeric"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="none"
          aria-label={`Go to ${label} (1 to ${pages})`}
          aria-busy={loading}
          value={draft}
          // Sized from the widest page number rather than the `size` attribute,
          // which the caret's padding would otherwise eat into.
          style={{ width: `calc(${String(pages).length}ch + 26px)` }}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => event.target.select()}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (open) {
                setOpen(false);
                go(activeOption);
              } else {
                commit();
              }
            } else if (event.key === "Escape") {
              if (open) setOpen(false);
              else setDraft(String(page));
            } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              if (open) setActiveOption((current) => clamp(current + step));
              else if (event.altKey) openMenu();
              // The list runs top-to-bottom, so Down means a higher page number
              // in the menu but Up means "next page" against the buttons.
              else go(clamp(page + (event.key === "ArrowUp" ? 1 : -1)));
            }
          }}
        />
        <button
          type="button"
          className="page-jump__caret"
          tabIndex={-1}
          aria-label={open ? "Close page list" : "Open page list"}
          onClick={() => {
            if (open) setOpen(false);
            else openMenu();
            inputRef.current?.focus();
          }}
        >
          <svg viewBox="0 0 10 6" aria-hidden="true" focusable="false">
            <path d="M1 1 5 5 9 1" />
          </svg>
        </button>
        {open && (
          <ul
            className="page-jump__menu"
            id={listId}
            role="listbox"
            ref={listRef}
            aria-label={`${label} list`}
          >
            {Array.from({ length: pages }, (_, index) => index + 1).map(
              (value) => (
                <li key={value}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={value === page}
                    data-active={value === activeOption}
                    tabIndex={-1}
                    onMouseEnter={() => setActiveOption(value)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      setOpen(false);
                      go(value);
                    }}
                  >
                    {value}
                  </button>
                </li>
              ),
            )}
          </ul>
        )}
      </span>
      <span aria-hidden="true">/ {pages}</span>
    </span>
  );
}
