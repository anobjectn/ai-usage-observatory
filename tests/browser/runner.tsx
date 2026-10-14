import { createRoot } from "react-dom/client";
import { useCallback } from "react";
import { App } from "../../src/App";
import { quotaRetryDelaysMs, useSessionQuotaContexts } from "../../src/hooks/use-session-quota-contexts";
import { useUpdate } from "../../src/hooks/use-update";
import { UpdateControl } from "../../src/components/update-control";
import type { UpdateCheck, UpdateJob, UpdateStatus } from "../../src/types";
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
await test("annotations survive save, remount, and keyboard dismissal", async () => {
  click('aside nav button[aria-label="Sessions"]');
  await waitFor(() => Boolean(document.querySelector('[aria-label="Edit annotation"]')), "Fixture session did not appear");
  click('[aria-label="Edit annotation"]');
  await waitFor(() => Boolean(document.querySelector('[aria-labelledby="annotation-modal-title"]')), "Annotation dialog did not load");
  enter('[aria-labelledby="annotation-modal-title"] input', "browser-fixture");
  enter('[aria-labelledby="annotation-modal-title"] textarea', "Saved browser fixture note");
  await new Promise((resolve) => setTimeout(resolve, 0));
  click('[aria-labelledby="annotation-modal-title"] .primary-button');
  await waitFor(() => !document.querySelector('[aria-labelledby="annotation-modal-title"]'), "Annotation did not save");
  root.unmount();
  root = createRoot(rootElement);
  root.render(<App />);
  await waitFor(() => Boolean(document.querySelector('[aria-label="Edit annotation"]')), "Sessions did not reload");
  click('[aria-label="Edit annotation"]');
  await waitFor(() => Boolean(document.querySelector('[aria-labelledby="annotation-modal-title"] textarea')), "Saved annotation did not reopen");
  assert(document.querySelector<HTMLTextAreaElement>('[aria-labelledby="annotation-modal-title"] textarea')?.value === "Saved browser fixture note", "Note was not retained");
  assert(document.querySelector<HTMLInputElement>('[aria-labelledby="annotation-modal-title"] input')?.value === "browser-fixture", "Tags were not retained");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await waitFor(() => !document.querySelector('[aria-labelledby="annotation-modal-title"]'), "Escape did not dismiss the saved dialog");
});
root.unmount();

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
