import { createRequestHandler } from "./app";
import { serverPort } from "./server-port";
import { managedByLauncher } from "./update/ipc";
import { initBootIdentity } from "./update/version";

await initBootIdentity();
const server = Bun.serve({ hostname: "127.0.0.1", port: serverPort, fetch: createRequestHandler() });
console.log(`AI Usage Observatory listening on http://${server.hostname}:${server.port}`);

// The launcher runs this server in its own process group. If the launcher dies without stopping
// it, the server exits instead of holding the port as an orphan.
if (managedByLauncher()) {
  const launcherPid = process.ppid;
  setInterval(() => { if (process.ppid !== launcherPid) process.exit(0); }, 2000).unref();
}
