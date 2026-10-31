/** `bun run check:embeds`: fetches every page the app embeds and reports the ones whose headers
 * forbid framing. Exits 1 when any embed is blocked or could not be checked, so a release pauses
 * for a decision: remove the resource, or accept the broken embed. */
import { BENCHMARK_SITES } from "../src/components/benchmark-launcher";
import { embedVerdict, frameSrcOrigins } from "../server/embed-check";
import { securityHeaders } from "../server/security-headers";

/** Where the app is served, in production and under the dev server. */
const appOrigins = ["http://127.0.0.1:4318", "http://localhost:4318", "http://127.0.0.1:5173", "http://localhost:5173"];
const timeoutMs = 15_000;

type Target = { label: string; url: string };

/** The benchmark viewer's pages, plus any other origin the CSP lets the app frame. */
function embedTargets(): Target[] {
  const targets: Target[] = BENCHMARK_SITES.map((site) => ({ label: site.label, url: site.url }));
  const covered = new Set(targets.map((target) => new URL(target.url).origin));
  for (const origin of frameSrcOrigins(securityHeaders()["Content-Security-Policy"])) {
    if (!covered.has(new URL(origin).origin)) targets.push({ label: origin, url: origin });
  }
  return targets;
}

async function check(target: Target) {
  try {
    const response = await fetch(target.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" },
    });
    await response.body?.cancel();
    const verdict = embedVerdict(response.headers, appOrigins);
    if (!verdict.embeddable) return { ...target, status: "BLOCKED" as const, detail: verdict.reasons.join("; ") };
    if (!response.ok) return { ...target, status: "UNVERIFIED" as const, detail: `HTTP ${response.status}; the headers do not forbid framing, but the page may not load` };
    return { ...target, status: "OK" as const, detail: "" };
  } catch (error) {
    return { ...target, status: "UNVERIFIED" as const, detail: `request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

const results = await Promise.all(embedTargets().map(check));
for (const result of results) {
  console.log(`${result.status.padEnd(10)} ${result.label} <${result.url}>${result.detail ? `\n           ${result.detail}` : ""}`);
}
const failed = results.filter((result) => result.status !== "OK");
if (failed.length > 0) {
  console.error(`\n${failed.length} of ${results.length} embedded resource(s) need a decision: remove the resource, or accept it as is.`);
  process.exit(1);
}
console.log(`\nAll ${results.length} embedded resource(s) allow framing.`);
