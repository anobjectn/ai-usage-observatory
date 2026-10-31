/** Decides whether a third-party page can be shown in the app's iframes, from its response headers.
 * Browsers refuse the frame when the page sends X-Frame-Options or a CSP frame-ancestors list that
 * excludes the embedding origin. */

export type EmbedVerdict = { embeddable: boolean; reasons: string[] };

function sourceAllows(source: string, origin: string) {
  const value = source.toLowerCase();
  if (value === "*") return /^https?:/.test(origin);
  if (/^[a-z][a-z0-9+.-]*:$/.test(value)) return origin.startsWith(value);
  try {
    // A host source with a wildcard or a path is not a match for a bare loopback origin here.
    return new URL(value).origin === origin;
  } catch {
    return false;
  }
}

function frameAncestorsReasons(policyHeader: string, origins: string[]) {
  const reasons: string[] = [];
  for (const policy of policyHeader.split(",")) {
    for (const directive of policy.split(";")) {
      const [name, ...sources] = directive.trim().split(/\s+/);
      if (name?.toLowerCase() !== "frame-ancestors") continue;
      const blocked = origins.filter((origin) => !sources.some((source) => sourceAllows(source, origin)));
      if (blocked.length > 0) {
        reasons.push(`Content-Security-Policy frame-ancestors ${sources.join(" ") || "(empty)"} excludes ${blocked.join(", ")}`);
      }
    }
  }
  return { present: policyHeader.split(/[;,]/).some((part) => part.trim().toLowerCase().startsWith("frame-ancestors")), reasons };
}

/** `appOrigins` are the origins that embed the page. Per the CSP spec, a frame-ancestors directive
 * overrides X-Frame-Options, so the latter counts only when the former is absent. */
export function embedVerdict(headers: Headers, appOrigins: string[]): EmbedVerdict {
  const csp = headers.get("content-security-policy");
  const ancestors = csp ? frameAncestorsReasons(csp, appOrigins) : { present: false, reasons: [] };
  if (ancestors.present) return { embeddable: ancestors.reasons.length === 0, reasons: ancestors.reasons };
  const xfo = headers.get("x-frame-options")?.trim();
  if (xfo && /deny|sameorigin/i.test(xfo)) return { embeddable: false, reasons: [`X-Frame-Options: ${xfo}`] };
  return { embeddable: true, reasons: [] };
}

/** Origins named by the `frame-src` directive of a Content-Security-Policy header value. */
export function frameSrcOrigins(policy: string) {
  for (const directive of policy.split(";")) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (name?.toLowerCase() === "frame-src") return sources.filter((source) => /^https?:\/\//i.test(source));
  }
  return [];
}
