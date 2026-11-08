/** Session transcripts on disk, plain or compressed. Since its 2026-10-14 update Codex compresses
 * older rollouts in place (`rollout-….jsonl` becomes `rollout-….jsonl.zst`), and ccusage 20.0.33+
 * reads both. Every reader in the server goes through here, so a compressed log is the same
 * session, with the same ID, keys, and text, as the plain file it replaced. */
import { basename } from "node:path";

const compressedExtension = ".jsonl.zst";

export function isCompressedTranscript(path: string) {
  return path.endsWith(compressedExtension);
}

/** The path the transcript had before compression. Session IDs and report keys derive from this
 * form, so compressing a log never changes its identity. */
export function plainTranscriptPath(path: string) {
  return isCompressedTranscript(path) ? path.slice(0, -".zst".length) : path;
}

/** File name without `.jsonl` or `.jsonl.zst`. */
export function transcriptStem(path: string) {
  return basename(plainTranscriptPath(path), ".jsonl");
}

/** Decompressed bytes as a stream. `DecompressionStream("zstd")` keeps a large log out of memory;
 * a runtime without it falls back to decompressing the whole file at once. */
export function transcriptStream(path: string): ReadableStream<Uint8Array> {
  const raw = Bun.file(path).stream();
  if (!isCompressedTranscript(path)) return raw;
  try {
    return raw.pipeThrough(new DecompressionStream("zstd" as CompressionFormat));
  } catch {
    void raw.cancel();
    return new ReadableStream({
      async start(controller) {
        try {
          controller.enqueue(Bun.zstdDecompressSync(await Bun.file(path).bytes()));
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
  }
}

/** Up to `maxBytes` of the transcript's text from the start. A compressed log stops
 * decompressing once the window is full. */
export async function readTranscriptHead(path: string, maxBytes: number) {
  if (!isCompressedTranscript(path)) return Bun.file(path).slice(0, maxBytes).text();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = transcriptStream(path).getReader();
  try {
    while (length < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const piece = value.subarray(0, maxBytes - length);
      chunks.push(piece);
      length += piece.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

/** Byte ranges of a transcript, read in order. A plain file is read by range and its size is
 * known; a compressed log decompresses forward only, so `size` is unknown (`Infinity`), reads
 * must not move backwards, and the end shows up as a short or empty read. */
export type TranscriptReader = {
  size: number;
  read(from: number, to: number): Promise<Uint8Array>;
  close(): Promise<void>;
};

export function openTranscriptReader(path: string, plainSize: number): TranscriptReader {
  if (!isCompressedTranscript(path)) {
    return {
      size: plainSize,
      read: async (from, to) => new Uint8Array(await Bun.file(path).slice(from, to).arrayBuffer()),
      close: async () => undefined,
    };
  }
  const stream = transcriptStream(path).getReader();
  // `buffered` holds decompressed bytes starting at offset `start`.
  let buffered = new Uint8Array(0);
  let start = 0;
  let ended = false;
  return {
    size: Number.POSITIVE_INFINITY,
    async read(from, to) {
      if (from < start) throw new Error(`Compressed transcript read moved backwards (${from} < ${start})`);
      while (!ended && start + buffered.length < to) {
        const { done, value } = await stream.read();
        if (done) {
          ended = true;
          break;
        }
        const merged = new Uint8Array(buffered.length + value.length);
        merged.set(buffered);
        merged.set(value, buffered.length);
        buffered = merged;
      }
      // Drop what lies before `from`; reads only move forward.
      buffered = buffered.subarray(Math.min(buffered.length, from - start));
      start = from;
      return buffered.slice(0, Math.max(0, to - from));
    },
    close: () => stream.cancel().catch(() => undefined),
  };
}
