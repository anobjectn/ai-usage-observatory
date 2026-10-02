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
