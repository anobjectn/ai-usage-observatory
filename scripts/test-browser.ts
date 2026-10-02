import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createSocketServer } from "node:net";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { dashboardFixture } from "../tests/fixtures/dashboard";

// Set every local source before the server modules resolve their database paths.
const directory = mkdtempSync(join(tmpdir(), "aiuo-browser-tests-"));
process.env.USAGE_OBSERVATORY_DB = join(directory, "data.db");
process.env.QUOTA_DB_PATH = join(directory, "missing-quota.db");
process.env.WARP_DB_PATH = join(directory, "missing-warp.db");
process.env.QUOTA_SERVICE_URL = "http://127.0.0.1:1";
process.env.QUOTA_SERVICE_ENABLED = "0";
process.env.USAGE_OBSERVATORY_OFFLINE_PRICING = "1";
const { createRequestHandler } = await import("../server/app");
const { db, getAnnotation, getSettings, listRules } = await import("../server/store");
const { requestOriginAllowed } = await import("../server/request-host");
const snapshot = dashboardFixture();
let offline = false;
const read = async () => ({
  ...snapshot, rules: listRules(), settings: getSettings(),
  sessions: snapshot.sessions.map((session) => ({ ...session, annotation: getAnnotation(session.sessionId) })),
}) as unknown as Awaited<ReturnType<typeof import("../server/collector").getSnapshot>>;
const handler = createRequestHandler({ getSnapshot: read, refresh: read });
type Result = { passed: string[]; failed: string[] };
let finish!: (value: Result) => void;
const completed = new Promise<Result>((resolve) => { finish = resolve; });
const api = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/__browser-test/")) {
      if (path === "/__browser-test/ready" && request.method === "GET") return Response.json({ isolatedFixture: true });
      if (request.method !== "POST" || !requestOriginAllowed(request.headers)) return new Response(null, { status: 403 });
      if (path === "/__browser-test/state") {
        const { state } = await request.json() as { state: string };
        offline = state === "offline";
        snapshot.refresh = { inProgress: false, stale: state === "stale", lastError: state === "stale" ? "Fixture collection failed" : null };
        return Response.json({ ok: true });
      }
      if (path === "/__browser-test/result") {
        const result = await request.json() as Result;
        // Let the result response reach the browser before stopping the fixture listener.
        setTimeout(() => finish(result), 100);
        return Response.json({ ok: true });
      }
      return new Response(null, { status: 404 });
    }
    if (offline && path === "/api/dashboard") return Response.json({ error: "Fixture server unavailable" }, { status: 503 });
    return handler(request);
  },
});
const reservation = createSocketServer();
await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const testPort = (reservation.address() as import("node:net").AddressInfo).port;
await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
const vite = await createServer({
  configFile: false, cacheDir: join(directory, "vite-cache"), plugins: [react()],
  server: { host: "127.0.0.1", port: testPort, strictPort: true, proxy: {
    "/api": { target: `http://127.0.0.1:${api.port}`, changeOrigin: true },
    "/__browser-test": { target: `http://127.0.0.1:${api.port}`, changeOrigin: true },
  } },
});
const cleanup = async () => {
  api.stop(true);
  // Bun can retain Vite shutdown work after all browser checks have finished.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([vite.close(), new Promise<void>((resolve) => { timer = setTimeout(resolve, 1500); })]);
  } finally { clearTimeout(timer); }
  db.close();
  rmSync(directory, { recursive: true, force: true });
};
process.once("SIGINT", () => finish({ passed: [], failed: ["Interrupted"] }));
process.once("SIGTERM", () => finish({ passed: [], failed: ["Interrupted"] }));
try {
  await vite.listen();
  console.log(`Open ${vite.resolvedUrls!.local[0]}browser-tests.html to run browser regressions against temporary data.`);
  const result = await completed;
  for (const name of result.passed) console.log(`PASS ${name}`);
  for (const error of result.failed) console.error(`FAIL ${error}`);
  console.log(`${result.passed.length} browser checks passed; ${result.failed.length} failed.`);
  process.exitCode = result.failed.length ? 1 : 0;
} finally { await cleanup(); }
// Terminate only this fixture process after its listeners and temporary data are cleaned up.
process.exit(process.exitCode ?? 0);
