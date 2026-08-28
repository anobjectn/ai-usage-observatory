import { describe, expect, test } from "bun:test";
import { hostnameAllowed, parseAllowedHosts, requestHostAllowed, requestHostIsLoopback } from "./request-host";

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
