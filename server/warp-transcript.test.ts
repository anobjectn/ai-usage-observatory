import { describe, expect, test } from "bun:test";
import { bytesField, message, textField, varintField, warpEvent, warpTask } from "./warp-fixture";
import { decodeMessage, messageOf, textOf, timestampSecondsOf } from "./warp-protobuf";
import { mergeWarpTaskEvents, parseWarpTaskEvents } from "./warp-transcript";

const userEvent = (id: string, seconds: number, text: string) =>
  warpEvent({ id, seconds, payloadField: 2, text });
const assistantEvent = (id: string, seconds: number, text: string) =>
  warpEvent({ id, seconds, payloadField: 3, text });
const reasoningEvent = (id: string, seconds: number, text: string) =>
  warpEvent({ id, seconds, payloadField: 15, text });

describe("protobuf wire reading", () => {
  test("reads varints, strings, and nested messages", () => {
    const fields = decodeMessage(new Uint8Array(message(varintField(1, 300), textField(2, "hello"))));
    expect(fields[0]).toEqual({ field: 1, kind: "varint", value: 300n });
    expect(textOf(fields, 2)).toBe("hello");
  });

  test("skips fixed-width fields it does not need instead of failing", () => {
    const fixed64Tag = (3 << 3) | 1;
    const fields = decodeMessage(
      new Uint8Array([fixed64Tag, 1, 2, 3, 4, 5, 6, 7, 8, ...textField(4, "after")]),
    );
    expect(textOf(fields, 4)).toBe("after");
  });

  test("reports bytes that are not a message rather than inventing fields", () => {
    expect(messageOf(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).toBeNull();
    // Field number zero is invalid in protobuf and marks these bytes as something else.
    expect(messageOf(new Uint8Array([0x00, 0x01]))).toBeNull();
  });

  test("reads a timestamp's seconds without interpreting them", () => {
    const fields = decodeMessage(new Uint8Array(bytesField(14, varintField(1, 1_786_978_215))));
    expect(timestampSecondsOf(fields, 14)).toBe(1_786_978_215);
  });

  test("treats non-UTF-8 bytes as absent rather than mangling them", () => {
    const fields = decodeMessage(new Uint8Array(bytesField(1, [0xc3, 0x28])));
    expect(textOf(fields, 1)).toBeNull();
  });
});

describe("Warp agent-run events", () => {
  test("separates what was typed, what came back, and what was reasoning", () => {
    const events = parseWarpTaskEvents(
      warpTask(
        userEvent("a", 100, "  fix the build  "),
        assistantEvent("b", 101, "Reading the failing job."),
        reasoningEvent("c", 102, "The user wants the build fixed."),
      ),
    );
    expect(events.map((event) => [event.kind, event.text])).toEqual([
      ["user", "fix the build"],
      ["assistant", "Reading the failing job."],
      ["reasoning", "The user wants the build fixed."],
    ]);
    // Warp writes the local wall clock into a field typed as an epoch instant, so
    // 100 seconds "UTC" is read back as 00:01:40 local, not as 00:01:40Z.
    expect(events[0]?.timestamp).toBe(new Date(1970, 0, 1, 0, 1, 40).toISOString());
  });

  test("returns nothing for a blob that is not a Warp run", () => {
    expect(parseWarpTaskEvents(new Uint8Array([0xff, 0x00, 0xff]))).toEqual([]);
    expect(parseWarpTaskEvents(new Uint8Array())).toEqual([]);
  });

  // Runs are snapshots, so a later row repeats events the earlier row already held.
  test("merges overlapping runs by event id and orders them by instant", () => {
    const first = warpTask(userEvent("a", 100, "first"), assistantEvent("b", 101, "second"));
    const second = warpTask(assistantEvent("b", 101, "second"), assistantEvent("c", 102, "third"));
    expect(mergeWarpTaskEvents([first, second]).map((event) => event.text)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  test("keeps a run whose events are stored out of order in instant order", () => {
    const task = warpTask(assistantEvent("b", 200, "later"), userEvent("a", 100, "earlier"));
    expect(mergeWarpTaskEvents([task]).map((event) => event.text)).toEqual(["earlier", "later"]);
  });
});
