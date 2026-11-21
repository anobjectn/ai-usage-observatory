import { expect, test } from "bun:test";
import { matchesSessionSearch, sessionQuotaDividers, sessionQuotaPageIds, sessionSearchMatcher } from "./app/analytics";
import type { QuotaHistory, Session, SessionQuotaContext } from "./types";

const hour = 60 * 60 * 1_000;

function session(overrides: Partial<Session>): Session {
  return {
    agent: "codex",
    sessionId: "session",
    period: "2026-07-18",
    cwd: "/work/observatory",
    pathTags: ["observatory"],
    annotation: { tags: [], note: "", verdict: null },
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 20,
    cacheCreationTokens: 0,
    totalTokens: 35,
    totalCost: 0.02,
    modelsUsed: ["gpt-test"],
    modelBreakdowns: [],
    ...overrides,
  };
}

test("session search matches the whole note and session ID, ignoring case", () => {
  const row = session({
    sessionId: "019a2f4e-7c1d-4b8e-9f00-3d5e6a7b8c9d",
    annotation: { tags: ["ship"], note: "Friday rollout\nBlocked on the migration review", verdict: null },
  });
  const matches = (query: string) => matchesSessionSearch(row, "xhigh effort", query);

  expect(matches("friday ROLLOUT")).toBe(true);
  // The row shows only the first line, but every line is searchable.
  expect(matches("migration rev")).toBe(true);
  // A phrase can run across a line break, as it reads in the editor.
  expect(matches("rollout blocked")).toBe(true);
  // A query copied with doubled whitespace still matches.
  expect(matchesSessionSearch({ ...row, annotation: { ...row.annotation, note: "Friday  rollout" } }, "", "Friday  rollout")).toBe(true);
  expect(matches("019A2F4E-7C1D-4B8E-9F00-3D5E6A7B8C9D")).toBe(true);
  // The 12-character suffix the row label shows, and any other part of the ID.
  expect(matches("3d5e6a7b8c9d")).toBe(true);
  expect(matches("4b8e-9f")).toBe(true);
  expect(matches("saturday")).toBe(false);
  // Case is ignored for Greek final sigma too.
  const greek = { ...row, annotation: { ...row.annotation, note: "ΛΟΓΟΣ" } };
  expect(matchesSessionSearch(greek, "", "Σ")).toBe(true);
  expect(matchesSessionSearch(greek, "", "λόγος".normalize("NFD").replace(/\p{M}/gu, ""))).toBe(true);
  // A blank query matches without reading the session.
  expect(sessionSearchMatcher(" \n")({} as never, "")).toBe(true);
  // Fields searched before keep matching.
  for (const query of ["codex", "gpt-test", "work/observ", "ship", "xhigh", "ship xhigh"]) {
    expect(matches(query)).toBe(true);
  }
});

// Seven sessions ten hours apart, with a quota event between every adjacent pair, one after the
// newest and one before the oldest. Pages hold three rows, so two events fall on page breaks.
const sessions = Array.from({ length: 7 }, (_, offset) =>
  session({
    sessionId: `s${offset}`,
    metadata: { lastActivity: new Date((offset + 1) * 10 * hour).toISOString() },
  }),
);
const eventTimes = [5, 15, 25, 35, 45, 55, 65, 75].map((at) => at * hour);
const history: QuotaHistory = {
  available: true,
  trackingSince: 0,
  windows: [{ provider: "codex", window: "fiveHour", reachedCount: eventTimes.length, lastReachedAt: 75 * hour, reachedAt: eventTimes }],
  codexBankedResets: { usedCount: 0, used: [] },
};
const pageSize = 3;

/** Every divider each page draws, in display order, as [page, row on the page, event time]. */
function dividersByPage(sorted: Session[], direction: "asc" | "desc") {
  const pages = Math.ceil(sorted.length / pageSize);
  return Array.from({ length: pages }, (_, pageIndex) => pageIndex).flatMap((pageIndex) => {
    const start = pageIndex * pageSize;
    return sorted.slice(start, start + pageSize).flatMap((_, row) => {
      const { events, trailingEvents } = sessionQuotaDividers(sorted, start + row, direction, history, {});
      return [...events, ...trailingEvents].map((event) => [pageIndex + 1, row, event.at / hour]);
    });
  });
}

test("quota events between pages are drawn once, at the top of the later page, newest first", () => {
  const sorted = [...sessions].reverse();
  // The event before the oldest session belongs to no gap, as before.
  expect(dividersByPage(sorted, "desc")).toEqual([
    [1, 0, 75],
    [1, 1, 65],
    [1, 2, 55],
    [2, 0, 45],
    [2, 1, 35],
    [2, 2, 25],
    [3, 0, 15],
  ]);
});

test("quota events between pages are drawn once, at the top of the later page, oldest first", () => {
  // The newest row owns the event after it, drawn below it on the last page.
  expect(dividersByPage(sessions, "asc")).toEqual([
    [1, 1, 15],
    [1, 2, 25],
    [2, 0, 35],
    [2, 1, 45],
    [2, 2, 55],
    [3, 0, 65],
    [3, 0, 75],
  ]);
  const last = sessionQuotaDividers(sessions, sessions.length - 1, "asc", history, {});
  expect(last.events.map((event) => event.at / hour)).toEqual([65]);
  expect(last.trailingEvents.map((event) => event.at / hour)).toEqual([75]);
});

test("a banked reset at a page edge appears once in each sort direction", () => {
  const usedAt = 30 * hour;
  const resets: QuotaHistory = {
    ...history,
    windows: [],
    codexBankedResets: { usedCount: 1, used: [{ id: "banked-reset", title: "", usedAt }] },
  };
  const ascending = sessions.flatMap((_, index) =>
    sessionQuotaDividers(sessions, index, "asc", resets, {}).events.map((event) => [index, event.kind]),
  );
  const descending = [...sessions].reverse();
  const newestFirst = descending.flatMap((_, index) =>
    sessionQuotaDividers(descending, index, "desc", resets, {}).events.map((event) => [index, event.kind]),
  );
  expect(ascending).toEqual([[2, "reset"]]);
  expect(newestFirst).toEqual([[5, "reset"]]);
});

test("a reset boundary between pages compares the first row with the previous page's last row", () => {
  const context = (fiveHourCycle: string) => ({
    provider: "anthropic",
    resources: [{ id: "fiveHour", endCycleId: fiveHourCycle }],
  }) as SessionQuotaContext;
  const sorted = [...sessions].reverse();
  const contexts = { s4: context("reset:4000"), s3: context("reset:3000") };

  // sorted[2] (s4) ends page 1 and sorted[3] (s3) starts page 2.
  expect(sessionQuotaDividers(sorted, 3, "desc", history, contexts).boundaries).toEqual([
    { provider: "anthropic", id: "fiveHour", label: "5-hour", at: 3000 },
  ]);
  expect(sessionQuotaDividers(sorted, 0, "desc", history, contexts).boundaries).toEqual([]);
  // A neighbour whose reading has not arrived yet draws nothing until it does.
  expect(sessionQuotaDividers(sorted, 3, "desc", history, { s3: context("reset:3000") }).boundaries).toEqual([]);
});

test("a page asks for its own readings and the previous page's last row, not the whole list", () => {
  const ids = sessions.map((row) => row.sessionId);
  expect(sessionQuotaPageIds(sessions, 0, 3)).toEqual(ids.slice(0, 3));
  expect(sessionQuotaPageIds(sessions, 3, 6)).toEqual(ids.slice(2, 6));
  expect(sessionQuotaPageIds(sessions, 6, 9)).toEqual(ids.slice(5, 7));
  expect(sessionQuotaPageIds(sessions.slice(0, 6), 6, 9)).toEqual([]);
  expect(sessionQuotaPageIds([], 0, 3)).toEqual([]);
});
