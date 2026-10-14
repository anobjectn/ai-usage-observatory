export const collectionTimeoutMs = 60_000;

export type CommandOptions = {
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Called with each decoded stdout and stderr chunk, for logs. */
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  /** Characters kept per stream. Output past the limit keeps its tail and sets `truncated`. */
  maxOutput?: number;
  /** Runs the child in its own process group, so a deadline also stops its descendants. */
  processGroup?: boolean;
};

export type CommandResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean };

const defaultMaxOutput = 16 * 1024 * 1024;

async function collect(stream: ReadableStream<Uint8Array>, name: "stdout" | "stderr", options: CommandOptions, state: { truncated: boolean }) {
  const decoder = new TextDecoder();
  const limit = options.maxOutput ?? defaultMaxOutput;
  let text = "";
  for await (const chunk of stream) {
    const part = decoder.decode(chunk, { stream: true });
    options.onOutput?.(part, name);
    text += part;
    if (text.length > limit) {
      text = text.slice(text.length - limit);
      state.truncated = true;
    }
  }
  return text + decoder.decode();
}

/** Runs a fixed argv without a shell and never throws for a failed exit. A deadline belongs to
 * this child (or its process group) only. SIGKILL also bounds a child that ignores SIGTERM. */
export async function execCommand(command: string[], options: CommandOptions = {}): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? collectionTimeoutMs;
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { ...(options.env ?? process.env), NO_COLOR: "1" },
    detached: options.processGroup === true,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      if (options.processGroup) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, timeoutMs);
  const state = { truncated: false };
  try {
    const [stdout, stderr, code] = await Promise.all([
      collect(child.stdout, "stdout", options, state), collect(child.stderr, "stderr", options, state), child.exited,
    ]);
    return { code: timedOut ? null : code, stdout, stderr, timedOut, truncated: state.truncated };
  } finally {
    clearTimeout(timer);
  }
}

/** Returns stdout or throws with the child's stderr. */
export async function runCommand(command: string[], options: number | CommandOptions = collectionTimeoutMs) {
  const settings = typeof options === "number" ? { timeoutMs: options } : options;
  const timeoutMs = settings.timeoutMs ?? collectionTimeoutMs;
  const result = await execCommand(command, settings);
  if (result.timedOut) throw new Error(`Command timed out after ${timeoutMs} ms`);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `Command exited with ${result.code}`);
  return result.stdout;
}
