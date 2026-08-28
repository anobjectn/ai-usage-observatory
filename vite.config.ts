import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { parseAllowedHosts } from "./server/request-host";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const allowedHosts = parseAllowedHosts(
    process.env.USAGE_OBSERVATORY_ALLOWED_HOSTS ?? env.USAGE_OBSERVATORY_ALLOWED_HOSTS,
  );

  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 5173,
      allowedHosts,
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
