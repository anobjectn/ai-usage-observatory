/**
 * A minimal protobuf wire-format reader, enough to walk a message whose schema
 * is not published. Warp stores agent transcripts as serialized protobuf in
 * `agent_tasks.task` and ships no `.proto` for it, so fields are addressed by
 * number and every read is defensive: a schema change downstream should yield
 * nothing rather than a crash or a wrong answer.
 *
 * Only the two wire types this needs are decoded into values; the other two are
 * skipped by width so a message containing them still parses.
 */
export type WireField = { field: number; kind: "varint"; value: bigint } | { field: number; kind: "bytes"; value: Uint8Array };

const maxFieldNumber = 512;

function readVarint(buffer: Uint8Array, start: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let position = start;
  while (position < buffer.length) {
    const byte = buffer[position++]!;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, position];
    shift += 7n;
    // A varint wider than 64 bits is not something this format produces; it means
    // the bytes are not a message at all.
    if (shift > 63n) throw new Error("varint too wide");
  }
  throw new Error("truncated varint");
}

/** Throws on anything that is not a well-formed message, so callers can treat a
 * throw as "these bytes are not protobuf" rather than inspecting the damage. */
export function decodeMessage(buffer: Uint8Array): WireField[] {
  const fields: WireField[] = [];
  let position = 0;
  while (position < buffer.length) {
    const [tag, afterTag] = readVarint(buffer, position);
    position = afterTag;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (field === 0 || field > maxFieldNumber) throw new Error("implausible field number");
    if (wire === 0) {
      const [value, next] = readVarint(buffer, position);
      position = next;
      fields.push({ field, kind: "varint", value });
    } else if (wire === 2) {
      const [length, afterLength] = readVarint(buffer, position);
      const size = Number(length);
      const end = afterLength + size;
      if (size < 0 || end > buffer.length) throw new Error("truncated length-delimited field");
      fields.push({ field, kind: "bytes", value: buffer.subarray(afterLength, end) });
      position = end;
    } else if (wire === 5) {
      position += 4;
      if (position > buffer.length) throw new Error("truncated fixed32");
    } else if (wire === 1) {
      position += 8;
      if (position > buffer.length) throw new Error("truncated fixed64");
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
  return fields;
}

export function messageOf(buffer: Uint8Array): WireField[] | null {
  try {
    return decodeMessage(buffer);
  } catch {
    return null;
  }
}

export function fieldOf(fields: WireField[], field: number) {
  return fields.find((entry) => entry.field === field);
}

export function bytesOf(fields: WireField[], field: number) {
  const found = fieldOf(fields, field);
  return found?.kind === "bytes" ? found.value : null;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Strings are only accepted as strings: bytes that are not valid UTF-8 are some
 * other field this reader has misidentified, and are reported as absent. */
export function decodeText(bytes: Uint8Array | null) {
  if (!bytes) return null;
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

export function textOf(fields: WireField[], field: number) {
  return decodeText(bytesOf(fields, field));
}

/** Reads the seconds out of a `google.protobuf.Timestamp`, which holds them in
 * field 1. The caller decides what the number means, because Warp's are not the
 * epoch instants the type implies. */
export function timestampSecondsOf(fields: WireField[], field: number) {
  const bytes = bytesOf(fields, field);
  if (!bytes) return null;
  const message = messageOf(bytes);
  if (!message) return null;
  const seconds = fieldOf(message, 1);
  if (seconds?.kind !== "varint") return null;
  const value = Number(seconds.value);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
