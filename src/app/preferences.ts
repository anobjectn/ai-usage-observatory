import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Activity, Atom, FolderGit2, Gauge, Layers3, Orbit } from "lucide-react";
import { type ProviderColors, type SceneEffects } from "../scene";
import type { DashboardData, Session, SessionDetail } from "../types";
import { carryUrlFilters } from "../url-filters";

export type View =
  "overview" | "explorer" | "sessions" | "projects" | "models" | "sources";

export type Metric = "totalTokens" | "totalCost" | "outputTokens";

export type ProjectSummary = DashboardData["projects"][number];

export type ProjectSessionDetail = { session: Session; detail: SessionDetail };

export const nav: Array<{ id: View; label: string; icon: typeof Orbit }> = [
  { id: "overview", label: "Overview", icon: Orbit },
  { id: "explorer", label: "Explorer", icon: Activity },
  { id: "sessions", label: "Sessions", icon: Layers3 },
  { id: "projects", label: "Projects", icon: FolderGit2 },
  { id: "models", label: "Models", icon: Atom },
  { id: "sources", label: "Data", icon: Gauge },
];

/** Series colours live in styles/tokens.css as --color-series-*; SVG presentation attributes and
 * inline styles both resolve var() so charts and marks read the same tokens. The canvas scene
 * and favicon keep literal hex because they cannot. */
export const palette = [1, 2, 3, 4, 5, 6].map((index) => `var(--color-series-${index})`);

export const defaultAccent = "#78a8ff";

export const defaultProviderColors: ProviderColors = {
  anthropic: "#d97757",
  openai: "#eaeaea",
  warp: "#d7b3ff",
};

export const defaultFavoriteAccents = [
  "#78a8ff",
  "#b7f25c",
  "#58d9cf",
  "#f08bb4",
  "#f2d15c",
  "#ff786f",
];

export const accentStorageKey = "usage-observatory:accent";

export const providerColorsStorageKey = "usage-observatory:provider-colors";

export const favoriteAccentsStorageKey = "usage-observatory:favorite-accents";

export const dataTextScaleStorageKey = "usage-observatory:data-text-scale";

export const interfaceTextScaleStorageKey = "usage-observatory:interface-text-scale";

export const sidebarCollapsedStorageKey = "usage-observatory:sidebar-collapsed";

export const quickOverviewModeStorageKey = "usage-observatory:quick-overview-mode";

export const defaultDataTextScale = 125;

export const defaultInterfaceTextScale = 100;

/** The stepper's range and the range accepted back from storage must agree, or a saved value
 * silently snaps to the default on reload. Both steppers read their bounds from here. */
export const textScaleBounds = {
  data: { min: 90, max: 180, fallback: defaultDataTextScale },
  interface: { min: 90, max: 130, fallback: defaultInterfaceTextScale },
} as const;


/** Accepts a stored or typed percentage and returns a value the control can show: finite,
 * inside the bounds, on the stepper's 10-point grid. Anything else is the default. */
export function normalizeTextScale(
  raw: unknown,
  bounds: { min: number; max: number; fallback: number },
) {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (raw === null || raw === undefined || raw === "" || !Number.isFinite(value)) return bounds.fallback;
  const snapped = Math.round(value / 10) * 10;
  return snapped >= bounds.min && snapped <= bounds.max ? snapped : bounds.fallback;
}

export function faviconHref(accent: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="1.5 1.5 21 21" fill="none" stroke="${accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.341 6.484A10 10 0 0 1 10.266 21.85"/><path d="M3.659 17.516A10 10 0 0 1 13.74 2.152"/><circle cx="12" cy="12" r="3"/><circle cx="19" cy="5" r="2" fill="${accent}"/><circle cx="5" cy="19" r="2" fill="${accent}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function savedAccent() {
  try {
    const value = localStorage.getItem(accentStorageKey);
    return value && /^#[0-9a-f]{6}$/i.test(value) ? value : defaultAccent;
  } catch {
    return defaultAccent;
  }
}

export function savedFavoriteAccents() {
  try {
    const value = JSON.parse(
      localStorage.getItem(favoriteAccentsStorageKey) ?? "[]",
    );
    return Array.isArray(value) &&
      value.length === defaultFavoriteAccents.length &&
      value.every(
        (color) => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color),
      )
      ? value
      : defaultFavoriteAccents;
  } catch {
    return defaultFavoriteAccents;
  }
}

export function savedProviderColors(): ProviderColors {
  try {
    const value = JSON.parse(
      localStorage.getItem(providerColorsStorageKey) ?? "{}",
    );
    return {
      anthropic:
        typeof value.anthropic === "string" &&
        /^#[0-9a-f]{6}$/i.test(value.anthropic)
          ? value.anthropic
          : defaultProviderColors.anthropic,
      openai:
        typeof value.openai === "string" && /^#[0-9a-f]{6}$/i.test(value.openai)
          ? value.openai
          : defaultProviderColors.openai,
      warp:
        typeof value.warp === "string" && /^#[0-9a-f]{6}$/i.test(value.warp)
          ? value.warp
          : defaultProviderColors.warp,
    };
  } catch {
    return defaultProviderColors;
  }
}

export function savedDataTextScale() {
  try {
    return normalizeTextScale(localStorage.getItem(dataTextScaleStorageKey), textScaleBounds.data);
  } catch {
    return defaultDataTextScale;
  }
}

export function savedInterfaceTextScale() {
  try {
    return normalizeTextScale(
      localStorage.getItem(interfaceTextScaleStorageKey),
      textScaleBounds.interface,
    );
  } catch {
    return defaultInterfaceTextScale;
  }
}

export function savedSidebarCollapsed() {
  try {
    return localStorage.getItem(sidebarCollapsedStorageKey) === "true";
  } catch {
    return false;
  }
}

export type QuickOverviewMode = "gauges" | "grid";

export function savedQuickOverviewMode(): QuickOverviewMode {
  try {
    return localStorage.getItem(quickOverviewModeStorageKey) === "grid"
      ? "grid"
      : "gauges";
  } catch {
    return "gauges";
  }
}

export function initialView(): View {
  const value = new URLSearchParams(window.location.search).get("view");
  if (value === "limits") return "sources";
  return nav.some((item) => item.id === value) ? (value as View) : "overview";
}

export function convertLegacyViewUrl() {
  const url = new URL(window.location.href);
  if (url.searchParams.get("view") !== "limits") return;
  url.searchParams.set("view", "sources");
  window.history.replaceState(
    { ...window.history.state, view: "sources" },
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

export function initialSessionId() {
  return new URLSearchParams(window.location.search).get("session");
}


/** Links rebuild the query string, but the date, Agent, Path, and cache selections must survive
 * navigation so a bookmark of any view reproduces the analysis. */
function clearSearchKeepingFilters(url: URL) {
  const filters = new URLSearchParams(url.search);
  url.search = "";
  return filters;
}

export function sessionHref(sessionId: string) {
  const url = new URL(typeof window === "undefined" ? "http://localhost/" : window.location.href);
  const filters = clearSearchKeepingFilters(url);
  url.searchParams.set("view", "sessions");
  url.searchParams.set("session", sessionId);
  carryUrlFilters(filters, url.searchParams);
  return `${url.pathname}${url.search}`;
}

export function viewHref(view: View) {
  const url = new URL(window.location.href);
  const filters = clearSearchKeepingFilters(url);
  url.searchParams.set("view", view);
  carryUrlFilters(filters, url.searchParams);
  return `${url.pathname}${url.search}`;
}

export function modelIdsFromUrl() {
  return [
    ...new Set(
      new URLSearchParams(window.location.search)
        .getAll("model")
        .filter(Boolean),
    ),
  ];
}

export function modelsHref(models: Iterable<string>) {
  const url = new URL(window.location.href);
  const filters = clearSearchKeepingFilters(url);
  url.searchParams.set("view", "models");
  for (const model of models) url.searchParams.append("model", model);
  carryUrlFilters(filters, url.searchParams);
  return `${url.pathname}${url.search}`;
}

export const autoScrollDelayMs = 200;

export const userScrollCancelWindowMs = 260;

export function useUserScrollIntent() {
  const lastUserScrollAt = useRef(0);

  useEffect(() => {
    const markUserScrollIntent = () => {
      lastUserScrollAt.current = performance.now();
    };

    const markKeyboardScrollIntent = (event: KeyboardEvent) => {
      if (
        [
          "ArrowDown",
          "ArrowUp",
          "PageDown",
          "PageUp",
          "Home",
          "End",
        ].includes(event.key)
      ) {
        markUserScrollIntent();
      }
    };

    const options: AddEventListenerOptions = { passive: true };
    window.addEventListener("wheel", markUserScrollIntent, options);
    window.addEventListener("touchmove", markUserScrollIntent, options);
    window.addEventListener("keydown", markKeyboardScrollIntent);
    return () => {
      window.removeEventListener("wheel", markUserScrollIntent, options);
      window.removeEventListener("touchmove", markUserScrollIntent, options);
      window.removeEventListener("keydown", markKeyboardScrollIntent);
    };
  }, []);

  return lastUserScrollAt;
}

export function useModalFocusTrap(onEscape: () => void, active = true) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusableSelector =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusInitial = window.requestAnimationFrame(() => {
      const initial =
        dialog.querySelector<HTMLElement>("[data-autofocus], [autofocus]") ??
        dialog.querySelector<HTMLElement>(focusableSelector);
      (initial ?? dialog).focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onEscapeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [
        ...dialog.querySelectorAll<HTMLElement>(focusableSelector),
      ];
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusInitial);
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = previousBodyOverflow;
      previouslyFocused?.focus();
    };
  }, [active]);

  return dialogRef;
}

export function useVisibleViewportHeight() {
  const [height, setHeight] = useState<number | null>(() => {
    if (typeof window === "undefined" || !window.visualViewport) return null;
    return Math.round(window.visualViewport.height);
  });

  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => setHeight(Math.round(viewport.height));
    update();
    viewport.addEventListener("resize", update);
    window.addEventListener("resize", update);
    return () => {
      viewport.removeEventListener("resize", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return height;
}

export const sceneEffectsStorageKey = "usage-observatory:scene-effects";

export const defaultSceneEffects: SceneEffects = {
  starfield: true,
  parallax: true,
  twinkle: false,
  tesseract: true,
  speed: 0.3,
  starDensity: 3,
};

export function savedSceneEffects(): SceneEffects {
  try {
    const value = JSON.parse(
      localStorage.getItem(sceneEffectsStorageKey) ?? "",
    );
    const speed = Number(value.speed);
    const starDensity = Number(value.starDensity);
    return {
      starfield: value.starfield !== false,
      parallax: value.parallax !== false,
      twinkle: value.twinkle === true,
      tesseract: value.tesseract === true,
      speed:
        Number.isFinite(speed) && speed >= 0 && speed <= 3
          ? speed
          : defaultSceneEffects.speed,
      starDensity:
        Number.isInteger(starDensity) && starDensity >= 1 && starDensity <= 6
          ? starDensity
          : defaultSceneEffects.starDensity,
    };
  } catch {
    return defaultSceneEffects;
  }
}

export function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return reduced;
}
