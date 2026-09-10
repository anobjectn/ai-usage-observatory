import { expect, test } from "bun:test";
import { quotaProviderNotice } from "./quota-notice";
import type { QuotaProvider } from "./types";

function report(overrides: Partial<QuotaProvider>): QuotaProvider {
  return {
    provider: "anthropic",
    status: "stale",
    source: "anthropic_api",
    snapshot: null,
    ...overrides,
  };
}

test("a healthy report or an unconfigured provider yields no notice", () => {
  expect(quotaProviderNotice(undefined)).toBeNull();
  expect(quotaProviderNotice(report({ status: "ok", error: "leftover" }))).toBeNull();
  expect(quotaProviderNotice(report({ status: "stale" }))).toBeNull();
  expect(
    quotaProviderNotice(report({ provider: "codex", status: "unavailable", error: "not configured" })),
  ).toBeNull();
});

test("a stale Claude Code token tells the user to run a Claude Code prompt, not to log in", () => {
  const notice = quotaProviderNotice(
    report({
      error:
        "401 from oauth/usage — access token stale; will self-heal on next Claude Code use (no self-refresh by design)",
    }),
  );
  expect(notice?.kind).toBe("act");
  expect(notice?.headline).toContain("expired");
  expect(notice?.nextStep).toContain("Run any prompt in Claude Code");
  expect(notice?.nextStep).toContain("/login");
  expect(notice?.raw).toContain("401 from oauth/usage");
});

test("missing Claude Code credentials point at /login", () => {
  const notice = quotaProviderNotice(
    report({
      status: "unavailable",
      error: 'keychain item "Claude Code-credentials" has no claudeAiOauth.accessToken (config error, not a crash)',
    }),
  );
  expect(notice?.kind).toBe("act");
  expect(notice?.nextStep).toContain("/login");
});

test("keychain denial is distinguished from missing credentials", () => {
  const notice = quotaProviderNotice(
    report({
      status: "unavailable",
      error: "keychain access denied (grant access to the quota-service binary and retry)",
    }),
  );
  expect(notice?.headline).toContain("Keychain");
  expect(notice?.nextStep).toContain("Keychain Access");
});

test("server errors and rate limits need no action", () => {
  expect(quotaProviderNotice(report({ status: "unavailable", error: "oauth/usage HTTP 503" }))?.kind).toBe("wait");
  expect(quotaProviderNotice(report({ status: "unavailable", error: "oauth/usage HTTP 429" }))?.kind).toBe("wait");
  expect(quotaProviderNotice(report({ status: "unavailable", error: "fetch failed" }))?.kind).toBe("wait");
});

test("Codex notices name the Codex CLI", () => {
  const missing = quotaProviderNotice(
    report({ provider: "codex", status: "unavailable", error: "no access token in ~/.codex/auth.json" }),
  );
  expect(missing?.nextStep).toContain("codex login");
  const noSnapshot = quotaProviderNotice(
    report({ provider: "codex", status: "unavailable", error: "no rate_limits snapshot found in recent session rollouts" }),
  );
  expect(noSnapshot?.nextStep).toContain("Codex CLI task");
});

test("a frozen Warp plist suggests opening Warp", () => {
  const notice = quotaProviderNotice(
    report({
      provider: "warp",
      status: "stale",
      error: "plist not updated in over an hour — Warp may not be running; value may be frozen",
    }),
  );
  expect(notice?.headline).toContain("Warp");
  expect(notice?.nextStep).toContain("Open Warp");
});
