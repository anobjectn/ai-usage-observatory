/**
 * Records the computed styles of every element (and painted ::before/::after) in each view, so
 * token and theme work can prove which declarations changed. Runs its own headless Chrome with a
 * throwaway profile; it only reads from the app server.
 *
 *   bun run scripts/capture-style-snapshot.ts capture before
 *   bun run scripts/capture-style-snapshot.ts capture after
 *   bun run scripts/capture-style-snapshot.ts diff before after
 *
 * Output: _temp/style-snapshots/<label>.json. Environment: AIUO_SCREENSHOT_URL (default
 * http://127.0.0.1:5173), AIUO_SNAPSHOT_STATES ("name=query;name=query" extra URL states).
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Snapshot = Record<string, Record<string, Record<string, string>>>;

const outDir = resolve("_temp/style-snapshots");
const [command, ...args] = process.argv.slice(2);

const properties = [
  "color", "background-color", "background-image", "border-top-color", "border-right-color",
  "border-bottom-color", "border-left-color", "outline-color", "box-shadow", "text-shadow",
  "text-decoration-color", "fill", "stroke", "filter", "opacity", "font-family", "font-size",
  "font-weight", "border-top-left-radius", "padding-top", "padding-right", "padding-bottom",
  "padding-left", "margin-top", "margin-right", "margin-bottom", "margin-left", "row-gap",
  "column-gap", "width", "height",
];

// Runs in the page: keys are stable DOM paths built from tag, sorted classes, and the index among
// siblings with the same tag and classes.
const collector = (props: string[]) => {
  const result: Record<string, Record<string, string>> = {};
  const keyOf = (el: Element): string => {
    const parts: string[] = [];
    for (let node: Element | null = el; node && node !== document.documentElement; node = node.parentElement) {
      const cls = [...node.classList].sort().join(".");
      const sig = `${node.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`;
      const parent = node.parentElement;
      const same = parent ? [...parent.children].filter((child) =>
        child.tagName === node!.tagName && [...child.classList].sort().join(".") === cls) : [];
      parts.unshift(same.length > 1 ? `${sig}[${same.indexOf(node)}]` : sig);
    }
    return parts.join(">");
  };
  const read = (style: CSSStyleDeclaration) =>
    Object.fromEntries(props.map((prop) => [prop, style.getPropertyValue(prop)]));
  for (const el of document.querySelectorAll("body *")) {
    const key = keyOf(el);
    result[key] = read(getComputedStyle(el));
    for (const pseudo of ["::before", "::after"]) {
      const style = getComputedStyle(el, pseudo);
      if (style.content && style.content !== "none") result[`${key}${pseudo}`] = read(style);
    }
  }
  return result;
};

async function capture(label: string) {
  const baseUrl = process.env.AIUO_SCREENSHOT_URL ?? "http://127.0.0.1:5173";
  const states: Array<[string, string]> = [
    ...["overview", "explorer", "sessions", "projects", "models", "sources"].map((view): [string, string] => [view, `view=${view}`]),
    ["models-open", "view=models&model=claude-opus-5"],
    ...(process.env.AIUO_SNAPSHOT_STATES ?? "").split(";").filter(Boolean)
      .map((pair): [string, string] => pair.split("=", 2).length === 2
        ? [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)] : [pair, pair]),
  ];
  const profile = await mkdtemp(join(tmpdir(), "aiuo-snapshot-"));
  const port = 9300 + Math.floor(Math.random() * 500);
  const chrome = Bun.spawn([
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--hide-scrollbars", "--force-device-scale-factor=1", "--force-prefers-reduced-motion",
    "--window-size=1440,2400", "about:blank",
  ], { stdout: "ignore", stderr: "ignore" });
  try {
    let wsUrl = "";
    for (let attempt = 0; attempt < 50 && !wsUrl; attempt++) {
      await Bun.sleep(200);
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
        wsUrl = targets.find((target) => target.type === "page")?.webSocketDebuggerUrl ?? "";
      } catch {}
    }
    if (!wsUrl) throw new Error("Chrome did not expose a page target");
    const socket = new WebSocket(wsUrl);
    await new Promise((done) => socket.addEventListener("open", done, { once: true }));
    let nextId = 1;
    const pending = new Map<number, (value: any) => void>();
    const events: Array<(message: any) => void> = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && pending.has(message.id)) { pending.get(message.id)!(message); pending.delete(message.id); }
      else events.forEach((listener) => listener(message));
    });
    const send = (method: string, params: object = {}) => new Promise<any>((done) => {
      const id = nextId++;
      pending.set(id, done);
      socket.send(JSON.stringify({ id, method, params }));
    });
    await send("Page.enable");
    const snapshot: Snapshot = {};
    for (const [name, query] of states) {
      const loaded = new Promise((done) => events.push((message) => { if (message.method === "Page.loadEventFired") done(null); }));
      await send("Page.navigate", { url: `${baseUrl}/?${query}` });
      await loaded;
      events.length = 0;
      // Wait for the dashboard payload to render, then let charts settle.
      for (let attempt = 0; attempt < 60; attempt++) {
        const ready = await send("Runtime.evaluate", { expression: "!!document.querySelector('main .panel, main .metric-card, main table')", returnByValue: true });
        if (ready.result?.result?.value) break;
        await Bun.sleep(500);
      }
      // Session details fetch their own payload after the table renders.
      await Bun.sleep(query.includes("session=") ? 7000 : 2500);
      const response = await send("Runtime.evaluate", {
        expression: `(${collector.toString()})(${JSON.stringify(properties)})`,
        returnByValue: true,
      });
      if (response.result?.exceptionDetails) throw new Error(`${name}: ${JSON.stringify(response.result.exceptionDetails)}`);
      snapshot[name] = response.result.result.value;
      console.log(`captured ${name}: ${Object.keys(snapshot[name]).length} nodes`);
    }
    socket.close();
    await mkdir(outDir, { recursive: true });
    await Bun.write(join(outDir, `${label}.json`), JSON.stringify(snapshot));
    console.log(`Wrote ${join(outDir, `${label}.json`)}`);
  } finally {
    chrome.kill();
    await chrome.exited;
    await rm(profile, { recursive: true, force: true });
  }
}

async function diff(beforeLabel: string, afterLabel: string) {
  const before: Snapshot = await Bun.file(join(outDir, `${beforeLabel}.json`)).json();
  const after: Snapshot = await Bun.file(join(outDir, `${afterLabel}.json`)).json();
  const groups = new Map<string, { count: number; samples: string[] }>();
  let compared = 0;
  for (const state of Object.keys(before)) {
    const a = before[state], b = after[state] ?? {};
    const shared = Object.keys(a).filter((key) => key in b);
    const onlyA = Object.keys(a).length - shared.length, onlyB = Object.keys(b).length - shared.length;
    console.log(`${state}: ${shared.length} shared nodes, ${onlyA} only before, ${onlyB} only after`);
    for (const key of shared) {
      compared++;
      for (const prop of Object.keys(a[key])) {
        if (a[key][prop] === b[key][prop]) continue;
        const group = `${prop}: ${a[key][prop]}  →  ${b[key][prop]}`;
        const entry = groups.get(group) ?? { count: 0, samples: [] };
        entry.count++;
        if (entry.samples.length < 2) entry.samples.push(`${state} ${key.split(">").slice(-2).join(">")}`);
        groups.set(group, entry);
      }
    }
  }
  const sorted = [...groups].sort((x, y) => y[1].count - x[1].count);
  console.log(`\n${compared} nodes compared, ${sorted.length} distinct changes\n`);
  for (const [group, { count, samples }] of sorted) console.log(`${String(count).padStart(5)}  ${group}\n         e.g. ${samples.join(" | ")}`);
}

if (command === "capture" && args[0]) await capture(args[0]);
else if (command === "diff" && args[0] && args[1]) await diff(args[0], args[1]);
else throw new Error("Usage: capture <label> | diff <before> <after>");
