/**
 * Captures every view at three viewport widths, plus URL-reachable states, for
 * before/after comparison during design work. Reduced motion is forced so the
 * canvas scene does not invalidate diffs. Output: _temp/design-<label>/.
 *
 *   bun run scripts/capture-design-matrix.ts baseline
 *   AIUO_SCREENSHOT_URL=http://127.0.0.1:5173 bun run scripts/capture-design-matrix.ts step-3
 */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const label = process.argv[2];
if (!label) throw new Error("Usage: bun run scripts/capture-design-matrix.ts <label>");
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const baseUrl = process.env.AIUO_SCREENSHOT_URL ?? "http://127.0.0.1:5173";
const outDir = resolve(`_temp/design-${label}`);
await mkdir(outDir, { recursive: true });

const views = ["overview", "explorer", "sessions", "projects", "models", "sources"];
const widths: Array<[number, number]> = [[1440, 2400], [1024, 2400], [390, 3000]];
const states: Array<[string, string]> = [
  ["models-open", "view=models&model=claude-opus-5"],
];

const jobs: Array<{ name: string; query: string; width: number; height: number }> = [];
for (const view of views) for (const [width, height] of widths) jobs.push({ name: `${view}-${width}`, query: `view=${view}`, width, height });
for (const [name, query] of states) jobs.push({ name: `${name}-1440`, query, width: 1440, height: 2400 });

for (const job of jobs) {
  const url = `${baseUrl}/?${job.query}`;
  const proc = Bun.spawn([
    chrome,
    "--headless=new",
    "--incognito",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--force-prefers-reduced-motion",
    "--run-all-compositor-stages-before-draw",
    "--virtual-time-budget=10000",
    `--window-size=${job.width},${job.height}`,
    `--screenshot=${outDir}/${job.name}.png`,
    url,
  ], { stdout: "ignore", stderr: "ignore" });
  if ((await proc.exited) !== 0) throw new Error(`Chrome failed on ${job.name}`);
  console.log(`captured ${job.name}`);
}
console.log(`Wrote ${jobs.length} captures to ${outDir}`);
