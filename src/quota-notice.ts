import type { QuotaProvider } from "./types";

/** A provider quota failure translated into what happened and what the user
 * should do about it. The quota-service error strings are producer-oriented
 * ("401 from oauth/usage — access token stale; will self-heal…"); the
 * Observatory is where a person decides whether to run a task, sign in again,
 * or simply wait, so the translation lives here. */
export type QuotaNotice = {
  provider: QuotaProvider["provider"];
  /** `wait` means no action is needed; `act` means the user must do something. */
  kind: "wait" | "act";
  /** What is wrong, in plain words. */
  headline: string;
  /** The concrete next step. */
  nextStep: string;
  /** The producer's raw message, for people who want the exact wording. */
  raw: string;
};

const CLAUDE_TOKEN_STALE =
  "Run any prompt in Claude Code. Claude Code refreshes the token and the quota service reads the new one on its next poll, usually within a minute. You only need to sign in again if Claude Code itself asks you to; then run /login inside Claude Code.";

function anthropicNotice(error: string): Pick<QuotaNotice, "kind" | "headline" | "nextStep"> {
  const text = error.toLowerCase();
  if (/\b401\b|access token stale|unauthori[sz]ed|token expired/.test(text)) {
    return {
      kind: "act",
      headline: "The Claude Code sign-in token the quota service uses has expired.",
      nextStep: CLAUDE_TOKEN_STALE,
    };
  }
  if (/keychain access denied/.test(text)) {
    return {
      kind: "act",
      headline: "macOS Keychain refused to hand the quota service your Claude Code credentials.",
      nextStep:
        "Open Keychain Access, find the “Claude Code-credentials” item, and allow the quota-service binary under Access Control. The next poll picks it up.",
    };
  }
  if (/keychain|claudeaioauth|credentials/.test(text)) {
    return {
      kind: "act",
      headline: "No Claude Code credentials were found on this machine.",
      nextStep:
        "Sign in to Claude Code with /login. The quota service reads the token Claude Code stores; it never signs in on its own.",
    };
  }
  if (/http 403\b/.test(text)) {
    return {
      kind: "act",
      headline: "Anthropic rejected the quota request for this account.",
      nextStep:
        "Sign out and back in to Claude Code with /login. If the 403 persists, the account may not expose usage data to this token.",
    };
  }
  if (/http 429\b/.test(text)) {
    return {
      kind: "wait",
      headline: "Anthropic is rate-limiting quota checks.",
      nextStep: "Nothing to do. The quota service retries on its normal cadence.",
    };
  }
  if (/http 5\d\d\b/.test(text)) {
    return {
      kind: "wait",
      headline: "Anthropic’s usage endpoint returned a server error.",
      nextStep: "Nothing to do. Retries are automatic; the last good reading stays on screen.",
    };
  }
  if (/timeout|timed out|fetch failed|econnrefused|enotfound|network|abort/.test(text)) {
    return {
      kind: "wait",
      headline: "The quota service could not reach Anthropic.",
      nextStep: "Check your network connection. Retries are automatic.",
    };
  }
  return {
    kind: "act",
    headline: "Anthropic quota is not being reported.",
    nextStep: "Check the quota service’s own status page for the underlying cause.",
  };
}

function codexNotice(error: string): Pick<QuotaNotice, "kind" | "headline" | "nextStep"> {
  const text = error.toLowerCase();
  if (/no access token|auth\.json/.test(text)) {
    return {
      kind: "act",
      headline: "No Codex CLI credentials were found on this machine.",
      nextStep: "Run codex login in a terminal. The quota service reads the token Codex stores.",
    };
  }
  if (/\b401\b|unauthori[sz]ed|token expired/.test(text)) {
    return {
      kind: "act",
      headline: "The Codex CLI token the quota service uses was rejected.",
      nextStep: "Run any Codex CLI prompt to refresh the token. If it still fails, run codex login.",
    };
  }
  if (/no rate_limits snapshot/.test(text)) {
    return {
      kind: "act",
      headline: "No recent Codex session has reported rate limits.",
      nextStep: "Run a Codex CLI task. The quota service reads limits from session rollouts, so it needs at least one recent one.",
    };
  }
  if (/http 429\b/.test(text)) {
    return {
      kind: "wait",
      headline: "OpenAI is rate-limiting quota checks.",
      nextStep: "Nothing to do. The quota service retries on its normal cadence.",
    };
  }
  if (/http 5\d\d\b/.test(text)) {
    return {
      kind: "wait",
      headline: "OpenAI’s rate-limit endpoint returned a server error.",
      nextStep: "Nothing to do. Retries are automatic.",
    };
  }
  if (/timeout|timed out|fetch failed|econnrefused|enotfound|network|abort/.test(text)) {
    return {
      kind: "wait",
      headline: "The quota service could not reach OpenAI.",
      nextStep: "Check your network connection. Retries are automatic.",
    };
  }
  return {
    kind: "act",
    headline: "OpenAI quota is not being reported.",
    nextStep: "Check the quota service’s own status page for the underlying cause.",
  };
}

function warpNotice(error: string): Pick<QuotaNotice, "kind" | "headline" | "nextStep"> {
  const text = error.toLowerCase();
  if (/not updated|may not be running|frozen/.test(text)) {
    return {
      kind: "act",
      headline: "Warp has not refreshed its usage file in over an hour.",
      nextStep: "Open Warp, or ignore this if you are not using it. The reading updates once Warp writes its preferences again.",
    };
  }
  return {
    kind: "act",
    headline: "Warp usage is not being reported.",
    nextStep: "Check that Warp is installed and has been opened at least once on this machine.",
  };
}

/** Returns guidance when a provider report carries an error and is not fully
 * current. A healthy report, or an unconfigured provider that never reported,
 * yields null so cards stay quiet. */
export function quotaProviderNotice(
  provider: QuotaProvider | null | undefined,
): QuotaNotice | null {
  if (!provider?.error || provider.status === "ok") return null;
  // "not configured" is the collector saying this provider is simply absent;
  // there is no step to take and the card is hidden elsewhere.
  if (provider.status === "unavailable" && /not configured/i.test(provider.error)) return null;
  const body =
    provider.provider === "anthropic"
      ? anthropicNotice(provider.error)
      : provider.provider === "codex"
        ? codexNotice(provider.error)
        : warpNotice(provider.error);
  return { provider: provider.provider, raw: provider.error, ...body };
}
