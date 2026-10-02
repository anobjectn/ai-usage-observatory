export const collectionTimeoutMs = 60_000;

/** A deadline belongs to this child only. SIGKILL also bounds a child that ignores SIGTERM. */
export async function runCommand(command: string[], timeoutMs = collectionTimeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  const child = Bun.spawn(command, {
    stdout: "pipe", stderr: "pipe", signal, killSignal: "SIGKILL",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (signal.aborted) throw new Error(`Collection command timed out after ${timeoutMs} ms`);
  if (code !== 0) throw new Error(stderr.trim() || `Collection command exited with ${code}`);
  return stdout;
}
