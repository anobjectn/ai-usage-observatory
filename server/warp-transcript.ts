import { bytesOf, decodeText, fieldOf, messageOf, textOf, timestampSecondsOf } from "./warp-protobuf";

/**
 * Warp records each agent run as a protobuf blob in `agent_tasks.task`. A run
 * holds a repeated list of events, and each event carries exactly one payload:
 * what the person typed, what the agent said back, or the agent's own reasoning
 * summary.
 *
 * The field numbers below were read off the wire, because Warp publishes no
 * schema for this table. They are therefore treated as a best-effort mapping: if
 * a Warp update renumbers them, every read here fails closed and the session
 * simply shows no transcript rather than showing the wrong text.
 */
const taskEventField = 5;
const eventIdField = 1;
const eventTimestampField = 14;
const payloadTextField = 1;
/** One event carries one of these. `reasoning` is decoded so it can be counted
 * and deliberately excluded, matching how the JSONL readers drop thinking
 * blocks from the sampled output. */
const payloadFields = [
  [2, "user"],
  [3, "assistant"],
  [15, "reasoning"],
] as const;

/**
 * Warp's event seconds are not epoch instants: they are the local wall clock at
 * the time of the event, serialized as if that reading were UTC. Checked against
 * the same turn in `ai_queries`, whose `start_ts` is a local wall-clock string —
 * both describe 12:35:56 local, and reading the seconds as UTC would place every
 * reply hours away from the prompt it answered. Reinterpreting the fields in the
 * local zone matches how `warpTimestamp` handles that column.
 */
function warpEventInstant(seconds: number | null) {
  if (seconds === null) return null;
  const asUtc = new Date(seconds * 1000);
  const local = new Date(
    asUtc.getUTCFullYear(),
    asUtc.getUTCMonth(),
    asUtc.getUTCDate(),
    asUtc.getUTCHours(),
    asUtc.getUTCMinutes(),
    asUtc.getUTCSeconds(),
  );
  return Number.isFinite(local.getTime()) ? local.toISOString() : null;
}

export type WarpTranscriptEvent = {
  id: string | null;
  kind: "user" | "assistant" | "reasoning";
  text: string;
  timestamp: string | null;
};

/** A single run is bounded work, but the table holds multi-megabyte blobs; these
 * keep one pathological conversation from stalling a detail request. */
export const maxTaskBytes = 8_000_000;
const maxEventsPerTask = 4_000;

export function parseWarpTaskEvents(task: Uint8Array): WarpTranscriptEvent[] {
  if (task.length === 0 || task.length > maxTaskBytes) return [];
  const message = messageOf(task);
  if (!message) return [];
  const events: WarpTranscriptEvent[] = [];
  for (const entry of message) {
    if (entry.field !== taskEventField || entry.kind !== "bytes") continue;
    if (events.length >= maxEventsPerTask) break;
    const fields = messageOf(entry.value);
    if (!fields) continue;
    const timestamp = warpEventInstant(timestampSecondsOf(fields, eventTimestampField));
    const id = decodeText(bytesOf(fields, eventIdField));
    for (const [field, kind] of payloadFields) {
      const payload = fieldOf(fields, field);
      if (payload?.kind !== "bytes") continue;
      const inner = messageOf(payload.value);
      if (!inner) continue;
      const text = textOf(inner, payloadTextField)?.trim();
      if (!text) continue;
      events.push({ id, kind, text, timestamp });
    }
  }
  return events;
}

/** Runs are snapshots, so two rows of the same conversation can carry the same
 * event. Ordering is by recorded instant with the event id breaking ties, since
 * a run's rows are not guaranteed to be written in event order. */
export function mergeWarpTaskEvents(tasks: Uint8Array[]): WarpTranscriptEvent[] {
  const byKey = new Map<string, WarpTranscriptEvent>();
  for (const task of tasks) {
    for (const event of parseWarpTaskEvents(task)) {
      byKey.set(event.id ? `${event.kind}:${event.id}` : `${event.kind}:${event.timestamp}:${event.text}`, event);
    }
  }
  return [...byKey.values()].sort(
    (left, right) =>
      String(left.timestamp ?? "").localeCompare(String(right.timestamp ?? "")) ||
      String(left.id ?? "").localeCompare(String(right.id ?? "")),
  );
}
