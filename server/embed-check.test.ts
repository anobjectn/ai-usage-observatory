import { expect, test } from "bun:test";
import { embedVerdict, frameSrcOrigins } from "./embed-check";

const origins = ["http://127.0.0.1:4318", "http://localhost:4318"];
const verdict = (headers: Record<string, string>) => embedVerdict(new Headers(headers), origins);

test("a page with no framing headers can be embedded", () => {
  expect(verdict({})).toEqual({ embeddable: true, reasons: [] });
});

test("X-Frame-Options DENY and SAMEORIGIN block embedding", () => {
  for (const value of ["DENY", "sameorigin", " SAMEORIGIN "]) {
    const result = verdict({ "x-frame-options": value });
    expect(result.embeddable).toBe(false);
    expect(result.reasons[0]).toContain("X-Frame-Options");
  }
});

test("frame-ancestors decides the verdict, and a list that omits the app blocks it", () => {
  const blocked = verdict({ "content-security-policy": "frame-ancestors 'self' https://us.posthog.com", "x-frame-options": "SAMEORIGIN" });
  expect(blocked.embeddable).toBe(false);
  expect(blocked.reasons[0]).toContain("frame-ancestors");
  expect(verdict({ "content-security-policy": "frame-ancestors 'none'" }).embeddable).toBe(false);
});

test("frame-ancestors that names the app, or allows any origin, permits embedding even beside X-Frame-Options", () => {
  for (const policy of ["frame-ancestors *", "frame-ancestors http://127.0.0.1:4318 http://localhost:4318", "frame-ancestors http:"]) {
    expect(verdict({ "content-security-policy": policy, "x-frame-options": "DENY" }).embeddable).toBe(true);
  }
  expect(verdict({ "content-security-policy": "frame-ancestors http://localhost:4318" }).embeddable).toBe(false);
});

test("a policy without frame-ancestors leaves X-Frame-Options in charge", () => {
  expect(verdict({ "content-security-policy": "default-src 'self'" }).embeddable).toBe(true);
  expect(verdict({ "content-security-policy": "default-src 'self'", "x-frame-options": "DENY" }).embeddable).toBe(false);
});

test("frameSrcOrigins lists the http(s) sources of the frame-src directive", () => {
  expect(frameSrcOrigins("default-src 'none'; frame-src https://a.test https://b.test 'self'; base-uri 'none'")).toEqual(["https://a.test", "https://b.test"]);
  expect(frameSrcOrigins("default-src 'none'")).toEqual([]);
});
