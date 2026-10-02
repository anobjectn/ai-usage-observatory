import { createRequestHandler } from "./app";
import { serverPort } from "./server-port";

const server = Bun.serve({ hostname: "127.0.0.1", port: serverPort, fetch: createRequestHandler() });
console.log(`AI Usage Observatory listening on http://${server.hostname}:${server.port}`);
