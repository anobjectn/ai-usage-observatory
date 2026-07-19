import { join } from "node:path";
import { blocksReportSchema, unifiedReportSchema } from "./schema";

const binary = join(process.cwd(), "node_modules", ".bin", "ccusage");

async function invoke(args: string[]) {
  const child = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(stderr.trim() || `ccusage exited with ${code}`);
  return JSON.parse(stdout);
}

export async function ccusageVersion() {
  const child = Bun.spawn([binary, "--version"], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  await child.exited;
  return output.trim().replace(/^ccusage\s+/, "");
}

export async function collectCcusage() {
  const since = new Date(Date.now() - 120 * 86_400_000).toISOString().slice(0, 10);
  const [unified, blocks, version] = await Promise.all([
    invoke(["daily", "--sections", "daily,weekly,monthly,session", "--by-agent", "--json", "--offline", "--since", since]).then((value) => unifiedReportSchema.parse(value)),
    invoke(["blocks", "--recent", "--json", "--offline"]).then((value) => blocksReportSchema.parse(value)),
    ccusageVersion(),
  ]);
  return { unified, blocks, version };
}
