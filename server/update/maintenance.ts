import type { UpdateStatus } from "../../src/types";
import { createHash } from "node:crypto";
import { secureHandler } from "../security-headers";
import { requestHostAllowed } from "../request-host";
import { readUpdatePost, updateJson, type UpdaterReplyLike } from "./policy";

/** Answers on the app port while the app server is stopped for an update. It imports nothing
 * from the store, the collectors, React, or node_modules, which the update replaces. */
export type MaintenanceHandlers = {
  port: number;
  status: () => UpdateStatus;
  retry: (jobId: string) => Promise<UpdaterReplyLike>;
};

export function createMaintenanceHandler(handlers: MaintenanceHandlers) {
  return secureHandler(async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (!requestHostAllowed(request.headers.get("host"))) return updateJson({ error: "Forbidden host" }, 403);
    const path = url.pathname;
    if (path === "/api/update/status" && request.method === "GET") return updateJson(handlers.status());
    if (path === "/api/update/retry" && request.method === "POST") {
      const input = await readUpdatePost(request, "retry", handlers.port);
      if (!input.ok) return input.response;
      const reply = await handlers.retry(input.body.jobId!);
      return updateJson(reply.body, reply.status);
    }
    if ((path === "/api/update/check" || path === "/api/update/apply") && request.method === "POST") {
      return updateJson({ error: "job-active", message: "An update is running" }, 409);
    }
    if (path.startsWith("/api/")) return updateJson({ error: "updating", message: "AI Usage Observatory is updating" }, 503);
    if (request.method !== "GET" && request.method !== "HEAD") return updateJson({ error: "updating" }, 503);
    return new Response(maintenancePage, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "2" } });
  }, { scriptHash: maintenanceScriptHash });
}

export function startMaintenanceServer(handlers: MaintenanceHandlers) {
  return Bun.serve({ hostname: "127.0.0.1", port: handlers.port, fetch: createMaintenanceHandler(handlers) });
}

/** Uses the same status contract as the app. Reloads once the app server answers again. */
const maintenancePage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Updating · AI Usage Observatory</title>
<style>
:root{color-scheme:dark;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#070a12;color:#e7ecf5}
main{max-width:560px;margin:14vh auto;padding:0 24px}h1{font-size:22px;margin:0 0 8px}p{color:#a5afc2;line-height:1.5}
.phase{font:600 13px ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;color:#7dd3fc}
pre{white-space:pre-wrap;background:#0e1422;border:1px solid #1f2a40;border-radius:8px;padding:12px;font-size:12px;max-height:40vh;overflow:auto}
button{background:#7dd3fc;color:#04121c;border:0;border-radius:6px;padding:8px 14px;font-weight:600;cursor:pointer}
</style></head><body><main>
<p class="phase" id="phase">Updating</p><h1 id="title">AI Usage Observatory is updating</h1>
<p id="detail" aria-live="polite">The app restarts by itself. This page reloads when it is ready.</p>
<div id="actions"></div><pre id="log" hidden></pre>
</main><script>
const $ = (id) => document.getElementById(id);
let retrying = false;
async function poll() {
  let status = null;
  try { const response = await fetch("/api/update/status", { cache: "no-store" }); if (response.ok) status = await response.json(); } catch {}
  if (!status) { $("detail").textContent = "Restarting — reconnecting…"; return setTimeout(poll, 3000); }
  if (!status.maintenance) return location.reload();
  const job = status.job;
  $("phase").textContent = job ? job.phase : "updating";
  if (job && job.phase === "failed") {
    $("title").textContent = "The update stopped";
    $("detail").textContent = (job.failure ? job.failure.message : "") + (job.backupPath ? " Database backup: " + job.backupPath : "");
    $("log").hidden = !(job.failure && job.failure.logTail.length);
    $("log").textContent = job.failure ? job.failure.logTail.join("\\n") : "";
    $("actions").innerHTML = "";
    if (job.retryable) {
      const button = document.createElement("button");
      button.textContent = "Retry";
      button.disabled = retrying;
      button.onclick = async () => {
        retrying = true; button.disabled = true;
        await fetch("/api/update/retry", { method: "POST", headers: { "Content-Type": "application/json", "X-Observatory-Action": "update" }, body: JSON.stringify({ jobId: job.id }) }).catch(() => null);
        retrying = false;
      };
      $("actions").append(button);
    } else {
      $("actions").textContent = "See the README section “Recover from a failed update”.";
    }
  }
  setTimeout(poll, 1000);
}
poll();
</script></body></html>`;

// Authorize only this exact inline polling script, including its surrounding whitespace.
const maintenanceScriptHash = `sha256-${createHash("sha256").update(maintenancePage.split("<script>")[1]!.split("</script>")[0]!).digest("base64")}`;
