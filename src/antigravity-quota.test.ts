import { describe, expect, test } from "bun:test";
import {
  ALL_GEMINI_IDENTITY,
  IMAGE_GENERATION_IDENTITY,
  NO_MODEL_IDENTITY,
  canonicalModelId,
  coerceWindowIdentity,
  windowIdentity,
  windowLimitsAny,
  windowLimitsModel,
  windowScopeLabel,
} from "./antigravity-quota";

describe("Antigravity window identity", () => {
  test("stored records read back exactly as quota-service writes them, and fail closed otherwise", () => {
    expect(coerceWindowIdentity({ model: "gemini-4-argon", family: "gemini" })).toEqual({ model: "gemini-4-argon", family: "gemini" });
    expect(coerceWindowIdentity({ model: null, family: null })).toBe(NO_MODEL_IDENTITY);
    expect(coerceWindowIdentity({ model: null, family: "image" })).toBe(IMAGE_GENERATION_IDENTITY);
    // A non-canonical model, a wrong family, a display name, or an old family scope never narrows.
    expect(coerceWindowIdentity({ model: "gemini-4-neon-high", family: "gemini" })).toBe(ALL_GEMINI_IDENTITY);
    expect(coerceWindowIdentity({ model: "gemini-4-argon", family: null })).toBe(ALL_GEMINI_IDENTITY);
    expect(coerceWindowIdentity({ model: "Gemini 4 Argon", family: "gemini" })).toBe(ALL_GEMINI_IDENTITY);
    expect(coerceWindowIdentity({ model: null, family: "gemini-4" })).toBe(ALL_GEMINI_IDENTITY);
    expect(coerceWindowIdentity(undefined)).toBe(ALL_GEMINI_IDENTITY);
    expect(coerceWindowIdentity([])).toBe(ALL_GEMINI_IDENTITY);
    expect(windowIdentity({ a: { model: null, family: null } }, "missing")).toBe(ALL_GEMINI_IDENTITY);
    expect(windowIdentity({ a: { model: null, family: null } }, "toString")).toBe(ALL_GEMINI_IDENTITY);
  });

  test("model ids lose one prefix and one suffix, display names are not ids", () => {
    expect(canonicalModelId("models/gemini-4-argon-001")).toBe("gemini-4-argon");
    expect(canonicalModelId("gemini-4-neon-high")).toBe("gemini-4-neon");
    expect(canonicalModelId("Gemini 4 Neon")).toBeNull();
    expect(canonicalModelId("MODEL_PLACEHOLDER_M532")).toBeNull();
  });

  test("an exact window limits only its model, the partner pool only partner models", () => {
    const argon = { model: "gemini-4-argon", family: "gemini" };
    expect(windowLimitsModel(argon, "gemini-4-argon")).toBe(true);
    expect(windowLimitsModel(argon, "gemini-4-neon")).toBe(false);
    expect(windowLimitsModel(NO_MODEL_IDENTITY, "gemini-4-neon")).toBe(false);
    expect(windowLimitsModel(NO_MODEL_IDENTITY, "claude-opus-5-5")).toBe(true);
    expect(windowLimitsModel(IMAGE_GENERATION_IDENTITY, "gemini-4-neon")).toBe(false);
    expect(windowLimitsModel(ALL_GEMINI_IDENTITY, "gemini-4-neon")).toBe(true);
    expect(windowLimitsModel(ALL_GEMINI_IDENTITY, "Unknown model")).toBe(true);
    expect(windowLimitsAny(ALL_GEMINI_IDENTITY, [])).toBe(true);
    expect(windowLimitsAny(argon, ["gemini-4-neon", "gemini-4-argon"])).toBe(true);
  });

  test("with no models known, every Gemini text window is kept and only the partner and image pools drop", () => {
    expect(windowLimitsAny({ model: "gemini-4-neon", family: "gemini" }, [])).toBe(true);
    expect(windowLimitsAny({ model: "gemini-4-argon", family: "gemini" }, [])).toBe(true);
    expect(windowLimitsAny(ALL_GEMINI_IDENTITY, [])).toBe(true);
    expect(windowLimitsAny(NO_MODEL_IDENTITY, [])).toBe(false);
    expect(windowLimitsAny(IMAGE_GENERATION_IDENTITY, [])).toBe(false);
  });

  test("each window states what it limits", () => {
    expect(windowScopeLabel({ model: "gemini-4-argon", family: "gemini" })).toBe("Limits: Gemini 4 Argon");
    expect(windowScopeLabel(NO_MODEL_IDENTITY)).toBe("Limits: partner models");
    expect(windowScopeLabel(IMAGE_GENERATION_IDENTITY)).toBe("Limits: image generation");
    expect(windowScopeLabel(ALL_GEMINI_IDENTITY)).toBe("Limits: all Gemini models");
  });
});
