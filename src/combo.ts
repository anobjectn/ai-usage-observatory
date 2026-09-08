import { compareEffort, effortRank, normalizeEffort } from "./effort-model";
import { familyOf } from "./model-family";
import type { EffortComboDayRow } from "./types";

/** Model family × provider-recorded effort. `High` alone is not a decision unit: `Opus 5 · High`
 * and `Sol · High` are different cohorts, so every effort comparison carries its model. */
export type Combo = { family: string; effort: string };

/** Not every recorded model is a person driving a session. Automated and synthetic rows stay in
 * volume and coverage totals but never enter an outcome comparison. */
export type ComboKind = "interactive" | "automated" | "synthetic" | "unknown";

/** In-memory/series key only. It is never a URL value — see `encodeComboFacet`. */
const KEY_SEPARATOR = "\0";

/** Reserved series keys. Neither is a real combo, so neither round-trips through `parseComboKey`. */
export const OTHER_COMBO_KEY = "other";
export const UNKNOWN_COMBO_KEY = "unknown";
/** Warp activity: authoritative volume with no transcript behind it. Named rather than folded
 * into Unknown so the chart still says where that work happened. */
export const WARP_COMBO_KEY = "warp";

/** The one raw-model → family conversion for combos. Effort is normalized, never inferred. */
export function comboOf(rawModel: unknown, rawEffort: unknown): Combo {
  const model = typeof rawModel === "string" ? rawModel.trim() : "";
  return { family: model ? familyOf(model) : "unknown", effort: normalizeEffort(rawEffort) };
}

export function comboKey(combo: Combo) {
  return `${combo.family}${KEY_SEPARATOR}${combo.effort}`;
}

export function parseComboKey(key: string): Combo | null {
  const parts = key.split(KEY_SEPARATOR);
  if (parts.length !== 2 || !parts[0]) return null;
  return { family: parts[0], effort: parts[1] };
}

export function compareComboKeys(a: string, b: string) {
  const left = parseComboKey(a);
  const right = parseComboKey(b);
  if (!left || !right) return a.localeCompare(b);
  return left.family.localeCompare(right.family) || compareEffort(left.effort, right.effort);
}

/** Classification is by recorded model name only. An empty model is `unknown`, not a guess. */
export function comboKind(rawModel: unknown): ComboKind {
  const model = (typeof rawModel === "string" ? rawModel : "").trim().toLowerCase();
  if (!model || model === "unknown") return "unknown";
  if (model.startsWith("<") && model.endsWith(">")) return "synthetic";
  if (model.includes("auto-review") || model.includes("autoreview")) return "automated";
  return "interactive";
}

const fallbackPalette = [1, 2, 3, 4, 5, 6].map((index) => `var(--color-family-fallback-${index})`);
const neutral = "var(--line-bright)";
const warpColor = "var(--warp-color)";

function stablePaletteColor(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index++) hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  return fallbackPalette[hash % fallbackPalette.length];
}

/** Effort hues are their own tokens so a custom accent never recolours a level. */
const fixedEffortColors: Record<string, string> = {
  low: "var(--color-effort-low)",
  medium: "var(--color-effort-medium)",
  high: "var(--color-effort-high)",
  xhigh: "var(--color-effort-xhigh)",
  max: "var(--color-effort-max)",
};
const unknownEffortColor = "var(--color-effort-unknown)";

/** Values the providers add later still get a stable, repeatable colour rather than a random one
 * or a silent drop. Colour is never the only label. */
export function effortColor(effort: string) {
  if (effort === WARP_COMBO_KEY) return warpColor;
  if (effort === UNKNOWN_COMBO_KEY || effort === OTHER_COMBO_KEY || effort === "") return unknownEffortColor;
  return fixedEffortColors[effort] ?? stablePaletteColor(effort);
}

export function effortLabel(effort: string | null) {
  if (!effort) return "Unknown";
  if (effort === "xhigh") return "X-high";
  if (effort === OTHER_COMBO_KEY) return "Other";
  if (effort === WARP_COMBO_KEY) return "Warp tokens";
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

const shortEffortLabels: Record<string, string> = { low: "Low", medium: "Med", high: "High", xhigh: "XH", max: "Max" };

export function effortShortLabel(effort: string | null) {
  if (!effort) return "Unk";
  return shortEffortLabels[effort] ?? effortLabel(effort);
}

const fixedFamilyColors: Record<string, string> = {
  "claude-fable-5": "var(--color-series-4)",
  "claude-opus-5": "var(--color-series-3)",
  "claude-sonnet-5": "var(--color-series-5)",
  "claude-haiku-4-5": "var(--color-series-2)",
  "gpt-5.6-sol": "var(--color-family-fallback-4)",
};

/** Model families need their own colours: provider colours would make every Claude or Codex
 * family indistinguishable. Unknown future families still get a stable palette entry. */
export function familyColor(family: string) {
  if (!family || family === UNKNOWN_COMBO_KEY) return neutral;
  return fixedFamilyColors[family.toLowerCase()] ?? stablePaletteColor(`family:${family.toLowerCase()}`);
}

/** Compact family label for pills and legends, without discarding the release family. */
export function familyLabel(family: string) {
  if (!family || family === UNKNOWN_COMBO_KEY) return "Unknown model";
  const withoutProvider = family
    .replace(/^claude[-_ ]/i, "")
    .replace(/^gpt[-_ ]/i, "GPT ");
  const words = withoutProvider
    .replace(/[-_]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase() === "gpt"
      ? "GPT"
      : word.charAt(0).toUpperCase() + word.slice(1));
  return words.join(" ").replace(/(\d) (\d)(?=$| )/g, "$1.$2");
}

export function comboLabel(combo: Combo) {
  return `${familyLabel(combo.family)} · ${effortLabel(combo.effort)}`;
}

export function comboShortLabel(combo: Combo) {
  return `${familyLabel(combo.family)} ${effortShortLabel(combo.effort)}`;
}

/** Family hue with a bounded effort tint: higher effort approaches the base family colour, lower
 * effort is mixed toward white. Mixing toward black would be invisible on the dark panel. */
export function comboColor(combo: Combo) {
  const base = familyColor(combo.family);
  if (base === neutral || !combo.effort || combo.effort === OTHER_COMBO_KEY) return base;
  const weight = Math.round(Math.min(100, 55 + effortRank(combo.effort) * 11.25));
  if (weight >= 100) return base;
  return `color-mix(in oklab, ${base} ${weight}%, white)`;
}

/** URL- and form-safe facet value. A JSON tuple means a future model name containing any
 * delimiter this app happens to use cannot collide with the encoding. */
export function encodeComboFacet(combo: Combo) {
  return `combo:${JSON.stringify([combo.family, combo.effort])}`;
}

export function parseComboFacet(value: string | null | undefined): Combo | null {
  if (typeof value !== "string" || !value.startsWith("combo:")) return null;
  try {
    const parsed = JSON.parse(value.slice("combo:".length)) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [family, effort] = parsed;
    if (typeof family !== "string" || typeof effort !== "string" || !family) return null;
    return { family, effort: normalizeEffort(effort) };
  } catch {
    return null;
  }
}

export type ComboAmount = Combo & { amount: number; day?: string };

/** A combo carrying at least this share of one day's recorded volume is drawn even when it is
 * light across the range: a day's own leader must never read as "Other combos". */
export const PROMINENT_DAY_SHARE = 0.2;

/** Selects the series drawn across a whole range. Selection and order are both by volume: the
 * biggest cohorts over the range are always visible, any combo prominent on a single day joins
 * them, and every series sits by range volume with the heaviest at the bottom of the stack and
 * the lightest on top, regardless of provider.
 *
 * Volume-aware ordering lives here rather than in a `compareCombo(a, b)` helper: a `Combo`
 * carries no volume, so that contract could not be implemented honestly. */
export function selectComboSeries(buckets: ComboAmount[], limit = 6): string[] {
  const totals = new Map<string, number>();
  const dayTotals = new Map<string, number>();
  const dayAmounts = new Map<string, Map<string, number>>();
  for (const bucket of buckets) {
    if (!bucket.effort) continue;
    const key = comboKey(bucket);
    totals.set(key, (totals.get(key) ?? 0) + bucket.amount);
    if (bucket.day === undefined) continue;
    dayTotals.set(bucket.day, (dayTotals.get(bucket.day) ?? 0) + bucket.amount);
    const amounts = dayAmounts.get(bucket.day) ?? new Map<string, number>();
    amounts.set(key, (amounts.get(key) ?? 0) + bucket.amount);
    dayAmounts.set(bucket.day, amounts);
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1] || compareComboKeys(a[0], b[0]));
  const selected = new Set(ranked.slice(0, limit).map(([key]) => key));
  for (const [day, amounts] of dayAmounts) {
    const total = dayTotals.get(day) ?? 0;
    for (const [key, amount] of amounts) if (total > 0 && amount / total >= PROMINENT_DAY_SHARE) selected.add(key);
  }
  return ranked.filter(([key]) => selected.has(key)).map(([key]) => key);
}

export type ComboTotals = { observations: number; tokens: number };

/** Caps a day's buckets against an already-chosen series. The remainder is summed into `other`,
 * never discarded, so the capped stack still totals what the uncapped one did.
 *
 * A bucket with no recorded effort is not `other`: it is reported separately so an unrecorded
 * value can never be presented as a small tail of recorded ones. */
export function capComboBuckets<T extends Combo & ComboTotals>(
  buckets: T[],
  selected: Iterable<string>,
): { kept: T[]; other: ComboTotals & { combos: number }; unrecorded: ComboTotals } {
  const order = new Map([...selected].map((key, index) => [key, index]));
  const kept: T[] = [];
  const other = { observations: 0, tokens: 0, combos: 0 };
  const unrecorded = { observations: 0, tokens: 0 };
  for (const bucket of buckets) {
    if (!bucket.effort) {
      unrecorded.observations += bucket.observations;
      unrecorded.tokens += bucket.tokens;
      continue;
    }
    if (order.has(comboKey(bucket))) {
      kept.push(bucket);
      continue;
    }
    other.observations += bucket.observations;
    other.tokens += bucket.tokens;
    other.combos += 1;
  }
  kept.sort((a, b) => order.get(comboKey(a))! - order.get(comboKey(b))!);
  return { kept, other, unrecorded };
}

export type ComboDayPoint = {
  date: string;
  /** Reconciliation failed for this day, so no stack may be drawn for it. */
  suppressed: boolean;
  total: number;
  values: Record<string, number>;
  row: EffortComboDayRow;
};

/** Turns one `/api/effort/combo-days` response into a stackable series. Series keys are chosen
 * once across the whole range, so a combo does not change colour or vanish between adjacent bars;
 * the remainder collapses into `other` and totals are preserved.
 *
 * `warp` and `unknown` sit outside the combo budget: both are authoritative volume with no
 * recorded combo, not the smallest of the recorded ones. Warp is named because its provider is
 * known even though nothing else is; `unknown` is what remains after it. */
export function buildComboDaySeries(
  rows: EffortComboDayRow[],
  basis: "tokens" | "observations",
  limit = 10,
): { keys: string[]; points: ComboDayPoint[]; suppressedDays: number } {
  const amountOf = (bucket: ComboTotals) => (basis === "tokens" ? bucket.tokens : bucket.observations);
  const drawable = rows.filter((row) => !row.suppressed);
  const selected = selectComboSeries(
    drawable.flatMap((row) => row.buckets.map((bucket) => ({ family: bucket.family, effort: bucket.effort, amount: amountOf(bucket), day: row.key }))),
    limit,
  );
  const hasOther = drawable.some((row) => capComboBuckets(row.buckets, selected).other.combos > 0);
  // Warp has tokens but no observations, so the series only exists on the token basis.
  const hasWarp = basis === "tokens" && drawable.some((row) => row.warpTokens > 0);
  const keys = [...selected, ...(hasOther ? [OTHER_COMBO_KEY] : []), ...(hasWarp ? [WARP_COMBO_KEY] : []), UNKNOWN_COMBO_KEY];

  let suppressedDays = 0;
  const points = rows.map((row): ComboDayPoint => {
    const values = Object.fromEntries(keys.map((key) => [key, 0]));
    if (row.suppressed) suppressedDays++;
    else {
      const { kept, other } = capComboBuckets(row.buckets, selected);
      for (const bucket of kept) values[comboKey(bucket)] += amountOf(bucket);
      if (hasOther) values[OTHER_COMBO_KEY] += amountOf(other);
      // Unrecorded-effort tokens are already outside `attributedTokens`, so the coverage figure
      // carries them; adding the buckets again here would double-count them.
      if (hasWarp) values[WARP_COMBO_KEY] = row.warpTokens;
      values[UNKNOWN_COMBO_KEY] = basis === "tokens"
        ? Math.max(0, (row.coverage.unknownTokens ?? 0) - (hasWarp ? row.warpTokens : 0))
        : row.coverage.unknownObservations;
    }
    return {
      date: row.key,
      suppressed: row.suppressed,
      total: Object.values(values).reduce((sum, value) => sum + value, 0),
      values,
      row,
    };
  });
  return { keys, points, suppressedDays };
}

/** Legend/tooltip label for any series key, including the two reserved ones. */
export function comboSeriesLabel(key: string) {
  if (key === OTHER_COMBO_KEY) return "Other combos";
  if (key === WARP_COMBO_KEY) return "Warp tokens";
  if (key === UNKNOWN_COMBO_KEY) return "Unknown";
  const combo = parseComboKey(key);
  return combo ? comboLabel(combo) : key;
}

export function comboSeriesColor(key: string) {
  if (key === WARP_COMBO_KEY) return warpColor;
  if (key === OTHER_COMBO_KEY || key === UNKNOWN_COMBO_KEY) return neutral;
  const combo = parseComboKey(key);
  return combo ? comboColor(combo) : neutral;
}
