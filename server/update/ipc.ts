import { randomUUID } from "node:crypto";

/** Messages between the launcher and the server it supervises, over Bun's native IPC channel. */
export type IpcType = "status" | "check" | "apply" | "retry";
export type IpcRequest = { v: 1; id: string; type: IpcType; body?: unknown };
export type IpcResponse = { v: 1; id: string; ok: boolean; status: number; body: unknown };
export const ipcDeadlines: Record<IpcType, number> = { status: 10_000, check: 90_000, apply: 10_000, retry: 10_000 };

const types = new Set<IpcType>(["status", "check", "apply", "retry"]);

export const isIpcRequest = (value: unknown): value is IpcRequest =>
  Boolean(value && typeof value === "object" && (value as IpcRequest).v === 1 && typeof (value as IpcRequest).id === "string" && types.has((value as IpcRequest).type));

const isIpcResponse = (value: unknown): value is IpcResponse =>
  Boolean(value && typeof value === "object" && (value as IpcResponse).v === 1 && typeof (value as IpcResponse).id === "string" && typeof (value as IpcResponse).status === "number");

/** True in the server process that `bun run start` supervises. */
export const managedByLauncher = () => process.env.USAGE_OBSERVATORY_MANAGED === "1" && typeof process.send === "function";

const pending = new Map<string, (response: IpcResponse) => void>();
let listening = false;

/** Sends one request to the launcher. A missing answer becomes a `504`, never a hang. */
export function launcherRequest(type: IpcType, body?: unknown): Promise<IpcResponse> {
  if (!listening) {
    listening = true;
    process.on("message", (message: unknown) => {
      if (!isIpcResponse(message)) return;
      pending.get(message.id)?.(message);
    });
  }
  const id = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish({ v: 1, id, ok: false, status: 504, body: { error: "launcher-timeout", message: "The launcher did not answer" } }), ipcDeadlines[type]);
    function finish(response: IpcResponse) {
      clearTimeout(timer);
      pending.delete(id);
      resolve(response);
    }
    pending.set(id, finish);
    try { process.send!({ v: 1, id, type, body } satisfies IpcRequest); }
    catch { finish({ v: 1, id, ok: false, status: 502, body: { error: "launcher-unavailable", message: "The launcher channel is closed" } }); }
  });
}
