/** Warp records a model under a display name that carries the effort it ran at
 * ("GPT-5.6 Luna (extra high reasoning)"), and older rows carry a slug for the same thing
 * ("gpt-5-6-luna-xhigh"). ccusage records the provider's model id ("gpt-5.6-luna"). Without a
 * shared spelling the Models view shows the same model as three cards, only one of which can
 * carry a rate card, so the other two read "Pricing unavailable".
 *
 * This is a spelling normalizer, not an effort source. The effort token is dropped here and
 * never re-published: recorded effort comes from the effort pipeline (`normalizeEffort`), which
 * still refuses to infer effort from a model name. */

/** Effort words Warp appends to a model name. `max` is handled separately — `codex max` is part
 * of a model name, not an effort. */
const effortWords = new Set([
  "low", "medium", "high", "xhigh", "minimal", "thinking",
]);

const claudeTiers = ["opus", "sonnet", "haiku", "fable"];

/** Names that are a Warp routing mode rather than a model, kept verbatim. */
const passThrough = new Set(["auto", "auto-genius", "unknown model"]);

function words(value: string) {
  return value
    .replace(/\((.*?)\)/g, " $1 ")
    .replace(/[-_.\s]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** Drops a trailing recorded-effort token. `extra high` collapses first so "extra high reasoning"
 * and "xhigh" reduce to the same thing. */
function stripEffort(parts: string[]) {
  const collapsed: string[] = [];
  for (const part of parts) {
    if (part === "reasoning") continue;
    if (part === "high" && collapsed.at(-1) === "extra") collapsed[collapsed.length - 1] = "xhigh";
    else collapsed.push(part);
  }
  const last = collapsed.at(-1);
  if (!last) return collapsed;
  if (effortWords.has(last)) return collapsed.slice(0, -1);
  // `max` is an effort unless it belongs to the model ("codex max").
  if (last === "max" && collapsed.at(-2) !== "codex") return collapsed.slice(0, -1);
  return collapsed;
}

/** Version digits split across separators ("5 1", "4 6") rejoin the way each vendor writes them:
 * Anthropic ids use dashes (`claude-opus-4-6`), OpenAI ids use a dot (`gpt-5.1`). */
function takeVersion(parts: string[]) {
  const start = parts.findIndex((part) => /^\d+$/.test(part));
  if (start < 0) return { version: [] as string[], rest: parts };
  let end = start;
  while (end + 1 < parts.length && /^\d+$/.test(parts[end + 1])) end++;
  return { version: parts.slice(start, end + 1), rest: [...parts.slice(0, start), ...parts.slice(end + 1)] };
}

/** One spelling for a model, whichever source named it. Unrecognized names still normalize to a
 * stable lowercase-dashed form rather than being dropped or guessed at. */
export function canonicalModelName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  const lowered = trimmed.toLowerCase();
  if (passThrough.has(lowered)) return lowered;
  // A ccusage id is already in this shape, so it round-trips unchanged — including its
  // datestamp, which the existing family logic still strips.
  const parts = stripEffort(words(lowered));
  if (parts.length === 0) return lowered;
  const vendor = parts[0];
  const { version, rest } = takeVersion(parts.slice(1));
  if (version.length === 0) return parts.join("-");

  if (vendor === "claude") {
    const tier = rest.find((part) => claudeTiers.includes(part));
    const extras = rest.filter((part) => part !== tier);
    return ["claude", tier, ...version, ...extras].filter(Boolean).join("-");
  }
  return [vendor, version.join("."), ...rest].join("-");
}
