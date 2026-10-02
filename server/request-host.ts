const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
const hostnamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function normalizeHostname(value: string) {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

export function parseAllowedHosts(value = process.env.USAGE_OBSERVATORY_ALLOWED_HOSTS) {
  const hosts = new Set<string>();
  for (const raw of value?.split(",") ?? []) {
    const host = normalizeHostname(raw);
    if (!host) continue;
    if (!hostnamePattern.test(host)) {
      throw new Error(
        `USAGE_OBSERVATORY_ALLOWED_HOSTS must contain exact hostnames without schemes, paths, or ports: ${raw.trim()}`,
      );
    }
    hosts.add(host);
  }
  return [...hosts];
}

export function hostnameAllowed(hostname: string, allowedHosts = parseAllowedHosts()) {
  const host = normalizeHostname(hostname);
  return loopbackHosts.has(host) || allowedHosts.includes(host);
}

function requestHostname(host: string | null) {
  if (!host) return null;
  try {
    const url = new URL(`http://${host}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return normalizeHostname(url.hostname);
  } catch {
    return null;
  }
}

export function requestHostIsLoopback(host: string | null) {
  const hostname = requestHostname(host);
  return hostname !== null && loopbackHosts.has(hostname);
}

export function requestHostAllowed(host: string | null, allowedHosts = parseAllowedHosts()) {
  const hostname = requestHostname(host);
  return hostname !== null && hostnameAllowed(hostname, allowedHosts);
}

/** Browser mutations require an approved origin. Originless CLI requests are local only. */
export function requestOriginAllowed(headers: Headers, allowedHosts = parseAllowedHosts()) {
  if (headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = headers.get("origin");
  if (!origin) return requestHostIsLoopback(headers.get("host"));
  try {
    const url = new URL(origin);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash &&
      hostnameAllowed(url.hostname, allowedHosts);
  } catch {
    return false;
  }
}
