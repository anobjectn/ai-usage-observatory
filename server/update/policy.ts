import { parseAllowedHosts, requestOriginIsRemote, requestUpdateOriginAllowed } from "../request-host";
import { uuidPattern } from "./files";

/** Shared by the app server and the maintenance server. It imports nothing from node_modules, so
 * the maintenance server runs while dependencies are being replaced. */
export type UpdateAction = "check" | "apply" | "retry";
export type UpdateBody = { checkId?: string; jobId?: string };

export const updateHeaders = { "Cache-Control": "no-store" };
export const updateJson = (value: unknown, status = 200) => Response.json(value, { status, headers: updateHeaders });
const reject = (status: number, error: string, message: string) => ({ ok: false as const, response: updateJson({ error, message }, status) });

export const remoteUpdatesAllowed = (env: Record<string, string | undefined> = process.env) => env.USAGE_OBSERVATORY_REMOTE_UPDATES === "1";

export async function readUpdatePost(request: Request, action: UpdateAction, port: number, allowedHosts = parseAllowedHosts()) {
  if (!requestUpdateOriginAllowed(request.headers, port, allowedHosts)) return reject(403, "forbidden-origin", "Update requests must come from the app's own origin");
  if (request.headers.get("x-observatory-action") !== "update") return reject(403, "missing-action-header", "Update requests need the X-Observatory-Action header");
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return reject(415, "content-type", "Content-Type must be application/json");
  let body: unknown;
  try { body = await request.json(); }
  catch { return reject(400, "invalid-body", "Expected a JSON request body"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return reject(400, "invalid-body", "Expected a JSON object");
  const keys = Object.keys(body);
  const field = action === "apply" ? "checkId" : action === "retry" ? "jobId" : null;
  const value = field ? (body as Record<string, unknown>)[field] : undefined;
  if (field === null ? keys.length !== 0 : keys.length !== 1 || typeof value !== "string" || !uuidPattern.test(value)) {
    return reject(400, "invalid-body", field ? `Expected { ${field}: <uuid> }` : "Expected {}");
  }
  if (action !== "check" && requestOriginIsRemote(request.headers) && !remoteUpdatesAllowed()) {
    return reject(403, "remote-apply-disabled", "Updates can only be applied from this computer. Set USAGE_OBSERVATORY_REMOTE_UPDATES=1 to allow remote apply.");
  }
  return { ok: true as const, body: (field ? { [field]: value } : {}) as UpdateBody };
}

export type UpdaterReplyLike = { status: number; body: unknown };
