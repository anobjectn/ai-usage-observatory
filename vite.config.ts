import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { parseAllowedHosts } from "./server/request-host";
import { securityHeaders } from "./server/security-headers";

/** The commit this bundle was built from. The update flow compares it with the running server. */
function buildCommit() {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch { return null; }
}

/** `dist/build-info.json` lets the launcher verify that the served bundle matches the checkout. */
function buildInfo(commit: string | null): Plugin {
  return {
    name: "observatory-build-info",
    apply: "build",
    writeBundle(options) {
      const directory = resolve(options.dir ?? "dist");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "build-info.json"), `${JSON.stringify({ commit })}\n`);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const allowedHosts = parseAllowedHosts(
    process.env.USAGE_OBSERVATORY_ALLOWED_HOSTS ?? env.USAGE_OBSERVATORY_ALLOWED_HOSTS,
  );
  const commit = buildCommit();

  return {
    plugins: [react(), buildInfo(commit)],
    define: { __APP_COMMIT__: JSON.stringify(commit) },
    server: {
      host: "127.0.0.1",
      port: 5173,
      allowedHosts,
      // Vite's React refresh preamble is inline; production permits no inline scripts.
      headers: securityHeaders({ development: true }),
      proxy: {
        "/api": {
          target: "http://127.0.0.1:4318",
          changeOrigin: true,
        },
      },
    },
    build: { outDir: "dist" },
  };
});
