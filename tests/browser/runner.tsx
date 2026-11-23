import { createRoot } from "react-dom/client";
import { useCallback } from "react";
import { App } from "../../src/App";
import { quotaRetryDelaysMs, useSessionQuotaContexts } from "../../src/hooks/use-session-quota-contexts";
import { useUpdate } from "../../src/hooks/use-update";
import { UpdateControl } from "../../src/components/update-control";
import { Sessions } from "../../src/views/sessions";
import { QuotaDials } from "../../src/components/quota-cards";
import { antigravityDailyRows, antigravityQuotaFixture, antigravityQuotaHistory, antigravitySessionFixture, dashboardFixture } from "../fixtures/dashboard";
import { ProviderTimeline } from "../../src/components/activity-charts";
import { ChartPinProvider } from "../../src/components/chart-pins";
import type { DashboardData, UpdateCheck, UpdateJob, UpdateStatus } from "../../src/types";
import "../../src/styles/index.css";

// Never run mutation scenarios against the user's normal app server.
const ready = await fetch("/__browser-test/ready").then((response) => response.json()).catch(() => null);
if (ready?.isolatedFixture !== true) throw new Error("Start bun run test:browser before opening this page");

const result = { passed: [] as string[], failed: [] as string[] };
const rootElement = document.getElementById("root")!;
let root = createRoot(rootElement);
const status = document.getElementById("test-status")!;
status.style.cssText = "position:fixed;bottom:0;right:0;z-index:10000;background:#111;color:#fff;padding:8px;max-width:80vw";
window.addEventListener("error", (event) => result.failed.push(event.message));
window.addEventListener("unhandledrejection", (event) => result.failed.push(String(event.reason)));
localStorage.setItem("usage-observatory:scene-effects", JSON.stringify({ starfield: false, parallax: false, twinkle: false, tesseract: false, speed: 3, starDensity: 1 }));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function waitFor(check: () => boolean, message: string) {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}
function click(selector: string) {
  const node = document.querySelector<HTMLElement>(selector);
  assert(node, `Missing ${selector}`);
  node.click();
}
async function state(state: string) {
  const response = await fetch("/__browser-test/state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state }) });
  assert(response.ok, "Fixture state could not change");
}
async function test(name: string, run: () => Promise<void>) {
  status.textContent = `Running: ${name}`;
  try { await run(); result.passed.push(name); }
  catch (error) { result.failed.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
}
function enter(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  assert(input, `Missing ${selector}`);
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

root.render(<App />);
await test("all six views load without a runtime error", async () => {
  await waitFor(() => Boolean(document.querySelector("aside nav")), "App did not load");
  const views = [
    ["Overview", "Activity"], ["Explorer", "Usage explorer"], ["Sessions", "Trace sessions"],
    ["Projects", "Where the work happened"], ["Models", "Model mix and efficiency"],
    ["Data", "Usage intelligence & provenance."],
  ];
  for (const [label, text] of views) {
    click(`aside nav button[aria-label="${label}"]`);
    await waitFor(() => document.querySelector("main .content")?.textContent?.includes(text) === true, `${label} did not render`);
  }
});
await test("collection failure and recovery update the stale banner", async () => {
  await state("stale");
  click(".refresh-button");
  await waitFor(() => document.querySelector(".stale-banner")?.textContent?.includes("Fixture collection failed") === true, "Stale banner stayed hidden behind the previous ETag");
  await state("healthy");
  click(".refresh-button");
  await waitFor(() => !document.querySelector(".stale-banner"), "Stale banner did not clear after recovery");
});
await test("a failed dashboard request keeps the view and recovers on retry", async () => {
  await state("offline");
  click(".refresh-button");
  await waitFor(() => Boolean(document.querySelector(".connection-banner")), "Connection banner did not appear");
  assert(document.querySelector("main .content")?.textContent?.includes("Usage intelligence"), "Previous data disappeared during the failure");
  await state("healthy");
  click(".connection-banner button");
  await waitFor(() => !document.querySelector(".connection-banner"), "Retry did not recover");
});
// Two refreshes overlap: the first one's dashboard read is held, and the second finishes first.
// The banner must follow the newer request whichever way the two turn out.
async function overlappingRefreshes(first: "fail" | "pass", second: "fail" | "pass") {
  const originalFetch = window.fetch;
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let reads = 0;
  let finished = 0;
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input !== "/api/dashboard") return originalFetch(input, init);
    const read = ++reads;
    // No ETag, so a passing read returns a body rather than a 304.
    const response = await originalFetch(input, { ...init, headers: {} });
    if (read === 1) await firstHeld;
    finished += 1;
    return (read === 1 ? first : second) === "fail" ? Response.json({ error: "Fixture read failed" }, { status: 503 }) : response;
  }) as typeof window.fetch;
  try {
    click(".refresh-button");
    await waitFor(() => reads === 1, "The first refresh did not read the dashboard");
    click(".refresh-button");
    await waitFor(() => finished === 1, "The second refresh did not finish");
    await new Promise((resolve) => setTimeout(resolve, 200));
    releaseFirst();
    await waitFor(() => finished === 2, "The first refresh did not finish");
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    window.fetch = originalFetch;
    releaseFirst();
  }
}
await test("a slow older dashboard request does not decide the connection banner", async () => {
  await waitFor(() => !document.querySelector(".connection-banner"), "The banner was up before the check");
  await overlappingRefreshes("fail", "pass");
  assert(!document.querySelector(".connection-banner"), "An older failed request raised the banner after a newer one succeeded");
  await overlappingRefreshes("pass", "fail");
  assert(document.querySelector(".connection-banner"), "An older successful request cleared the banner a newer failure raised");
  click(".connection-banner button");
  await waitFor(() => !document.querySelector(".connection-banner"), "Retry did not recover");
});
// The first refresh's collection POST is held while a second refresh runs to the end, then
// released with `firstCollection`.
async function heldCollection(firstCollection: "fail" | "pass", secondRead: "fail" | "pass") {
  const originalFetch = window.fetch;
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let collections = 0;
  let reads = 0;
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input === "/api/refresh") {
      const collection = ++collections;
      if (collection > 1) return originalFetch(input, init);
      await firstHeld;
      return firstCollection === "fail" ? Response.json({ error: "Fixture collection failed" }, { status: 500 }) : originalFetch(input, init);
    }
    if (input !== "/api/dashboard") return originalFetch(input, init);
    const read = ++reads;
    const response = await originalFetch(input, { ...init, headers: {} });
    return read === 1 && secondRead === "fail" ? Response.json({ error: "Fixture read failed" }, { status: 503 }) : response;
  }) as typeof window.fetch;
  const label = () => document.querySelector(".refresh-button span")?.textContent;
  try {
    click(".refresh-button");
    await waitFor(() => collections === 1, "The first refresh did not start collecting");
    click(".refresh-button");
    await waitFor(() => reads === 1, "The second refresh did not read the dashboard");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert(label() === "Collecting", "The second refresh finishing cleared Collecting while the first was still running");
    releaseFirst();
    await waitFor(() => label() === "Refresh", "Collecting did not clear after both refreshes ended");
    await new Promise((resolve) => setTimeout(resolve, 200));
  } finally {
    window.fetch = originalFetch;
    releaseFirst();
  }
}
await test("a refresh that was collecting is newer than a read sent meanwhile", async () => {
  await waitFor(() => !document.querySelector(".connection-banner"), "The banner was up before the check");
  await heldCollection("pass", "fail");
  assert(!document.querySelector(".connection-banner"), "A read sent during collection kept the banner up over the refresh's fresh data");
  await heldCollection("fail", "pass");
  assert(document.querySelector(".connection-banner"), "A failed collection was hidden by a read that finished while it ran");
  click(".connection-banner button");
  await waitFor(() => !document.querySelector(".connection-banner"), "Retry did not recover");
});
await test("annotations survive save, remount, and keyboard dismissal", async () => {
  click('aside nav button[aria-label="Sessions"]');
  await waitFor(() => Boolean(document.querySelector('[aria-label="Edit annotation"]')), "Fixture session did not appear");
  const originalFetch = window.fetch;
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input === "/api/sessions/fixture-session/detail") {
      return Response.json({ available: true, prompts: [], outputs: [], tools: [], files: [], additions: 0, deletions: 0, eventsRead: 0 });
    }
    return originalFetch(input, init);
  }) as typeof window.fetch;
  try {
    // Rating first, then saving a note: the row must show the note, not the annotation the
    // rating returned.
    click('[aria-label="Open session details"]');
    await waitFor(() => Boolean(document.querySelector('[title="Rate this session good"]')), "Verdict controls did not appear");
    click('[title="Rate this session good"]');
    await waitFor(() => Boolean(document.querySelector(".session-verdict-badge.is-good")), "Verdict did not save");
    click('[aria-label="Edit annotation"]');
    await waitFor(() => Boolean(document.querySelector('[aria-labelledby="annotation-modal-title"]')), "Annotation dialog did not load");
    enter('[aria-labelledby="annotation-modal-title"] input', "browser-fixture");
    enter('[aria-labelledby="annotation-modal-title"] textarea', "Saved browser fixture note\nSecond line of the note");
    await new Promise((resolve) => setTimeout(resolve, 0));
    click('[aria-labelledby="annotation-modal-title"] .primary-button');
    await waitFor(() => !document.querySelector('[aria-labelledby="annotation-modal-title"]'), "Annotation did not save");
    const label = () => document.querySelector(".session-row .session-col--model small")?.textContent;
    await waitFor(() => label() === "Saved browser fixture note", "The row did not show the note saved after the verdict");
    assert(document.querySelector(".session-verdict-badge.is-good"), "Saving the note cleared the verdict");
    const search = 'input[placeholder="Search sessions…"]';
    for (const query of ["no such session", "line OF THE note", "no such session", "browser-fixture", "no such session", "FIXTURE-SESSION"]) {
      enter(search, query);
      await waitFor(
        () => Boolean(document.querySelector(".session-row")) === (query !== "no such session"),
        `Unexpected search result for "${query}"`,
      );
    }
    enter(search, "");
  } finally {
    window.fetch = originalFetch;
  }
  root.unmount();
  root = createRoot(rootElement);
  root.render(<App />);
  await waitFor(() => Boolean(document.querySelector('[aria-label="Edit annotation"]')), "Sessions did not reload");
  click('[aria-label="Edit annotation"]');
  await waitFor(() => Boolean(document.querySelector('[aria-labelledby="annotation-modal-title"] textarea')), "Saved annotation did not reopen");
  assert(document.querySelector<HTMLTextAreaElement>('[aria-labelledby="annotation-modal-title"] textarea')?.value === "Saved browser fixture note\nSecond line of the note", "Note was not retained");
  assert(document.querySelector<HTMLInputElement>('[aria-labelledby="annotation-modal-title"] input')?.value === "browser-fixture", "Tags were not retained");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await waitFor(() => !document.querySelector('[aria-labelledby="annotation-modal-title"]'), "Escape did not dismiss the saved dialog");
});
// Starts from a freshly mounted app, so the check does not depend on the state an earlier one
// leaves behind.
async function freshSessions() {
  root.unmount();
  root = createRoot(rootElement);
  root.render(<App />);
  await waitFor(() => Boolean(document.querySelector('aside nav button[aria-label="Sessions"]')), "App did not reload");
  click('aside nav button[aria-label="Sessions"]');
  await waitFor(() => Boolean(document.querySelector('[aria-label="Edit annotation"]')), "Fixture session did not appear");
}
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
await test("a late save acknowledgment does not replace a newer note", async () => {
  await freshSessions();
  const originalFetch = window.fetch;
  const originalConfirm = window.confirm;
  window.confirm = () => true;
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let saves = 0;
  // The first save is stored at once, but its response reaches the browser only after the second.
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input !== "/api/sessions/fixture-session/annotations" || init?.method !== "PUT") return originalFetch(input, init);
    saves += 1;
    const response = await originalFetch(input, init);
    if (saves === 1) await firstHeld;
    return response;
  }) as typeof window.fetch;
  const modal = '[aria-labelledby="annotation-modal-title"]';
  const label = () => document.querySelector(".session-row .session-col--model small")?.textContent;
  const saveNote = async (note: string) => {
    click('[aria-label="Edit annotation"]');
    await waitFor(() => Boolean(document.querySelector(`${modal} textarea`)), "Annotation dialog did not open");
    enter(`${modal} textarea`, note);
    await settle(0);
    click(`${modal} .primary-button`);
  };
  try {
    await saveNote("First late note");
    await waitFor(() => saves === 1, "The first save was not sent");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await waitFor(() => !document.querySelector(modal), "The dialog did not close during the first save");
    await saveNote("Second newer note");
    await waitFor(() => !document.querySelector(modal), "The second save did not finish");
    await waitFor(() => label() === "Second newer note", "The row did not show the second note");
    await settle(500);
    releaseFirst();
    await settle(1_000);
    assert(label() === "Second newer note", `The late first acknowledgment replaced the newer note (row shows "${label()}")`);
    // A refresh must not bring the older note back either.
    click(".refresh-button");
    await settle(1_000);
    assert(label() === "Second newer note", `A refresh brought back the older note (row shows "${label()}")`);
    enter('input[placeholder="Search sessions…"]', "second newer");
    await waitFor(() => Boolean(document.querySelector(".session-row")), "Search did not find the newer note");
    enter('input[placeholder="Search sessions…"]', "");
  } finally {
    window.fetch = originalFetch;
    window.confirm = originalConfirm;
    releaseFirst();
  }
});
root.unmount();

await test("compact session sorting returns to page one for field and direction changes", async () => {
  const data = dashboardFixture();
  const sessions = Array.from({ length: 45 }, (_, index) => ({
    ...data.sessions[0],
    sessionId: `sort-fixture-${index}`,
    totalCost: index + 1,
    metadata: { lastActivity: new Date(Date.now() - index * 60_000).toISOString() },
  }));
  const fixtureRoot = createRoot(rootElement);
  try {
    fixtureRoot.render(<Sessions
      sessions={sessions}
      rateCard={data.rateCard}
      unpricedModels={[]}
      showCache={true}
      onEdit={() => {}}
      collectedAt={data.collectedAt}
    />);
    const page = () => document.querySelector<HTMLInputElement>(".session-pager .page-jump__input")?.value;
    await waitFor(() => page() === "1", "Session pager did not render");
    for (const [sort, highestOrLowest] of [["cost:desc", "$45.00"], ["cost:asc", "$1.00"]]) {
      click('[aria-label="Next session page"]');
      await waitFor(() => page() === "2", "Session pager did not advance");
      const select = document.querySelector<HTMLSelectElement>(".compact-sort select");
      assert(select, "Compact sort missing");
      select.value = sort;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await waitFor(() => page() === "1", "Changing compact sort did not return to page one");
      assert(document.querySelector(".session-row .session-col--cost b")?.textContent === highestOrLowest,
        "Sorting did not show the first session in the new order");
    }
  } finally { fixtureRoot.unmount(); }
});

await test("rows per page lands on the page holding the current first row, is saved, and is restored", async () => {
  const data = dashboardFixture();
  // Newest first, so row N is the session costing $N.00.
  const sessions = Array.from({ length: 60 }, (_, index) => ({
    ...data.sessions[0],
    sessionId: `page-size-fixture-${index}`,
    totalCost: index + 1,
    metadata: { lastActivity: new Date(Date.now() - index * 60_000).toISOString() },
  }));
  const mount = () => {
    const fixtureRoot = createRoot(rootElement);
    fixtureRoot.render(<Sessions
      sessions={sessions}
      rateCard={data.rateCard}
      unpricedModels={[]}
      showCache={true}
      onEdit={() => {}}
      collectedAt={data.collectedAt}
    />);
    return fixtureRoot;
  };
  const page = () => document.querySelector<HTMLInputElement>(".session-pager .page-jump__input")?.value;
  const sizeSelect = () => document.querySelector<HTMLSelectElement>(".session-page-size select");
  const rows = () => [...document.querySelectorAll(".session-row")];
  const firstCost = () => document.querySelector(".session-row .session-col--cost b")?.textContent;
  localStorage.removeItem("usage-observatory:session-page-size");
  let fixtureRoot = mount();
  try {
    await waitFor(() => page() === "1" && rows().length === 15, "Sessions did not render 15 rows by default");
    // The select sits beside the footer pager, so it matches that pager's arrow buttons.
    const sizeHeight = document.querySelector(".session-page-size")!.getBoundingClientRect().height;
    const arrowHeight = document.querySelector(".session-footer-pagination div > button")!.getBoundingClientRect().height;
    assert(sizeHeight === arrowHeight, `Rows per page is ${sizeHeight}px tall beside ${arrowHeight}px pager buttons`);
    const jump = ".session-pager .page-jump__input";
    enter(jump, "3");
    document.querySelector(jump)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await waitFor(() => page() === "3" && firstCost() === "$31.00", "Page 3 did not start at row 31");
    const select = sizeSelect();
    assert(select, "Rows per page select missing");
    select.value = "25";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    // Row 31 sits on page 2 at 25 rows (rows 26–50).
    await waitFor(() => page() === "2" && rows().length === 25 && firstCost() === "$26.00",
      `25 rows per page did not land on rows 26–50 (page ${page()}, ${rows().length} rows, first ${firstCost()})`);
    assert(localStorage.getItem("usage-observatory:session-page-size") === "25", "The chosen page size was not saved");
    fixtureRoot.unmount();
    fixtureRoot = mount();
    await waitFor(() => sizeSelect()?.value === "25" && page() === "1" && rows().length === 25,
      "The chosen page size was not restored on the next mount");
  } finally {
    fixtureRoot.unmount();
    // Later checks count rows on the default page size.
    localStorage.removeItem("usage-observatory:session-page-size");
  }
});

await test("jumping to a later session page loads its border reading and shows quota dividers", async () => {
  const data = dashboardFixture();
  const firstAt = Date.parse(data.collectedAt);
  const sessions = Array.from({ length: 31 }, (_, index) => ({
    ...data.sessions[0],
    sessionId: `quota-fixture-${index}`,
    metadata: { lastActivity: new Date(firstAt - index * 60_000).toISOString() },
  }));
  const reachedAt = firstAt - 29.5 * 60_000;
  const history = data.quotas.history!;
  history.available = true;
  history.windows.push({ provider: "codex", window: "fiveHour", reachedCount: 1, lastReachedAt: reachedAt, reachedAt: [reachedAt] });
  const requests: string[][] = [];
  const originalFetch = window.fetch;
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input !== "/api/session-quota-contexts") return originalFetch(input, init);
    const { sessionIds } = JSON.parse(String(init?.body)) as { sessionIds: string[] };
    requests.push(sessionIds);
    const items = Object.fromEntries(sessionIds.filter((id) => id === "quota-fixture-29" || id === "quota-fixture-30").map((id) => [
      id, {
        provider: "codex",
        coverage: { observationCadenceMs: null },
        resources: [{ id: "fiveHour", kind: "window", endUsedPercent: 10, endCycleId: `reset:${id.endsWith("29") ? firstAt : reachedAt}` }],
      },
    ]));
    return Response.json({ items });
  }) as typeof window.fetch;
  const fixtureRoot = createRoot(rootElement);
  try {
    fixtureRoot.render(<Sessions
      sessions={sessions}
      rateCard={data.rateCard}
      unpricedModels={[]}
      showCache={true}
      onEdit={() => {}}
      quotaHistory={history}
      collectedAt={data.collectedAt}
    />);
    await waitFor(() => requests.length > 0, "The first page did not request its quota readings");
    assert(requests[0].length === 15, "The first page requested extra quota readings");
    const jump = ".session-pager .page-jump__input";
    enter(jump, "3");
    document.querySelector(jump)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await waitFor(() => requests.length === 2, "The last page did not request its quota readings");
    assert(requests[1].join(",") === "quota-fixture-29,quota-fixture-30", "The last page did not ask for its unloaded neighbour and its only row");
    const boundary = () => document.querySelector(".session-reset-divider:not(.session-reset-divider--event)");
    await waitFor(() => Boolean(boundary()), "The reset boundary did not appear after the neighbour loaded");
    assert(boundary()?.previousElementSibling?.textContent?.includes("5-hour quota exhausted"), "The cross-page exhaustion event did not appear above the first row");
    click('[aria-label="Previous session page"]');
    await waitFor(() => requests.length === 3, "The middle page did not request its quota readings");
    assert(!requests[2].includes("quota-fixture-29") && !requests[2].includes("quota-fixture-14"), "The middle page refetched cached readings");
    assert(!document.querySelector(".session-reset-divider"), "The last page's dividers also appeared on the middle page");
  } finally {
    fixtureRoot.unmount();
    window.fetch = originalFetch;
  }
});

/** A synthetic Antigravity detail as the on-demand reader returns it. */
function antigravityDetailResponse() {
  return {
    available: true,
    prompts: [{ text: "Add a retry to the fixture loader", timestamp: "2026-11-21T20:00:00.000Z" }],
    outputs: [{ text: "Added the retry and a test for it.", timestamp: "2026-11-21T20:01:00.000Z", truncated: false }],
    tools: [{ name: "read_file", count: 3 }, { name: "edit_file", count: 1 }, { name: "write_file", count: 1 }],
    files: [
      { path: "/fixture/gemini-project/src/loader.ts", status: "modified", additions: 4, deletions: 1 },
      { path: "/fixture/gemini-project/src/loader.test.ts", status: "added", additions: 12, deletions: 0 },
    ],
    additions: 16, deletions: 1, eventsRead: 3,
  };
}

await test("an Antigravity session is filterable, priced by ccusage, and opens its prompts, replies, tools, and files", async () => {
  const originalFetch = window.fetch;
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    input === "/api/sessions/antigravity-fixture-conversation/detail" ? Response.json(antigravityDetailResponse()) : originalFetch(input, init)) as typeof window.fetch;
  const appRoot = createRoot(rootElement);
  try {
    appRoot.render(<App />);
    await waitFor(() => Boolean(document.querySelector('aside nav button[aria-label="Sessions"]')), "App did not load");
    click('aside nav button[aria-label="Sessions"]');
    const row = () => [...document.querySelectorAll<HTMLElement>(".session-row")].find((item) => item.textContent?.includes("gemini-4-neon"));
    await waitFor(() => Boolean(row()), "The Antigravity session did not appear");
    const cost = row()!.querySelector(".session-col--cost")?.textContent ?? "";
    assert(cost.includes("$0.03") && !cost.includes("no price"), `The Antigravity session did not show its ccusage cost: "${cost}"`);
    click(".agent-filter__button");
    await waitFor(() => Boolean(document.querySelector(".agent-filter__menu")), "The Agent filter did not open");
    const groups = [...document.querySelectorAll<HTMLElement>(".agent-filter__group")];
    const groupLabels = (group: HTMLElement | undefined) => [...(group?.querySelectorAll("label span") ?? [])].map((node) => node.textContent);
    const antigravityGroup = groups.find((group) => group.querySelector(".agent-filter__parent")?.textContent?.includes("antigravity"));
    const googleGroup = groups.find((group) => group.querySelector(".overline")?.textContent === "Google");
    assert(groupLabels(antigravityGroup).includes("gemini-4-neon"), `The Agent filter did not list Neon under Antigravity: ${groupLabels(antigravityGroup).join(", ")}`);
    // Warp's Gemini is Google's, never Antigravity's.
    assert(!groupLabels(antigravityGroup).includes("gemini-3-flash"), "Warp's Gemini was listed under Antigravity");
    assert(groupLabels(googleGroup).includes("gemini-3-flash"), `Warp's Gemini was not listed under Google: ${groups.map((group) => group.textContent).join(" | ")}`);
    googleGroup!.querySelector<HTMLInputElement>("input")!.click();
    await waitFor(() => [...document.querySelectorAll(".session-row")].length === 1, "Selecting Google's Gemini did not narrow to the Warp session");
    assert(!row(), "Selecting Google's Gemini kept the Antigravity session");
    assert(Boolean(document.querySelector(".agent-filter__provider-marks i[style*='--color-provider-google']")), "The filter summary did not use the Google colour");
    click(".agent-filter__menu-head button");
    await waitFor(() => Boolean(row()), "Clearing the filter did not bring the Antigravity session back");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    row()!.querySelector<HTMLElement>('[aria-label="Open session details"]')!.click();
    const detail = () => document.querySelector<HTMLElement>(".session-detail--antigravity");
    await waitFor(() => detail()?.textContent?.includes("Add a retry to the fixture loader") === true, "The detail panel did not show the prompt");
    const text = detail()!.textContent!;
    assert(text.includes("Added the retry and a test for it."), "The detail panel did not show the reply");
    assert(!/not imported/i.test(text), "The detail panel still said content is not imported");
    for (const label of ["MODEL CALLS", "REASONING TOKENS", "TOOL CALLS", "FILES TOUCHED", "PATCH SUMMARY", "WORKSPACE", "RECORDED BY"]) {
      assert(text.includes(label), `The detail summary did not show ${label}`);
    }
    const toolsRail = detail()!.querySelector<HTMLElement>('[aria-label^="Expand Tools"]');
    assert(toolsRail?.getAttribute("aria-label") === "Expand Tools, 5 calls across 3 tool types", `The collapsed Tools column was wrong: ${toolsRail?.getAttribute("aria-label")}`);
    toolsRail!.click();
    await waitFor(() => Boolean(detail()!.querySelector(".tool-list")), "The Tools column did not expand");
    const tools = [...detail()!.querySelectorAll(".tool-list li")].map((item) => item.textContent);
    assert(tools.join("|") === "read_file×3|edit_file×1|write_file×1", `The tools column was wrong: ${tools.join("|")}`);
    assert(detail()!.querySelectorAll(".file-list li").length === 2, "The files column did not list both files");
    assert(Boolean(detail()!.querySelector('[aria-label="Open actions for /fixture/gemini-project/src/loader.ts"]')), "A listed file offered no open actions");
    assert(!detail()!.querySelector('[aria-label="Open Prompt source actions"]'), "The detail panel offered to open a transcript");
    assert(!detail()!.querySelector('[aria-label="Open Output source actions"]'), "The detail panel offered to open a transcript");
    for (const cell of detail()!.querySelectorAll<HTMLElement>(".session-detail__summary > div")) {
      assert(cell.scrollWidth <= cell.clientWidth + 1, `A summary cell overflows: ${cell.textContent}`);
    }
  } finally {
    appRoot.unmount();
    window.fetch = originalFetch;
  }
});

await test("an Antigravity detail whose database cannot be read keeps its metadata and says why", async () => {
  const data = dashboardFixture();
  const originalFetch = window.fetch;
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    input === "/api/sessions/antigravity-fixture-conversation/detail"
      ? Response.json({ available: false, prompts: [], outputs: [], tools: [], files: [], additions: 0, deletions: 0, eventsRead: 0 })
      : originalFetch(input, init)) as typeof window.fetch;
  const fixtureRoot = createRoot(rootElement);
  try {
    fixtureRoot.render(<Sessions
      sessions={[antigravitySessionFixture()]}
      rateCard={data.rateCard}
      unpricedModels={[]}
      showCache={true}
      onEdit={() => {}}
      quotaHistory={data.quotas.history}
      collectedAt={data.collectedAt}
    />);
    await waitFor(() => Boolean(document.querySelector('[aria-label="Open session details"]')), "The Antigravity session did not render");
    click('[aria-label="Open session details"]');
    const detail = () => document.querySelector<HTMLElement>(".session-detail--antigravity");
    await waitFor(() => detail()?.textContent?.includes("database could not be read right now") === true, "The detail panel did not say the database could not be read");
    const text = detail()!.textContent!;
    assert(text.includes("MODEL CALLS") && text.includes("12"), "The unavailable detail dropped the model call count");
    assert(text.includes("gemini-project"), "The unavailable detail dropped the workspace");
  } finally {
    fixtureRoot.unmount();
    window.fetch = originalFetch;
  }
});

await test("the Projects diff trail shows an Antigravity session's recorded effort", async () => {
  const originalFetch = window.fetch;
  let detailReads = 0;
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input === "/api/sessions/antigravity-fixture-conversation/detail") {
      detailReads++;
      return Response.json({
        ...antigravityDetailResponse(),
        files: [{ path: "/fixture/gemini-project/src/loader.ts", status: "modified", additions: 4, deletions: 1 }],
        additions: 4, deletions: 1,
        effort: {
          coverageState: "complete", quality: "ok", dominant: "high", dominantBasis: "tokens", mixed: false,
          levels: [{ effort: "high", observations: 12, tokens: 64_900, tokenShare: 1 }], reconciliationDeltaTokens: 0,
          observedObservations: 12, unknownObservations: 0, observationCoverage: 1, eligibleTokens: 64_900, attributedTokens: 64_900, unknownTokens: 0, tokenCoverage: 1,
        },
      });
    }
    if (String(input).startsWith("/api/dashboard")) {
      // The shared fixture lists no projects; this one holds the Antigravity session's directory.
      const response = await originalFetch(input, init);
      if (!response.ok) return response;
      const data = await response.json() as DashboardData;
      const session = data.sessions.find((entry) => entry.sessionId === "antigravity-fixture-conversation")!;
      const { sessionId: _id, agent: _agent, period: _period, cwd: _cwd, pathTags: _tags, annotation: _note, metadata: _meta, antigravity: _stats, activityIntervals: _intervals, source: _source, ...totals } = session;
      data.projects = [{
        name: "/fixture/gemini-project", tokens: session.totalTokens, cost: session.totalCost, sessions: 1, models: session.modelsUsed,
        trend: [{ ...totals, date: data.daily[0]!.period }],
      }];
      return Response.json(data);
    }
    return originalFetch(input, init);
  }) as typeof window.fetch;
  const appRoot = createRoot(rootElement);
  try {
    appRoot.render(<App />);
    await waitFor(() => Boolean(document.querySelector('aside nav button[aria-label="Projects"]')), "App did not load");
    click('aside nav button[aria-label="Projects"]');
    const projectRow = () => [...document.querySelectorAll<HTMLButtonElement>("button.project-row")].find((row) => row.textContent?.includes("gemini-project"));
    await waitFor(() => Boolean(projectRow()), "The Antigravity project did not appear");
    projectRow()!.click();
    const entry = () => [...document.querySelectorAll<HTMLElement>(".project-session-list li")].find((item) => item.querySelector(".agent-pill.antigravity"));
    await waitFor(() => Boolean(entry()), "The Antigravity session was not listed in the diff trail");
    await waitFor(() => entry()!.querySelector(".effort-badge")?.textContent === "High", `The diff trail did not show the recorded effort: "${entry()?.querySelector(".effort-badge")?.textContent}"`);
    assert(detailReads > 0, "The diff trail did not read the session's detail");
    assert(entry()!.textContent!.includes("1 file"), `The diff trail did not count the session's file: "${entry()!.textContent}"`);
    assert(entry()!.textContent!.includes("loader.ts"), "The diff trail did not name the session's file");
  } finally {
    appRoot.unmount();
    window.fetch = originalFetch;
  }
});

/** A frame of its own width, so the stylesheet's media queries see a real narrow viewport. */
function frameRoot(width: number) {
  const frame = document.createElement("iframe");
  frame.style.cssText = `width:${width}px;height:900px;border:0`;
  document.body.append(frame);
  const doc = frame.contentDocument!;
  for (const node of document.querySelectorAll('style, link[rel="stylesheet"]')) doc.head.append(node.cloneNode(true));
  const container = doc.createElement("div");
  doc.body.append(container);
  return { doc, root: createRoot(container), remove: () => frame.remove() };
}

await test("the Antigravity quota card reads at desktop and narrow widths, and is absent when not reported", async () => {
  for (const width of [1280, 375]) {
    localStorage.removeItem("usage-observatory:quota-details-open");
    const { doc, root: fixtureRoot, remove } = frameRoot(width);
    try {
      fixtureRoot.render(<QuotaDials quotas={antigravityQuotaFixture()} timeZone="UTC" />);
      const glance = () => doc.querySelector(".quota-glance__provider.antigravity");
      await waitFor(() => Boolean(glance()), `The Antigravity glance did not render at ${width}px`);
      const names = [...glance()!.querySelectorAll(".quota-glance__bucket > b")].map((node) => node.textContent);
      assert(names.join(",") === "5h,w,Partner w,Partner 5h,Argon w", `Unexpected glance windows at ${width}px: ${names.join(",")}`);
      // The Gemini subscription is a peer of Anthropic's and OpenAI's: third, before Warp.
      const providers = [...doc.querySelectorAll(".quota-glance__provider")].map((node) => [...node.classList].find((name) => name !== "quota-glance__provider"));
      assert(providers.join(",") === "anthropic,codex,antigravity,warp", `Unexpected glance order at ${width}px: ${providers.join(",")}`);
      const panel = doc.querySelector(".quota-panel")!.getBoundingClientRect();
      for (const bucket of glance()!.querySelectorAll(".quota-glance__bucket")) {
        assert(bucket.getBoundingClientRect().right <= panel.right + 1, `An Antigravity glance window overflows its panel at ${width}px`);
      }
      doc.querySelector<HTMLElement>(".quota-details-toggle")!.click();
      const card = () => doc.querySelector<HTMLElement>(".quota-card.antigravity");
      await waitFor(() => Boolean(doc.querySelector(".quota-grid:not(.is-collapsed)")) && Boolean(card()), `The Antigravity card did not open at ${width}px`);
      const cards = [...doc.querySelectorAll(".quota-card")].map((node) => ["anthropic", "codex", "antigravity", "warp"].find((name) => node.classList.contains(name)));
      assert(cards.join(",") === "anthropic,codex,antigravity,warp", `Unexpected card order at ${width}px: ${cards.join(",")}`);
      const text = card()!.textContent ?? "";
      assert(text.includes("Google AI Pro") && text.includes("Limits: Gemini 4 Argon") && text.includes("Limits: partner models"), `The Antigravity card is missing its plan or scopes at ${width}px`);
      // The card clips its decorative glow, so overflow is measured on each window's text.
      for (const copy of card()!.querySelectorAll<HTMLElement>(".quota-bucket__copy")) {
        assert(copy.scrollWidth <= copy.clientWidth + 1, `A window's text overflows the Antigravity card at ${width}px: ${copy.querySelector("b")?.textContent}`);
      }
    } finally {
      fixtureRoot.unmount();
      remove();
    }
  }
  const { doc, root: fixtureRoot, remove } = frameRoot(1280);
  try {
    fixtureRoot.render(<QuotaDials quotas={antigravityQuotaFixture(false)} timeZone="UTC" />);
    await waitFor(() => Boolean(doc.querySelector(".quota-glance")), "The quota strip did not render");
    assert(!doc.querySelector(".antigravity"), "An Antigravity card appeared without a report");
  } finally {
    fixtureRoot.unmount();
    remove();
    localStorage.removeItem("usage-observatory:quota-details-open");
  }
});

await test("a headroom line with readings on one day shows as a dot", async () => {
  localStorage.removeItem("usage-observatory:headroom-lines");
  const { doc, root: fixtureRoot, remove } = frameRoot(1280);
  try {
    const history = antigravityQuotaHistory();
    const series = history.series ?? [];
    const lastDay = Math.max(...series.map((point) => point.capturedAt));
    const oneDay = { ...history, series: series.filter((point) => lastDay - point.capturedAt < 12 * 3_600_000) };
    fixtureRoot.render(
      <ChartPinProvider>
        <div className="panel">
          <ProviderTimeline
            rows={antigravityDailyRows()}
            projectActivity={[]}
            activeProvider={null}
            quotaHistory={oneDay}
            timeZone="UTC"
            emptyText="No activity"
            headroomOverlay
          />
        </div>
      </ChartPinProvider>,
    );
    const toggles = () => [...doc.querySelectorAll<HTMLLabelElement>(".provider-legend__headroom")];
    await waitFor(() => toggles().length > 0, "A single day of headroom readings offered no headroom toggle");
    await waitFor(
      () => [...doc.querySelectorAll("circle.recharts-dot")].some((dot) => dot.getAttribute("fill") === "var(--color-provider-antigravity)"),
      "The single-day Antigravity weekly headroom was not drawn as a dot",
    );
  } finally {
    fixtureRoot.unmount();
    remove();
    localStorage.removeItem("usage-observatory:headroom-lines");
  }
});

await test("Antigravity draws weekly and five-hour headroom lines and reach markers on the activity chart", async () => {
  localStorage.removeItem("usage-observatory:headroom-lines");
  const { doc, root: fixtureRoot, remove } = frameRoot(1280);
  try {
    fixtureRoot.render(
      <ChartPinProvider>
        <div className="panel">
          <ProviderTimeline
            rows={antigravityDailyRows()}
            projectActivity={[]}
            activeProvider={null}
            quotaHistory={antigravityQuotaHistory()}
            timeZone="UTC"
            emptyText="No activity"
            headroomOverlay
          />
        </div>
      </ChartPinProvider>,
    );
    const toggles = () => [...doc.querySelectorAll<HTMLLabelElement>(".provider-legend__headroom")];
    const toggle = (text: string) => toggles().find((label) => label.textContent === text)?.querySelector("input");
    await waitFor(() => toggles().length > 0, "The headroom toggles did not render");
    const names = toggles().map((label) => label.textContent).join(", ");
    assert(names === "Antigravity weekly, Antigravity 5-hour low", `Unexpected headroom toggles: ${names}`);
    assert(toggle("Antigravity weekly")?.checked === true, "Antigravity's weekly headroom line was not on by default");
    assert(toggle("Antigravity 5-hour low")?.checked === false, "Antigravity's five-hour headroom line was on by default");
    const line = (dash: string) => [...doc.querySelectorAll("path.recharts-curve")].find((path) =>
      path.getAttribute("stroke") === "var(--color-provider-antigravity)" && path.getAttribute("stroke-dasharray") === dash);
    await waitFor(() => Boolean(line("1 3 7 3")), "The dash-dot Antigravity weekly headroom line was not drawn");
    assert(!line("0 7"), "The dotted five-hour line was drawn while switched off");
    toggle("Antigravity 5-hour low")!.click();
    await waitFor(() => Boolean(line("0 7")), "Switching on the five-hour line did not draw a dotted Antigravity line");
    const saved = JSON.parse(localStorage.getItem("usage-observatory:headroom-lines") ?? "null");
    assert(saved?.shown?.includes("fiveHourHeadroomAntigravity") && saved?.known?.includes("headroomAntigravity"), "The headroom choice was not saved with its known lines");
    // The weekly line's right axis is the 0-100% headroom scale.
    assert([...doc.querySelectorAll(".provider-chart svg text")].some((tick) => tick.textContent === "100%"), "The headroom axis did not render");
    // Hovering the last day opens its card, which names Antigravity's headroom beside the tokens.
    const surface = doc.querySelector<HTMLElement>(".provider-chart .recharts-wrapper")!;
    const box = surface.getBoundingClientRect();
    const hover = { bubbles: true, clientX: box.right - 50, clientY: box.top + box.height / 2 };
    surface.dispatchEvent(new MouseEvent("mouseover", hover));
    surface.dispatchEvent(new MouseEvent("mousemove", hover));
    await waitFor(() => [...doc.querySelectorAll(".tooltip-headroom")].length === 2, "Hovering the chart did not show the headroom rows");
    const rows = [...doc.querySelectorAll(".tooltip-headroom")].map((node) => node.textContent);
    assert(rows[0] === "Weekly headroom at day's end · Antigravity 60%" && rows[1] === "Lowest 5-hour headroom · Antigravity 72%", `Unexpected tooltip headroom: ${rows.join(" | ")}`);
    surface.dispatchEvent(new MouseEvent("mouseleave", hover));
    const legend = doc.querySelector(".quota-marker-legend");
    assert(legend?.textContent?.includes("Antigravity events"), `The marker legend did not name Antigravity: ${legend?.textContent}`);
    const swatch = legend!.querySelector<HTMLElement>("i.antigravity")!;
    assert(getComputedStyle(swatch).backgroundColor === "rgb(66, 133, 244)", `The Antigravity marker swatch was not Google Blue: ${getComputedStyle(swatch).backgroundColor}`);
    await waitFor(
      () => [...doc.querySelectorAll(".recharts-reference-line line")].some((node) => node.getAttribute("stroke") === "var(--color-provider-antigravity)"),
      "The Antigravity quota-reach marker was not drawn",
    );
    assert([...doc.querySelectorAll(".recharts-reference-line text")].some((node) => node.textContent?.startsWith("Antigravity 5h quota")), "The reach marker label did not name Antigravity");
  } finally {
    fixtureRoot.unmount();
    remove();
    localStorage.removeItem("usage-observatory:headroom-lines");
  }
});

await test("Appearance shows Antigravity in Google Blue and the Google label in Google Green, both adjustable", async () => {
  localStorage.removeItem("usage-observatory:provider-colors");
  const appRoot = createRoot(rootElement);
  const property = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim().toLowerCase();
  try {
    appRoot.render(<App />);
    await waitFor(() => Boolean(document.querySelector(".appearance-button")), "App did not load");
    click(".appearance-button");
    const input = (label: string) => document.querySelector<HTMLInputElement>(`.appearance-modal input[aria-label="${label} color"]`);
    await waitFor(() => Boolean(input("Antigravity")) && Boolean(input("Google")), "The Antigravity and Google colour controls did not render");
    assert(input("Antigravity")!.value === "#4285f4", `Antigravity did not default to Google Blue: ${input("Antigravity")!.value}`);
    assert(input("Google")!.value === "#34a853", `Google did not default to Google Green: ${input("Google")!.value}`);
    assert(property("--color-provider-antigravity") === "#4285f4" && property("--color-provider-google") === "#34a853", "The runtime provider colours did not match their defaults");
    enter('.appearance-modal input[aria-label="Google color"]', "#fbbc05");
    enter('.appearance-modal input[aria-label="Antigravity color"]', "#1a73e8");
    await waitFor(() => property("--color-provider-google") === "#fbbc05", "Changing the Google colour did not reach the page");
    await waitFor(() => property("--color-provider-antigravity") === "#1a73e8", "Changing the Antigravity colour did not reach the page");
    const saved = JSON.parse(localStorage.getItem("usage-observatory:provider-colors") ?? "{}");
    assert(saved.google === "#fbbc05" && saved.antigravity === "#1a73e8", "The adjusted Google colours were not saved");
    enter('.appearance-modal input[aria-label="Google color"]', "#34a853");
    enter('.appearance-modal input[aria-label="Antigravity color"]', "#4285f4");
    await waitFor(() => property("--color-provider-google") === "#34a853", "The Google colour did not return to its default");
  } finally {
    appRoot.unmount();
    localStorage.removeItem("usage-observatory:provider-colors");
    document.documentElement.style.removeProperty("--color-provider-google");
    document.documentElement.style.removeProperty("--color-provider-antigravity");
  }
});

// Exercise the real hook with controlled network failures and retry timers. Other browser timers
// keep running normally, and no quota request from these fixtures reaches the server.
async function quotaRetryFixture(run: (fixture: {
  requests: string[][];
  timers: Map<number, { callback: () => void; delay: number }>;
  request: (ids: string[]) => Promise<void>;
  renderVersion: (version: string) => void;
  retry: () => Promise<number>;
}) => Promise<void>) {
  const originalFetch = window.fetch;
  const originalTimeout = window.setTimeout;
  const originalClearTimeout = window.clearTimeout;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const requests: string[][] = [];
  let timerId = -1;
  let hook: ReturnType<typeof useSessionQuotaContexts> | undefined;
  const fixtureRoot = createRoot(rootElement);
  const flush = () => new Promise<void>((resolve) => originalTimeout(resolve, 0));
  function Harness({ version }: { version: string }) {
    hook = useSessionQuotaContexts(useCallback(() => version, [version]));
    return null;
  }
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input !== "/api/session-quota-contexts") return originalFetch(input, init);
    requests.push((JSON.parse(String(init?.body)) as { sessionIds: string[] }).sessionIds);
    return new Response("{}", { status: 503 });
  }) as typeof window.fetch;
  window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (typeof handler === "function" && quotaRetryDelaysMs.includes(delay ?? -1)) {
      const id = timerId--;
      timers.set(id, { callback: () => handler(...args), delay: delay! });
      return id;
    }
    return originalTimeout(handler, delay, ...args);
  }) as typeof window.setTimeout;
  window.clearTimeout = ((id?: number) => {
    if (id !== undefined && timers.delete(id)) return;
    originalClearTimeout(id);
  }) as typeof window.clearTimeout;
  const renderVersion = (version: string) => fixtureRoot.render(<Harness version={version} />);
  try {
    renderVersion("v1");
    await waitFor(() => Boolean(hook), "Quota retry hook did not mount");
    await run({
      requests, timers, renderVersion,
      request: async (ids) => { hook!.request(ids); await flush(); },
      retry: async () => {
        const entry = timers.entries().next().value;
        assert(entry, "Expected a scheduled quota retry");
        const [id, timer] = entry;
        timers.delete(id);
        timer.callback();
        await flush();
        return timer.delay;
      },
    });
  } finally {
    fixtureRoot.unmount();
    window.fetch = originalFetch;
    window.setTimeout = originalTimeout;
    window.clearTimeout = originalClearTimeout;
  }
}

await test("a new quota reading version receives a fresh retry budget", async () => {
  await quotaRetryFixture(async ({ request, retry, requests, timers, renderVersion }) => {
    await request(["old"]);
    for (const delay of quotaRetryDelaysMs) assert(await retry() === delay, "Quota retry used the wrong delay");
    assert(requests.length === 4 && timers.size === 0, "Quota retry budget was not exhausted");
    renderVersion("v2");
    await waitFor(() => requests.length === 5, "Changed quota reading was not requested");
    for (const delay of quotaRetryDelaysMs) assert(await retry() === delay, "New version did not reset its retry budget");
    assert(Number(requests.length) === 8 && Number(timers.size) === 0, "New version exceeded its retry budget");
  });
});
await test("an exhausted quota session does not consume another session's retries", async () => {
  await quotaRetryFixture(async ({ request, retry, requests, timers }) => {
    await request(["old"]);
    for (const delay of quotaRetryDelaysMs) assert(await retry() === delay, "Quota retry used the wrong delay");
    await request(["old", "new"]);
    for (const delay of quotaRetryDelaysMs) {
      assert(await retry() === delay, "New session did not receive its retry budget");
      assert(JSON.stringify(requests.at(-1)) === '["new"]', "Exhausted session joined the new session's retries");
    }
    assert(timers.size === 0, "Quota session exceeded its retry budget");
  });
});
// In-app update UI against mocked `/api/update/*` sequences. Nothing reaches a real launcher.
const baseCheck: UpdateCheck = {
  id: "11111111-1111-4111-8111-111111111111", checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(),
  branch: "main", upstream: "origin/main", remoteDisplay: "git@github.com:owner/repo.git", head: "a".repeat(40), target: "b".repeat(40),
  relationship: "behind", state: "eligible", reason: null, eligible: true, dirty: false, ahead: 0, behind: 2, blockers: [], paths: [],
  currentVersion: "1.0.0", targetVersion: "1.1.0", incomingCommits: [{ sha: "b".repeat(40), subject: "feat: fixture change" }],
  dependenciesChanged: false, migrationsChanged: false, launcherChanged: false, protocolCompatible: true,
};
const baseJob: UpdateJob = {
  id: "22222222-2222-4222-8222-222222222222", checkId: baseCheck.id, from: "a".repeat(40), target: "b".repeat(40), phase: "installing",
  gitState: "target", installComplete: false, buildComplete: false, startupAttempted: false, launcherRestartRequired: false,
  startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), retryable: false,
};
const baseStatus: UpdateStatus = {
  managed: true, mode: "prod", canApply: true, blockingReason: null, running: { commit: "a".repeat(40), version: "1.0.0", bootId: "boot", startedAt: null },
  check: null, job: null, schemaAhead: false, backupPath: null, autoCheckDue: false, launcherRestartRequired: false,
};
type Step = UpdateStatus | "offline";
function updateFixture(options: { statuses: Step[]; check?: Partial<UpdateCheck>; applyStatus?: number; storage?: Map<string, string> }) {
  const calls: string[] = [];
  let index = 0;
  const reloads: number[] = [];
  // Pass the same map to a second fixture to model the page after its reload.
  const storage = options.storage ?? new Map<string, string>();
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/api/update/status") {
      const step = options.statuses[Math.min(index++, options.statuses.length - 1)];
      if (step === "offline") throw new TypeError("Failed to fetch");
      return Response.json(step);
    }
    if (path === "/api/update/check") return Response.json({ ...baseCheck, ...options.check });
    if (path === "/api/update/apply") return Response.json({ job: baseJob }, { status: options.applyStatus ?? 202 });
    if (path === "/api/update/retry") return Response.json({ job: { ...baseJob, phase: "building" } }, { status: 202 });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const fixtureRoot = createRoot(rootElement);
  function Harness() {
    const update = useUpdate({ fetch: fetcher, reload: () => reloads.push(Date.now()), storage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => void storage.set(key, value) }, appCommit: "a".repeat(40), hostname: "127.0.0.1" });
    return <aside><UpdateControl update={update} /></aside>;
  }
  fixtureRoot.render(<Harness />);
  return { calls, reloads, storage, unmount: () => fixtureRoot.unmount() };
}
const buttonText = () => document.querySelector(".update-button")?.textContent ?? "";
const detailsText = () => document.querySelector("#update-details")?.textContent ?? "";

await test("update: check, one apply click, reconnect, and a single reload", async () => {
  const active = { ...baseStatus, job: baseJob };
  const done = { ...baseStatus, job: { ...baseJob, phase: "complete" as const } };
  const fixture = updateFixture({ statuses: [baseStatus, baseStatus, active, "offline", active, done, done] });
  try {
    await waitFor(() => buttonText() === "Check for updates", "Idle label missing");
    click(".update-button");
    await waitFor(() => buttonText() === "Update and restart", "Eligible check did not offer the update");
    assert(detailsText().includes("feat: fixture change"), "Incoming commits missing from details");
    click(".update-button");
    await waitFor(() => fixture.calls.includes("POST /api/update/apply"), "Apply was not requested");
    await waitFor(() => detailsText().includes("Restarting — reconnecting"), "A lost connection during the restart was not shown as reconnecting");
    await waitFor(() => fixture.reloads.length === 1, "Completed update did not reload");
  } finally { fixture.unmount(); }
  // The reloaded page sees the same completed job again and must not reload a second time.
  const reloaded = updateFixture({ statuses: [active, done], storage: fixture.storage });
  try {
    const statusReads = () => reloaded.calls.filter((call) => call === "GET /api/update/status").length;
    await waitFor(() => statusReads() >= 2, "The reloaded page did not read the completed job");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert(reloaded.reloads.length === 0, "Completed update reloaded more than once");
  } finally { reloaded.unmount(); }
});

await test("update: one button; focus shows information without a check, and Escape closes it", async () => {
  const fixture = updateFixture({ statuses: [baseStatus] });
  try {
    await waitFor(() => buttonText() === "Check for updates", "Idle label missing");
    assert(document.querySelectorAll(".update-control > button").length === 1, "The control has more than one button");
    document.querySelector<HTMLButtonElement>(".update-button")!.focus();
    await waitFor(() => detailsText().includes("Running v1.0.0"), "Focus did not show the information panel");
    assert(!fixture.calls.includes("POST /api/update/check"), "Showing information started a check");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await waitFor(() => !document.querySelector("#update-details"), "Escape did not close the panel");
  } finally { fixture.unmount(); }
});

await test("update: a due background check makes Update the only click", async () => {
  const fixture = updateFixture({ statuses: [{ ...baseStatus, autoCheckDue: true }, baseStatus] });
  try {
    await waitFor(() => buttonText() === "Update and restart", "Background check did not run");
    assert(!document.querySelector("#update-details"), "Background check opened the details panel");
  } finally { fixture.unmount(); }
});

const stateTexts: Array<[Partial<UpdateCheck>, string]> = [
  [{ state: "up-to-date", relationship: "equal", eligible: false }, "Up to date"],
  [{ state: "ahead", relationship: "ahead", ahead: 2, eligible: false }, "2 commits ahead"],
  [{ state: "diverged", relationship: "diverged", eligible: false }, "have diverged"],
  [{ state: "dirty", eligible: false, dirty: true, paths: ["src/App.tsx"] }, "src/App.tsx"],
  [{ state: "collision", eligible: false, paths: ["dist/x.js"] }, "would overwrite"],
  [{ state: "git-busy", eligible: false, paths: ["MERGE_HEAD"] }, "Git operation is in progress"],
  [{ state: "unsupported", reason: "unsupported/not-main", branch: "feature", eligible: false }, "Switch to main yourself"],
  [{ state: "failed", reason: "failed/auth", eligible: false }, "could not authenticate"],
  [{ state: "incompatible", eligible: false }, "newer launcher"],
];
await test("update: every check state shows a specific reason", async () => {
  for (const [check, text] of stateTexts) {
    const fixture = updateFixture({ statuses: [baseStatus], check });
    try {
      await waitFor(() => buttonText() === "Check for updates", "Idle label missing");
      click(".update-button");
      await waitFor(() => detailsText().includes(text), `${check.state} did not show "${text}"`);
      assert(buttonText() === "Check for updates", `${check.state} offered an update`);
    } finally { fixture.unmount(); }
  }
});

await test("update: dev and remote-restricted servers show manual guidance instead of apply", async () => {
  for (const [status, text] of [[{ ...baseStatus, managed: false, mode: "dev" as const, canApply: false, blockingReason: "dev" as const }, "git pull --ff-only"], [{ ...baseStatus, canApply: false, blockingReason: "remote-restricted" as const }, "only from this computer"]] as const) {
    const fixture = updateFixture({ statuses: [status] });
    try {
      await waitFor(() => buttonText() === "Check for updates", "Idle label missing");
      click(".update-button");
      await waitFor(() => detailsText().includes(text), `Missing guidance: ${text}`);
      assert(buttonText() === "Check for updates", "A non-applicable server offered the update");
    } finally { fixture.unmount(); }
  }
});

await test("update: a failed job shows its Git state, log, backup, and Retry", async () => {
  const failed = { ...baseStatus, job: { ...baseJob, phase: "failed" as const, failedPhase: "installing" as const, retryable: true, backupPath: "/tmp/pre-update.db", failure: { code: "install-failed", message: "install exited with 1", logTail: ["error: lockfile mismatch"] } } };
  const fixture = updateFixture({ statuses: [failed, failed, { ...baseStatus, job: { ...baseJob, phase: "complete" } }] });
  try {
    await waitFor(() => Boolean(document.querySelector(".update-button")), "Control missing");
    document.querySelector<HTMLButtonElement>(".update-button")!.focus();
    await waitFor(() => detailsText().includes("lockfile mismatch"), "Log tail missing");
    assert(detailsText().includes("at the new version") && detailsText().includes("/tmp/pre-update.db"), "Git state or backup missing");
    const retry = [...document.querySelectorAll<HTMLButtonElement>("#update-details button")].find((button) => button.textContent === "Retry");
    assert(retry, "Retry missing");
    retry.click();
    await waitFor(() => fixture.calls.includes("POST /api/update/retry"), "Retry was not requested");
  } finally { fixture.unmount(); }
});

await test("update: the open panel dims the app except the update control and the status card", async () => {
  const appRoot = createRoot(rootElement);
  try {
    appRoot.render(<App />);
    await waitFor(() => Boolean(document.querySelector("aside .update-button")), "Sidebar update control missing");
    document.querySelector<HTMLButtonElement>("aside .update-button")!.focus();
    await waitFor(() => Boolean(document.querySelector(".app-shell.update-focus")), "The overlay did not appear");
    const blurred = (selector: string) => getComputedStyle(document.querySelector(selector)!).filter.includes("blur");
    await waitFor(() => blurred("aside nav"), "Navigation was not blurred");
    assert(!blurred("aside .update-control") && !blurred("aside .side-status"), "The update control or status card was blurred");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await waitFor(() => !document.querySelector(".app-shell.update-focus"), "Escape did not remove the overlay");
  } finally { appRoot.unmount(); }
});

await test("update: recovery is visible when the dashboard request fails", async () => {
  const originalFetch = window.fetch;
  const failed = { ...baseStatus, job: { ...baseJob, phase: "failed" as const, failedPhase: "verifying" as const, retryable: true, failure: { code: "startup-failed", message: "The new server exited with 3", logTail: [] } } };
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => String(input) === "/api/update/status" ? Response.json(failed) : originalFetch(input, init)) as typeof fetch;
  await state("offline");
  const appRoot = createRoot(rootElement);
  try {
    appRoot.render(<App />);
    await waitFor(() => Boolean(document.querySelector(".error-state")), "Offline screen missing");
    await waitFor(() => document.querySelector(".error-state")?.textContent?.includes("The new server exited with 3") === true, "Update recovery missing from the offline screen");
  } finally {
    appRoot.unmount();
    window.fetch = originalFetch;
    await state("healthy");
  }
});

status.textContent = `${result.passed.length} passed; ${result.failed.length} failed. ${result.failed.join("; ")}`;
document.title = result.failed.length ? "Browser regressions failed" : "Browser regressions passed";
await fetch("/__browser-test/result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(result) });
