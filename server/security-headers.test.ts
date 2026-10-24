import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createRequestHandler } from "./app";
import { createMaintenanceHandler } from "./update/maintenance";
import { securityHeaders } from "./security-headers";
import { BENCHMARK_SITES } from "../src/components/benchmark-launcher";

test("app responses, including errors and updater routes, prevent framing and restrict resources", async () => {
  const handle = createRequestHandler();
  for (const [path, host] of [["/", "localhost"], ["/api/settings", "localhost"], ["/api/settings", "attacker.invalid"], ["/api/update/version", "localhost"]]) {
    const response = await handle(new Request(`http://localhost:4318${path}`, { headers: { host } }));
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const policy = response.headers.get("content-security-policy")!;
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("connect-src 'self';");
    expect(policy).toContain("script-src 'self';");
    expect(policy).toContain("img-src 'self' data:;");
    expect(policy).toContain("object-src 'none'");
    for (const site of BENCHMARK_SITES) expect(policy).toContain(new URL(site.url).origin);
  }
});

test("maintenance permits only its exact inline polling script", async () => {
  const handle = createMaintenanceHandler({ port: 4318, status: () => ({}) as never, retry: async () => ({ status: 200, body: {} }) });
  const response = await handle(new Request("http://localhost:4318/", { headers: { host: "localhost" } }));
  const html = await response.text();
  const script = html.split("<script>")[1]!.split("</script>")[0]!;
  const hash = createHash("sha256").update(script).digest("base64");
  expect(response.headers.get("content-security-policy")).toContain(`script-src 'self' 'sha256-${hash}';`);
  expect(response.headers.get("x-frame-options")).toBe("DENY");
});

test("development allows React refresh and local HMR without permitting remote connections", () => {
  const policy = securityHeaders({ development: true })["Content-Security-Policy"];
  expect(policy).toContain("script-src 'self' 'unsafe-inline';");
  expect(policy).toContain("connect-src 'self' ws://localhost:5173 ws://127.0.0.1:5173;");
});

test("all benchmark icons are vendored local assets", async () => {
  for (const site of BENCHMARK_SITES) {
    expect(site.favicon).toStartWith("/benchmarks/");
    expect(await Bun.file(`public${site.favicon}`).exists()).toBe(true);
  }
});
