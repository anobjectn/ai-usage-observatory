import { expect, test } from "bun:test";
import { runCommand } from "./subprocess";

test("collection commands return stdout and surface failed exit status", async () => {
  expect(await runCommand([process.execPath, "-e", 'console.log("fixture")'])).toBe("fixture\n");
  await expect(runCommand([process.execPath, "-e", 'console.error("fixture failure"); process.exit(2)'])).rejects.toThrow("fixture failure");
});

test("a stalled child is terminated and the next collection can run", async () => {
  await expect(runCommand([process.execPath, "-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], 100)).rejects.toThrow("timed out");
  expect(await runCommand([process.execPath, "-e", 'console.log("recovered")'])).toBe("recovered\n");
});

test("the options form runs in a directory, bounds output, and stops a process group", async () => {
  const { execCommand } = await import("./subprocess");
  expect(await runCommand([process.execPath, "-e", "console.log(process.cwd())"], { cwd: "/tmp" })).toMatch(/\/tmp\n$/);
  const long = await execCommand([process.execPath, "-e", 'console.log("x".repeat(5000))'], { maxOutput: 100 });
  expect(long.truncated).toBe(true);
  expect(long.stdout.length).toBeLessThanOrEqual(100);
  const marker = `/tmp/aiuo-subprocess-${process.pid}-${Date.now()}`;
  const script = `Bun.spawn(["sh", "-c", "sleep 0.6; touch ${marker}"]); setInterval(() => {}, 1000)`;
  const result = await execCommand([process.execPath, "-e", script], { timeoutMs: 200, processGroup: true });
  expect(result.timedOut).toBe(true);
  await Bun.sleep(800);
  expect(await Bun.file(marker).exists()).toBe(false);
});
