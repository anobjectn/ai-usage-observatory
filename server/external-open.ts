import { stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { getSessionDetail } from "./session-detail";
import { getSessionSource } from "./path-indexer";
import { hostnameAllowed, parseAllowedHosts, requestHostIsLoopback } from "./request-host";

export const externalOpenActions = [
  "reveal",
  "vscode",
  "default-editor",
] as const;

export type ExternalOpenAction = (typeof externalOpenActions)[number];
export type ExternalOpenTarget =
  | { kind: "transcript" }
  | { kind: "file"; path: string };

export class ExternalOpenError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ExternalOpenError";
  }
}

export function isExternalOpenAction(
  value: unknown,
): value is ExternalOpenAction {
  return externalOpenActions.includes(value as ExternalOpenAction);
}

/** Browser POSTs carry Origin. Reject cross-site callers before allowing an approved app origin
 * to launch a desktop app; origin-less local clients such as curl remain usable. */
export function externalOpenOriginAllowed(headers: Headers, allowedHosts = parseAllowedHosts()) {
  if (headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = headers.get("origin");
  if (!origin) return requestHostIsLoopback(headers.get("host"));
  try {
    const url = new URL(origin);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      hostnameAllowed(url.hostname, allowedHosts)
    );
  } catch {
    return false;
  }
}

export function resolveListedFilePath(cwd: string | null, listedPath: string) {
  if (isAbsolute(listedPath)) return resolve(listedPath);
  if (!cwd)
    throw new ExternalOpenError(
      "This session has no working directory for resolving that file.",
      409,
    );
  return resolve(cwd, listedPath);
}

export function externalOpenCommand(
  action: ExternalOpenAction,
  target: string,
  revealParent = false,
  platform = process.platform,
) {
  if (action === "vscode") {
    return platform === "darwin"
      ? ["/usr/bin/open", "-b", "com.microsoft.VSCode", target]
      : ["code", "--reuse-window", target];
  }
  if (platform !== "darwin") {
    throw new ExternalOpenError(
      action === "reveal"
        ? "Reveal in Finder is available on macOS only."
        : "The default text editor action is available on macOS only.",
      501,
    );
  }
  if (action === "default-editor") return ["/usr/bin/open", "-t", target];
  return revealParent
    ? ["/usr/bin/open", target]
    : ["/usr/bin/open", "-R", target];
}

async function pathExists(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function nearestExistingParent(path: string) {
  let candidate = dirname(path);
  while (candidate !== dirname(candidate)) {
    if (await pathExists(candidate)) return candidate;
    candidate = dirname(candidate);
  }
  throw new ExternalOpenError(
    "Neither that file nor its containing folder exists locally.",
    404,
  );
}

async function launch(command: string[]) {
  try {
    const child = Bun.spawn(command, { stdout: "ignore", stderr: "pipe" });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new ExternalOpenError(
        stderr.trim() || "The external application could not open that file.",
        502,
      );
    }
  } catch (error) {
    if (error instanceof ExternalOpenError) throw error;
    throw new ExternalOpenError(
      error instanceof Error
        ? error.message
        : "The external application could not be launched.",
      502,
    );
  }
}

export async function openSessionExternalTarget(
  sessionId: string,
  action: ExternalOpenAction,
  target: ExternalOpenTarget,
) {
  const source = getSessionSource(sessionId);
  if (!source)
    throw new ExternalOpenError("That session is no longer available.", 404);

  let targetPath: string;
  let label: string;
  if (target.kind === "transcript") {
    targetPath = source.sourceFile;
    label = "Session transcript";
  } else {
    const detail = await getSessionDetail(sessionId);
    const listedFile = detail.files.find((file) => file.path === target.path);
    if (!listedFile) {
      throw new ExternalOpenError(
        "That path is not listed in this session's file changes.",
        403,
      );
    }
    targetPath = resolveListedFilePath(source.cwd, listedFile.path);
    label = basename(listedFile.path);
  }

  const targetInfo = await pathExists(targetPath);
  let revealParent = false;
  if (!targetInfo) {
    if (action !== "reveal")
      throw new ExternalOpenError("That file no longer exists locally.", 404);
    targetPath = await nearestExistingParent(targetPath);
    revealParent = true;
  } else if (targetInfo.isDirectory() && action === "default-editor") {
    throw new ExternalOpenError(
      "The default text editor action requires a file.",
      409,
    );
  }

  await launch(externalOpenCommand(action, targetPath, revealParent));
  const destination =
    action === "vscode"
      ? "Visual Studio Code"
      : action === "default-editor"
        ? "the default text editor"
        : "Finder";
  return {
    ok: true,
    message:
      action === "reveal" && revealParent
        ? `Opened ${label}'s containing folder in ${destination}.`
        : `${action === "reveal" ? "Revealed" : "Opened"} ${label} in ${destination}.`,
  };
}
