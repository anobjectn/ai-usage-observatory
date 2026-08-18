import { expect, test } from "bun:test";
import { canonicalModelName } from "./model-name";

test("ccusage model ids are already canonical", () => {
  for (const id of [
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
    "gpt-5.5",
    "gpt-5.6-sol",
    "gpt-5.6-luna",
    "gpt-5.4-mini",
    "gpt-5.3-codex",
  ]) expect(canonicalModelName(id)).toBe(id);
});

test("Warp display names collapse onto the ccusage id", () => {
  expect(canonicalModelName("Claude Opus 5")).toBe("claude-opus-5");
  expect(canonicalModelName("Claude Sonnet 5")).toBe("claude-sonnet-5");
  expect(canonicalModelName("Claude Fable 5 (xhigh)")).toBe("claude-fable-5");
  expect(canonicalModelName("GPT-5.5 (high reasoning)")).toBe("gpt-5.5");
  expect(canonicalModelName("GPT-5.6 Luna (extra high reasoning)")).toBe("gpt-5.6-luna");
  expect(canonicalModelName("GPT-5.3 Codex (low reasoning)")).toBe("gpt-5.3-codex");
});

test("Warp's older slugs collapse onto the same id as its display names", () => {
  const pairs: Array<[string, string]> = [
    ["claude-4-8-opus-xhigh", "Claude Opus 4.8 (xhigh)"],
    ["claude-4-6-opus-max", "Claude Opus 4.6 (max)"],
    ["claude-4-5-sonnet-thinking", "claude 4.5 sonnet (thinking)"],
    ["claude-5-fable-high", "Claude Fable 5"],
    ["gpt-5-5-medium", "GPT-5.5 (medium reasoning)"],
    ["gpt-5-6-sol-high", "GPT-5.6 Sol (high reasoning)"],
    ["gpt-5-2-codex-xhigh", "GPT-5.2 Codex (extra high reasoning)"],
    ["grok-4-3-medium", "Grok 4.3 (medium reasoning)"],
  ];
  for (const [slug, display] of pairs) expect(canonicalModelName(slug)).toBe(canonicalModelName(display));
  expect(canonicalModelName("claude-4-8-opus-xhigh")).toBe("claude-opus-4-8");
  expect(canonicalModelName("gpt-5-6-sol-high")).toBe("gpt-5.6-sol");
});

test("a model whose name ends in max keeps it when it is part of the model", () => {
  expect(canonicalModelName("gpt-5.1 codex max (low reasoning)")).toBe("gpt-5.1-codex-max");
  expect(canonicalModelName("gpt-5-1-codex-max-low")).toBe("gpt-5.1-codex-max");
});

test("names that are not models are kept verbatim", () => {
  expect(canonicalModelName("auto")).toBe("auto");
  expect(canonicalModelName("auto-genius")).toBe("auto-genius");
  expect(canonicalModelName("")).toBe("");
});

test("unrecognized vendors still get one stable spelling", () => {
  expect(canonicalModelName("Gemini 3 Flash")).toBe("gemini-3-flash");
  expect(canonicalModelName("gemini 2.5 flash")).toBe("gemini-2.5-flash");
});
