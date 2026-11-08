import { describe, expect, test } from "bun:test";
import { createBenchmarkStatus } from "./benchmark-status";
import { BENCHMARK_SITES } from "../src/benchmark-sites";

const respond = (status: number, statusText = "") => async () => new Response("", { status, statusText });

describe("benchmark reachability", () => {
  test("a 2xx page is ok and an error status is unreachable with its reason", async () => {
    const fetchImpl = async (url: string) => (url.includes("aicharts") ? respond(404, "Not Found")() : respond(200)());
    const rows = await createBenchmarkStatus(fetchImpl)();
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(byId.slopalytics).toMatchObject({ state: "ok", httpStatus: 200, reason: null });
    expect(byId.aicharts).toMatchObject({ state: "unreachable", httpStatus: 404, reason: "HTTP 404 Not Found" });
  });

  test("a server error and a failed connection are both unreachable", async () => {
    expect((await createBenchmarkStatus(respond(503))())[0]).toMatchObject({ state: "unreachable", httpStatus: 503, reason: "HTTP 503" });
    const offline = createBenchmarkStatus(async () => { throw new TypeError("fetch failed"); });
    expect((await offline())[0]).toMatchObject({ state: "unreachable", httpStatus: null, reason: "Could not connect" });
  });

  test("probes once per site and reuses the result until it is ten minutes old", async () => {
    let calls = 0;
    let clock = 0;
    const status = createBenchmarkStatus(async () => { calls++; return new Response("", { status: 200 }); }, () => clock);
    await status();
    await status();
    expect(calls).toBe(BENCHMARK_SITES.length);
    clock = 10 * 60_000 + 1;
    await status();
    expect(calls).toBe(BENCHMARK_SITES.length * 2);
  });
});
