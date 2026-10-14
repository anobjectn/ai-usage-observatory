import { isAbsolute, join, resolve } from "node:path";

/** One absolute database path for the store and for the update backup. A relative
 * `USAGE_OBSERVATORY_DB` resolves against the working directory, as it always has. */
export function resolveDbPath(env: Record<string, string | undefined> = process.env, cwd = process.cwd()) {
  const configured = env.USAGE_OBSERVATORY_DB;
  if (!configured) return join(resolve(cwd), ".usage-observatory", "data.db");
  return isAbsolute(configured) ? configured : resolve(cwd, configured);
}
