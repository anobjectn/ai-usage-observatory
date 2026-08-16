import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EffortAggregate, EffortComboBoard, EffortComboDays, EffortGroup, EffortIndexStatus, EffortSessionDigest, SessionAnnotation, SessionVerdict } from "../types";
import { comboKey, comboLabel, familyLabel, parseComboFacet, type Combo } from "../combo";

export type EffortScopeInput = {
  basis?: "timeline" | "sessions";
  rangeDays?: number | null;
  fromDate?: string | null;
  toDate?: string | null;
  /** Unioned with `modelFamilies`; empty means every provider. */
  providers?: string[];
  /** Unioned with `providers`; empty means every model. */
  modelFamilies?: string[];
  pathTag?: string;
  project?: string | null;
  model?: string | null;
  effort?: string;
  outliers?: "all" | "typical" | "only";
};

export function effortScopeParams(scope: EffortScopeInput) {
  const params = new URLSearchParams();
  if (scope.basis) params.set("basis", scope.basis);
  if (scope.rangeDays) params.set("rangeDays", String(scope.rangeDays));
  if (scope.fromDate) params.set("from", scope.fromDate);
  if (scope.toDate) params.set("to", scope.toDate);
  if (scope.providers?.length) params.set("providers", scope.providers.join(","));
  if (scope.modelFamilies?.length) params.set("modelFamilies", scope.modelFamilies.join(","));
  if (scope.pathTag && scope.pathTag !== "all") params.set("pathTag", scope.pathTag);
  if (scope.project) params.set("project", scope.project);
  if (scope.model) params.set("model", scope.model);
  if (scope.effort && scope.effort !== "all") params.set("effort", scope.effort);
  if (scope.outliers && scope.outliers !== "all") params.set("outliers", scope.outliers);
  return params;
}

/** Conditional GET that keeps the previous body on 304 and reports failures without throwing.
 * Every effort request is isolated: a failure here must not disturb the dashboard. */
function useConditional<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const etag = useRef<string | null>(null);
  const lastUrl = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!url) return;
    // A different scope is a different resource; its ETag must not be sent.
    if (lastUrl.current !== url) { etag.current = null; lastUrl.current = url; }
    try {
      const response = await fetch(url, { headers: etag.current ? { "If-None-Match": etag.current } : undefined });
      if (response.status === 304) { setError(null); return; }
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      etag.current = response.headers.get("ETag");
      setData(await response.json() as T);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [url]);

  return { data, error, load };
}

const STATUS_POLL_MS = 5_000;
const IDLE_POLL_MS = 60_000;

/** Status freshness is independent of `/api/dashboard`: it polls quickly while a backfill runs
 * and falls back to the dashboard's own 60-second cadence once the index is idle. */
export function useEffortStatus() {
  const status = useConditional<EffortIndexStatus>("/api/effort/status");
  const { load } = status;
  const indexing = status.data?.phase === "indexing";
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), indexing ? STATUS_POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(timer);
  }, [load, indexing]);
  return status;
}

export function useEffortAggregate(group: EffortGroup, scope: EffortScopeInput, enabled = true) {
  const params = effortScopeParams(scope);
  params.set("group", group);
  const url = enabled ? `/api/effort?${params.toString()}` : null;
  const aggregate = useConditional<EffortAggregate>(url);
  const { load } = aggregate;
  const indexVersion = aggregate.data?.status.indexVersion ?? null;
  useEffect(() => { void load(); }, [load]);
  return { ...aggregate, indexVersion };
}

/** Model × effort by day. Deliberately not an `EffortGroup`: `denominators()` handles only `day`
 * specially, so a new group would fall into the raw-model branch and give every cell a zero
 * denominator. The chart needs day-level reconciliation, not a per-model one. */
export function useEffortComboDays(scope: EffortScopeInput, enabled = true) {
  const url = enabled ? `/api/effort/combo-days?${effortScopeParams(scope).toString()}` : null;
  const days = useConditional<EffortComboDays>(url);
  const { load } = days;
  useEffect(() => { void load(); }, [load]);
  return days;
}

/** "What works where". Its ETag also tracks the annotation revision, so a verdict written from
 * the Sessions table shows up here on the next conditional fetch. */
export function useEffortComboBoard(scope: EffortScopeInput, enabled = true) {
  const url = enabled ? `/api/effort/combos?${effortScopeParams(scope).toString()}` : null;
  const board = useConditional<EffortComboBoard>(url);
  const { load } = board;
  useEffect(() => { void load(); }, [load]);
  return board;
}

export function useEffortSessions(scope: EffortScopeInput, enabled = true) {
  const url = enabled ? `/api/effort/sessions?${effortScopeParams(scope).toString()}` : null;
  const digest = useConditional<EffortSessionDigest>(url);
  const { load } = digest;
  useEffect(() => { void load(); }, [load]);
  return digest;
}

/** Views never index tuple positions directly; this is the one decoder. */
export type DecodedSessionEffort = {
  sessionId: string;
  /** Display-dominant combo. It is not an outcome leader; see the scoreboard for that. */
  dominantCombo: Combo | null;
  /** Effort of the dominant combo, kept because several surfaces still read effort alone. */
  dominant: string | null;
  combos: Combo[];
  /** Two or more distinct efforts. Tracked separately from `multipleCombos`. */
  mixed: boolean;
  multipleCombos: boolean;
  hasUnknown: boolean;
  unjoinable: boolean;
  tokenCoverage: number | null;
  levels: Set<string>;
  comboKeys: Set<string>;
};

export function decodeEffortDigest(digest: EffortSessionDigest | null): Map<string, DecodedSessionEffort> {
  const decoded = new Map<string, DecodedSessionEffort>();
  if (!digest) return decoded;
  const combos: Combo[] = digest.combos.map(([familyIndex, effortIndex]) => ({
    family: digest.families[familyIndex] ?? "unknown",
    effort: digest.efforts[effortIndex] ?? "",
  }));
  for (const [sessionId, dominantIndex, flags, coveragePerMille, maskHex] of digest.rows) {
    const mask = BigInt(`0x${maskHex || "0"}`);
    const present = combos.filter((_, index) => (mask & (1n << BigInt(index))) !== 0n);
    const dominantCombo = dominantIndex >= 0 ? combos[dominantIndex] ?? null : null;
    decoded.set(sessionId, {
      sessionId,
      dominantCombo,
      dominant: dominantCombo?.effort ?? null,
      combos: present,
      mixed: (flags & 1) !== 0,
      hasUnknown: (flags & 2) !== 0,
      unjoinable: (flags & 4) !== 0,
      multipleCombos: (flags & 8) !== 0,
      tokenCoverage: dominantIndex >= 0 || coveragePerMille > 0 ? coveragePerMille / 1000 : null,
      levels: new Set(present.map((combo) => combo.effort)),
      comboKeys: new Set(present.map(comboKey)),
    });
  }
  return decoded;
}

/** Text form of a session's model and effort. Keyboard labels, search text, and empty states all
 * use it, so the value is never carried by colour alone. */
export function effortSummaryLabel(decoded: DecodedSessionEffort | undefined) {
  if (!decoded || !decoded.dominantCombo) return "unknown";
  const label = comboLabel(decoded.dominantCombo);
  const extra = decoded.combos.length - 1;
  return extra > 0 ? `${label} and ${extra} more` : label;
}

/** Free-text haystack for the Sessions search box. Family labels, raw family ids, and efforts are
 * all included, so `luna max` finds the sessions that recorded it. */
export function effortSearchText(decoded: DecodedSessionEffort | undefined) {
  if (!decoded || decoded.combos.length === 0) return "unknown";
  return [
    ...decoded.combos.map((combo) => `${familyLabel(combo.family)} ${combo.family} ${combo.effort}`),
    decoded.mixed ? "mixed" : "",
    decoded.hasUnknown ? "unknown" : "",
  ].filter(Boolean).join(" ").toLowerCase();
}

/** `filter` is "all", "mixed", "unknown", `value:<effort>`, or an encoded combo. */
export function matchesSessionEffortFilter(decoded: DecodedSessionEffort | undefined, filter: string) {
  if (filter === "all") return true;
  if (filter === "unknown") return !decoded || decoded.dominant === null;
  if (filter === "mixed") return Boolean(decoded?.mixed);
  const combo = parseComboFacet(filter);
  if (combo) return Boolean(decoded?.comboKeys.has(comboKey(combo)));
  const effort = filter.startsWith("value:") ? filter.slice("value:".length) : filter;
  return Boolean(decoded?.levels.has(effort));
}

/** Canonical numeric order for the sortable Effort column; Unknown always sorts last. */
export function sessionEffortSortValue(decoded: DecodedSessionEffort | undefined, rankOf: (effort: string) => number) {
  return !decoded || decoded.dominant === null ? Number.MAX_SAFE_INTEGER : rankOf(decoded.dominant);
}

/** Re-fetches the visible group and digest when the private index version advances, so a
 * completed backfill appears without touching `/api/dashboard`. */
export function useEffortRefreshOnIndexChange(indexVersion: number | null | undefined, reloaders: Array<() => void | Promise<void>>) {
  const previous = useRef<number | null>(null);
  const stable = useMemo(() => reloaders, reloaders);
  useEffect(() => {
    if (indexVersion === null || indexVersion === undefined) return;
    if (previous.current !== null && previous.current !== indexVersion) stable.forEach((reload) => void reload());
    previous.current = indexVersion;
  }, [indexVersion, stable]);
}

export async function setEffortIndexing(enabled: boolean) {
  const response = await fetch("/api/effort/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!response.ok) throw new Error(`Server returned ${response.status}`);
  return await response.json() as EffortIndexStatus;
}

export async function deleteEffortDerivedObservations() {
  const response = await fetch("/api/effort/derived", { method: "DELETE" });
  if (!response.ok) throw new Error(`Server returned ${response.status}`);
  return await response.json() as EffortIndexStatus;
}

/** One-click verdict write. It returns the stored annotation so the caller can patch visible
 * state immediately; the next conditional fetch must independently return the same value. */
export async function setSessionVerdict(sessionId: string, verdict: SessionVerdict | null) {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/verdict`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ verdict }),
  });
  if (!response.ok) throw new Error(`Server returned ${response.status}`);
  return (await response.json() as { annotation: SessionAnnotation }).annotation;
}
