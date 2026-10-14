import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdateCheck, UpdateStatus } from "../../src/types";
import { createRequestHandler } from "../app";
import { createUpdateRoutes, type UpdateRouteOptions } from "./routes";
import { createMaintenanceHandler } from "./maintenance";

const stateDir = mkdtempSync(join(tmpdir(), "aiuo-update-routes-"));
process.on("exit", () => rmSync(stateDir, { recursive: true, force: true }));
const originalHosts = process.env.USAGE_OBSERVATORY_ALLOWED_HOSTS;
const originalRemote = process.env.USAGE_OBSERVATORY_REMOTE_UPDATES;
afterEach(() => {
  if (originalHosts === undefined) delete process.env.USAGE_OBSERVATORY_ALLOWED_HOSTS;
  else process.env.USAGE_OBSERVATORY_ALLOWED_HOSTS = originalHosts;
  if (originalRemote === undefined) delete process.env.USAGE_OBSERVATORY_REMOTE_UPDATES;
  else process.env.USAGE_OBSERVATORY_REMOTE_UPDATES = originalRemote;
});

const checkId = "0b7f8f8e-2f6a-4c2e-9d55-6f0d3b1b6c11";
const failingSnapshot = async () => { throw new Error("No snapshot for update routes"); };

function handler(options: Partial<UpdateRouteOptions> = {}) {
  const calls: Array<{ type: string; body?: unknown }> = [];
  const launcher = async (type: string, body?: unknown) => {
    calls.push({ type, body });
    if (type === "status") return { status: 200, body: { managed: true, mode: "prod", canApply: true, blockingReason: null, check: null, job: null } };
    if (type === "apply") return { status: 202, body: { job: { id: "job", checkId: (body as { checkId: string }).checkId } } };
    return { status: 409, body: { error: "job-active" } };
  };
  const routes = createUpdateRoutes({ port: 4318, stateDir, managed: true, launcher, inspect: async () => ({ id: checkId, state: "eligible" }) as UpdateCheck, ...options });
  const handle = createRequestHandler({ getSnapshot: failingSnapshot, refresh: failingSnapshot } as never, routes);
  return { calls, handle };
}

function post(handle: (request: Request) => Promise<Response>, action: string, body: unknown, headers: Record<string, string> = {}) {
  return handle(new Request(`http://127.0.0.1:4318/api/update/${action}`, {
    method: "POST",
    headers: { host: "127.0.0.1:4318", origin: "http://127.0.0.1:4318", "content-type": "application/json", "x-observatory-action": "update", ...headers },
    body: JSON.stringify(body),
  }));
}

describe("update route boundary", () => {
  test("rejects an unrelated loopback port, a missing Origin, and a missing action header", async () => {
    const { handle, calls } = handler();
    expect((await post(handle, "check", {}, { origin: "http://localhost:3000" })).status).toBe(403);
    const missingOrigin = await handle(new Request("http://127.0.0.1:4318/api/update/check", {
      method: "POST", headers: { host: "127.0.0.1:4318", "content-type": "application/json", "x-observatory-action": "update" }, body: "{}",
    }));
    expect(missingOrigin.status).toBe(403);
    expect((await post(handle, "check", {}, { "x-observatory-action": "" })).status).toBe(403);
    expect((await post(handle, "apply", { checkId: "not-a-uuid" })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  test("a remote origin may check but may not apply without opt-in", async () => {
    process.env.USAGE_OBSERVATORY_ALLOWED_HOSTS = "mac.tailnet.ts.net";
    const { handle, calls } = handler();
    const remote = { origin: "https://mac.tailnet.ts.net", host: "mac.tailnet.ts.net" };
    await post(handle, "check", {}, remote);
    expect(calls.map((call) => call.type)).toEqual(["check"]);
    const refused = await post(handle, "apply", { checkId }, remote);
    expect(refused.status).toBe(403);
    expect((await refused.json() as { error: string }).error).toBe("remote-apply-disabled");
    process.env.USAGE_OBSERVATORY_REMOTE_UPDATES = "1";
    expect((await post(handle, "apply", { checkId }, remote)).status).toBe(202);
  });

  test("managed requests forward the checkId and pass the launcher's status and body back", async () => {
    const { handle, calls } = handler();
    const busy = await post(handle, "check", {});
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: "job-active" });
    const applied = await post(handle, "apply", { checkId });
    expect(applied.status).toBe(202);
    expect(await applied.json()).toEqual({ job: { id: "job", checkId } });
    expect(calls.map((call) => call.type)).toEqual(["check", "apply"]);
    expect(calls[1]!.body).toEqual({ checkId });
    expect(applied.headers.get("cache-control")).toBe("no-store");
  });

  test("an unmanaged server checks locally and answers apply with 503 and manual commands", async () => {
    const { handle } = handler({ managed: false, mode: "unmanaged" });
    expect((await (await post(handle, "check", {})).json() as UpdateCheck).id).toBe(checkId);
    const apply = await post(handle, "apply", { checkId });
    expect(apply.status).toBe(503);
    expect((await apply.json() as { commands: string }).commands).toContain("bun run start");
    const status = await handle(new Request("http://127.0.0.1:4318/api/update/status", { headers: { host: "127.0.0.1:4318" } }));
    expect(await status.json()).toMatchObject({ managed: false, mode: "unmanaged", canApply: false, blockingReason: "unmanaged", check: { id: checkId } });
  });

  test("status needs no snapshot and marks remote hosts as restricted", async () => {
    process.env.USAGE_OBSERVATORY_ALLOWED_HOSTS = "mac.tailnet.ts.net";
    const { handle } = handler();
    const local = await handle(new Request("http://127.0.0.1:4318/api/update/status", { headers: { host: "127.0.0.1:4318" } }));
    expect(await local.json()).toMatchObject({ managed: true, canApply: true, blockingReason: null });
    const remote = await handle(new Request("http://mac.tailnet.ts.net/api/update/status", { headers: { host: "mac.tailnet.ts.net" } }));
    expect(await remote.json()).toMatchObject({ canApply: false, blockingReason: "remote-restricted" });
  });

  test("the version probe answers loopback hosts only", async () => {
    process.env.USAGE_OBSERVATORY_ALLOWED_HOSTS = "mac.tailnet.ts.net";
    const { handle } = handler();
    const local = await handle(new Request("http://127.0.0.1:4318/api/update/version", { headers: { host: "127.0.0.1:4318" } }));
    expect(await local.json()).toMatchObject({ pid: process.pid, protocol: 1 });
    const remote = await handle(new Request("http://mac.tailnet.ts.net/api/update/version", { headers: { host: "mac.tailnet.ts.net" } }));
    expect(remote.status).toBe(403);
  });
});

describe("maintenance server", () => {
  const status = { managed: true, mode: "prod", canApply: false, blockingReason: "job-active", maintenance: true, job: null } as unknown as UpdateStatus;
  const retried: string[] = [];
  const handle = createMaintenanceHandler({ port: 4318, status: () => status, retry: async (jobId) => { retried.push(jobId); return { status: 202, body: { ok: true } }; } });

  test("answers status, refuses other API calls, and serves a status page", async () => {
    const get = (path: string) => handle(new Request(`http://127.0.0.1:4318${path}`, { headers: { host: "127.0.0.1:4318" } }));
    expect(await (await get("/api/update/status")).json()).toMatchObject({ maintenance: true });
    expect((await get("/api/dashboard")).status).toBe(503);
    const page = await get("/");
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("/api/update/status");
    expect((await post(handle, "check", {})).status).toBe(409);
  });

  test("retry uses the same origin policy", async () => {
    expect((await post(handle, "retry", { jobId: checkId }, { origin: "http://localhost:3000" })).status).toBe(403);
    expect((await post(handle, "retry", { jobId: checkId })).status).toBe(202);
    expect(retried).toEqual([checkId]);
  });
});
