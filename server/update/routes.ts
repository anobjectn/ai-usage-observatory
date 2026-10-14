import { join } from "node:path";
import type { UpdateCheck, UpdateStatus } from "../../src/types";
import { requestHostIsLoopback } from "../request-host";
import { newestBackup } from "./backup";
import { autoCheckDue, recordCheckAt } from "./files";
import { inspectRepository, repoRoot } from "./git";
import { launcherRequest, managedByLauncher, type IpcType } from "./ipc";
import { readUpdatePost, remoteUpdatesAllowed, updateJson, type UpdateAction } from "./policy";
import { runningIdentity } from "./version";

export type UpdateRouteOptions = {
  port: number;
  root?: string;
  stateDir?: string;
  dbPath?: string;
  schemaAhead?: () => boolean;
  managed?: boolean;
  mode?: "dev" | "unmanaged";
  /** The launcher channel; tests inject a fake. */
  launcher?: (type: IpcType, body?: unknown) => Promise<{ status: number; body: unknown }>;
  inspect?: (root: string) => Promise<UpdateCheck>;
};

/** `bun run dev` starts the API with `bun --watch` through the `dev:server` script. */
export const devServer = () => process.env.npm_lifecycle_event === "dev:server" || process.execArgv.includes("--watch");

const manualCommands = {
  dev: "Run `git pull --ff-only && bun install`; the dev server reloads.",
  unmanaged: "Restart with `bun run start` to update in the app.",
};

/** `/api/update/*`. In managed production the launcher owns checks and jobs; otherwise this
 * process runs checks itself and never applies. Nothing here waits for a snapshot. */
export function createUpdateRoutes(options: UpdateRouteOptions) {
  const root = options.root ?? repoRoot;
  const stateDir = options.stateDir ?? join(root, ".usage-observatory");
  const managed = options.managed ?? managedByLauncher();
  const mode = managed ? "prod" : options.mode ?? (devServer() ? "dev" : "unmanaged");
  const launcher = options.launcher ?? launcherRequest;
  const inspect = options.inspect ?? ((path: string) => inspectRepository(path, { fetch: true, dbPath: options.dbPath }).then((record) => record.check));
  let localCheck: UpdateCheck | null = null;
  let checking: Promise<UpdateCheck> | null = null;

  async function status(request: Request): Promise<Response> {
    const remote = !requestHostIsLoopback(request.headers.get("host"));
    const remoteBlocked = remote && !remoteUpdatesAllowed();
    const identity = runningIdentity();
    const local = {
      running: { commit: identity.commit, version: identity.version, bootId: identity.bootId, startedAt: identity.startedAt },
      schemaAhead: options.schemaAhead?.() ?? false,
    };
    if (managed) {
      const reply = await launcher("status");
      if (reply.status !== 200) return updateJson(reply.body, reply.status);
      const body = reply.body as UpdateStatus;
      const jobActive = body.blockingReason === "job-active";
      return updateJson({
        ...body, ...local,
        canApply: body.canApply && !remoteBlocked,
        blockingReason: jobActive ? "job-active" : remoteBlocked ? "remote-restricted" : null,
      } satisfies UpdateStatus);
    }
    return updateJson({
      managed: false, mode, canApply: false, blockingReason: mode === "dev" ? "dev" : "unmanaged", ...local,
      check: localCheck, job: null, backupPath: newestBackup(stateDir), autoCheckDue: autoCheckDue(stateDir), launcherRestartRequired: false,
    } satisfies UpdateStatus);
  }

  async function post(request: Request, action: UpdateAction): Promise<Response> {
    const input = await readUpdatePost(request, action, options.port);
    if (!input.ok) return input.response;
    if (managed) {
      const reply = await launcher(action, input.body);
      return updateJson(reply.body, reply.status);
    }
    if (action === "check") {
      checking ??= inspect(root).then((check) => {
        localCheck = check;
        recordCheckAt(stateDir);
        return check;
      }).finally(() => { checking = null; });
      return updateJson(await checking);
    }
    const commands = manualCommands[mode === "dev" ? "dev" : "unmanaged"];
    return updateJson({ error: "unmanaged", message: commands, commands }, 503);
  }

  return async (request: Request, url: URL): Promise<Response> => {
    const action = url.pathname.slice("/api/update/".length);
    if (action === "version" && request.method === "GET") {
      // Readiness probes come from the launcher on loopback only.
      if (!requestHostIsLoopback(request.headers.get("host"))) return updateJson({ error: "Forbidden host" }, 403);
      return updateJson(runningIdentity());
    }
    if (action === "status" && request.method === "GET") return status(request);
    if ((action === "check" || action === "apply" || action === "retry") && request.method === "POST") return post(request, action);
    return updateJson({ error: "Not found" }, 404);
  };
}
