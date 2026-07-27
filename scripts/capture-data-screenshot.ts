import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const screenshot = resolve(process.env.AIUO_SCREENSHOT_OUTPUT ?? "docs/screenshots/6.data-intelligence.png");
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const viewport = "1558,1072";
const baseUrl = process.env.AIUO_SCREENSHOT_URL ?? "http://127.0.0.1:5173";
const archiveVersion = process.argv[2];

if (archiveVersion) {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(archiveVersion)) {
    throw new Error(`Expected a release tag such as v1.5.0, received ${archiveVersion}.`);
  }
  const archive = resolve(`docs/screenshots/releases/${archiveVersion}/6.data-intelligence.png`);
  await mkdir(dirname(archive), { recursive: true });
  await copyFile(screenshot, archive);
  console.log(`Archived ${screenshot} to ${archive}`);
} else {
  const url = new URL(baseUrl);
  url.searchParams.set("view", "sources");
  const process = Bun.spawn([
    chrome,
    "--headless=new",
    "--incognito",
    "--hide-scrollbars",
    "--force-device-scale-factor=2",
    "--run-all-compositor-stages-before-draw",
    "--virtual-time-budget=5000",
    `--window-size=${viewport}`,
    `--screenshot=${screenshot}`,
    url.toString(),
  ]);
  if ((await process.exited) !== 0) throw new Error("Google Chrome could not capture the Data screenshot.");
  console.log(`Captured ${screenshot} at a ${viewport} CSS-pixel viewport.`);
}
