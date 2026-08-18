/**
 * Test-only protobuf encoder. The reader in `warp-protobuf.ts` was written
 * against bytes observed on the wire, so its tests encode messages the same way
 * a producer would rather than asserting against a recorded blob nobody can
 * read. Kept out of the test file itself because three suites build fixtures.
 */
export function varint(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return bytes;
}

export function varintField(field: number, value: number) {
  return [...varint((field << 3) | 0), ...varint(value)];
}

export function bytesField(field: number, payload: ArrayLike<number>) {
  return [...varint((field << 3) | 2), ...varint(payload.length), ...Array.from(payload)];
}

export function textField(field: number, value: string) {
  return bytesField(field, [...new TextEncoder().encode(value)]);
}

export function message(...parts: number[][]) {
  return parts.flat();
}

/** `google.protobuf.Timestamp` as Warp writes it: seconds in field 1. */
export function timestampField(field: number, seconds: number) {
  return bytesField(field, varintField(1, seconds));
}

/** One event of a Warp agent run: an id, an instant, and a single payload. */
export function warpEvent({
  id,
  seconds,
  payloadField,
  text,
}: {
  id: string;
  seconds: number;
  payloadField: number;
  text: string;
}) {
  return bytesField(
    5,
    message(textField(1, id), timestampField(14, seconds), bytesField(payloadField, textField(1, text))),
  );
}

export function warpTask(...events: number[][]) {
  return new Uint8Array(message(textField(1, "task-id"), textField(2, "A task"), ...events));
}
