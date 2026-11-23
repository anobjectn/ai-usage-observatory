/**
 * Which models an Antigravity quota window limits.
 *
 * quota-service stores one identity per `modelWindows` entry in
 * `snapshot.extra.modelWindowIdentity`, keyed by window name. This module reads that record with
 * the same fail-closed rule quota-service uses (`src/model-identity.ts` there). It is a copy, not
 * an import: the two repositories release separately, so the rule is mirrored and both sides
 * keep their own tests.
 *
 * - A window with an exact model id limits only that model ("gemini-4-argon" never limits
 *   "gemini-4-neon").
 * - `{model: null, family: null}` is the partner pool ("Claude and GPT models"): it limits no
 *   Gemini model.
 * - `{model: null, family: "image"}` is an image pool: it limits no Gemini text model.
 * - Anything else, a missing record included, limits every Gemini text model.
 */

export type WindowIdentity = { model: string | null; family: string | null };

export const NO_MODEL_IDENTITY: WindowIdentity = Object.freeze({ model: null, family: null });
export const ALL_GEMINI_IDENTITY: WindowIdentity = Object.freeze({ model: null, family: "gemini" });
export const IMAGE_GENERATION_IDENTITY: WindowIdentity = Object.freeze({ model: null, family: "image" });

const MODEL_ID_RE = /^(?:gemini|imagen|claude|gpt)-[a-z0-9][a-z0-9.-]*$/;
const IMAGE_MODEL_ID_RE = /^imagen-|-image(?:-preview)?$/;
const RESOURCE_PREFIX_RE =
  /^(?:projects\/[a-z0-9._-]+\/(?:locations\/[a-z0-9._-]+\/)?(?:publishers\/[a-z0-9._-]+\/)?)?models\//;
const EFFORT_SUFFIX_RE = /-(?:minimal|low|medium|high|xhigh)$/;
const RELEASE_SUFFIX_RE = /-\d{3}$/;

/** The canonical form of an API model id, or null when the value is not one. Display names
 * ("Gemini 4 Argon") and opaque ids are not model ids. */
export function canonicalModelId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim().toLowerCase().replace(RESOURCE_PREFIX_RE, "");
  if (!MODEL_ID_RE.test(id)) return null;
  const stripped = EFFORT_SUFFIX_RE.test(id) ? id.replace(EFFORT_SUFFIX_RE, "") : id.replace(RELEASE_SUFFIX_RE, "");
  if (!MODEL_ID_RE.test(stripped) || EFFORT_SUFFIX_RE.test(stripped) || RELEASE_SUFFIX_RE.test(stripped)) return null;
  return stripped;
}

function modelIdFamily(id: string): string | null {
  if (IMAGE_MODEL_ID_RE.test(id)) return "image";
  return id.startsWith("gemini-") ? "gemini" : null;
}

export function modelIdIdentity(value: string | null | undefined): WindowIdentity {
  const id = canonicalModelId(value);
  return id === null ? NO_MODEL_IDENTITY : { model: id, family: modelIdFamily(id) };
}

/** Reads one stored identity record, failing closed exactly as quota-service's
 * `coerceModelIdentity` does. */
export function coerceWindowIdentity(raw: unknown): WindowIdentity {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return ALL_GEMINI_IDENTITY;
  const { model, family } = raw as { model?: unknown; family?: unknown };
  if (model === null && family === null) return NO_MODEL_IDENTITY;
  if (typeof model === "string") {
    const stored = model.trim().toLowerCase();
    const identity = modelIdIdentity(stored);
    return identity.model === stored && family === identity.family ? identity : ALL_GEMINI_IDENTITY;
  }
  if (model === null && family === IMAGE_GENERATION_IDENTITY.family) return IMAGE_GENERATION_IDENTITY;
  return ALL_GEMINI_IDENTITY;
}

/** The identity of one named window in a `modelWindowIdentity` record. */
export function windowIdentity(record: Record<string, unknown> | null | undefined, name: string) {
  return coerceWindowIdentity(record && Object.hasOwn(record, name) ? record[name] : undefined);
}

/** Whether a window limits a model a session recorded. Sessions name models the way the
 * Observatory spells them ("gemini-4-neon"); a name that is no model id is read as some Gemini
 * text model, because that is all Antigravity runs on its own. Partner models (Claude, GPT) run
 * against the partner pool only. */
export function windowLimitsModel(window: WindowIdentity, model: string) {
  const id = canonicalModelId(model);
  const candidate = id === null ? ALL_GEMINI_IDENTITY : modelIdIdentity(id);
  const partner = candidate.model !== null && candidate.family === null;
  if (window.model === null && window.family === null) return partner;
  if (window.model !== null) return window.model === candidate.model;
  return window.family !== null && window.family === candidate.family;
}

/** With no models known, nothing rules out any Gemini text window, exact-model windows included,
 * so all of them are kept (fail closed). Only the partner and image pools are dropped: Antigravity
 * runs Gemini text models on its own. */
export function windowLimitsAny(window: WindowIdentity, models: readonly string[]) {
  return models.length === 0
    ? window.family === ALL_GEMINI_IDENTITY.family
    : models.some((model) => windowLimitsModel(window, model));
}

function modelLabel(id: string) {
  return id
    .split("-")
    .map((part) => /^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** The bucket detail line a quota card shows under a model window. */
export function windowScopeLabel(window: WindowIdentity) {
  if (window.model !== null) return `Limits: ${modelLabel(window.model)}`;
  if (window.family === null) return "Limits: partner models";
  if (window.family === IMAGE_GENERATION_IDENTITY.family) return "Limits: image generation";
  return "Limits: all Gemini models";
}
