import { describe, expect, test } from "bun:test";
import { hostnameAllowed, parseAllowedHosts, requestHostAllowed, requestHostIsLoopback, requestOriginIsRemote, requestUpdateOriginAllowed } from "./request-host";

describe("request host boundary", () => {
  test("has no remote hosts without opt-in configuration", () => {
    expect(parseAllowedHosts("")).toEqual([]);
    expect(requestHostAllowed("mac.tailnet.ts.net", [])).toBe(false);
  });

  test("allows loopback hosts by default", () => {
    expect(requestHostAllowed("127.0.0.1:4318", [])).toBe(true);
    expect(requestHostAllowed("localhost:5173", [])).toBe(true);
    expect(requestHostAllowed("[::1]:4318", [])).toBe(true);
    expect(requestHostIsLoopback("localhost:4318")).toBe(true);
    expect(requestHostIsLoopback("mac.tailnet.ts.net")).toBe(false);
  });

  test("allows only explicitly configured remote hosts", () => {
    const hosts = parseAllowedHosts(" mac.tailnet.ts.net.,phone.tailnet.ts.net ");
    expect(hosts).toEqual(["mac.tailnet.ts.net", "phone.tailnet.ts.net"]);
    expect(requestHostAllowed("mac.tailnet.ts.net", hosts)).toBe(true);
    expect(hostnameAllowed("MAC.TAILNET.TS.NET.", hosts)).toBe(true);
    expect(requestHostAllowed("other.tailnet.ts.net", hosts)).toBe(false);
  });

  test("rejects URLs, ports, and wildcard entries", () => {
    expect(() => parseAllowedHosts("https://mac.tailnet.ts.net")).toThrow();
    expect(() => parseAllowedHosts("mac.tailnet.ts.net:5173")).toThrow();
    expect(() => parseAllowedHosts("*.tailnet.ts.net")).toThrow();
  });

  test("rejects malformed Host headers that parse as an allowed hostname", () => {
    const hosts = ["mac.tailnet.ts.net"];
    expect(requestHostAllowed("attacker@mac.tailnet.ts.net", hosts)).toBe(false);
    expect(requestHostAllowed("mac.tailnet.ts.net/path", hosts)).toBe(false);
  });
});

describe("update origin policy", () => {
  const headers = (values: Record<string, string>) => new Headers(values);
  test("only the app and Vite origins on loopback, and configured https hosts", () => {
    expect(requestUpdateOriginAllowed(headers({ origin: "http://127.0.0.1:4318" }), 4318, [])).toBe(true);
    expect(requestUpdateOriginAllowed(headers({ origin: "http://localhost:5173" }), 4318, [])).toBe(true);
    expect(requestUpdateOriginAllowed(headers({ origin: "http://localhost:3000" }), 4318, [])).toBe(false);
    expect(requestUpdateOriginAllowed(headers({ origin: "https://mac.tailnet.ts.net" }), 4318, ["mac.tailnet.ts.net"])).toBe(true);
    expect(requestUpdateOriginAllowed(headers({ origin: "http://mac.tailnet.ts.net" }), 4318, ["mac.tailnet.ts.net"])).toBe(false);
  });
  test("missing, null, malformed, and cross-site origins are rejected", () => {
    expect(requestUpdateOriginAllowed(headers({ host: "127.0.0.1:4318" }), 4318, [])).toBe(false);
    expect(requestUpdateOriginAllowed(headers({ origin: "null" }), 4318, [])).toBe(false);
    expect(requestUpdateOriginAllowed(headers({ origin: "http://127.0.0.1:4318/path" }), 4318, [])).toBe(false);
    expect(requestUpdateOriginAllowed(headers({ origin: "http://127.0.0.1:4318", "sec-fetch-site": "cross-site" }), 4318, [])).toBe(false);
  });
  test("remote origins are identified", () => {
    expect(requestOriginIsRemote(headers({ origin: "https://mac.tailnet.ts.net" }))).toBe(true);
    expect(requestOriginIsRemote(headers({ origin: "http://localhost:5173" }))).toBe(false);
  });
});
