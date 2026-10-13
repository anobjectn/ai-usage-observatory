import { createRoot } from "react-dom/client";
import { useCallback } from "react";
import { App } from "../../src/App";
import { quotaRetryDelaysMs, useSessionQuotaContexts } from "../../src/hooks/use-session-quota-contexts";
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
status.textContent = `${result.passed.length} passed; ${result.failed.length} failed. ${result.failed.join("; ")}`;
document.title = result.failed.length ? "Browser regressions failed" : "Browser regressions passed";
await fetch("/__browser-test/result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(result) });
