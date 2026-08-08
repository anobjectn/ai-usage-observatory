import { describe, expect, test } from "bun:test";
import {
  detailOutputSampleCharacters,
  detailOutputSampleCount,
  parseSessionDetailJsonl,
} from "./session-detail";

const jsonl = (...rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n");

describe("on-demand session output samples", () => {
  test("keeps Claude assistant text while excluding thinking and tool payloads", () => {
    const detail = parseSessionDetailJsonl(
      jsonl(
        {
          type: "assistant",
          timestamp: "2026-08-08T12:00:00.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "private reasoning" },
              { type: "text", text: "Visible answer" },
              { type: "tool_use", name: "Read", input: { file_path: "secret" } },
            ],
          },
        },
        {
          type: "user",
          message: { content: [{ type: "tool_result", content: "command output" }] },
        },
      ),
    );

    expect(detail.outputs).toEqual([
      {
        text: "Visible answer",
        timestamp: "2026-08-08T12:00:00.000Z",
        truncated: false,
      },
    ]);
    expect(JSON.stringify(detail.outputs)).not.toContain("private reasoning");
    expect(JSON.stringify(detail.outputs)).not.toContain("command output");
  });

  test("keeps Codex output_text while excluding other response item types", () => {
    const detail = parseSessionDetailJsonl(
      jsonl(
        {
          type: "response_item",
          timestamp: "2026-08-08T13:00:00.000Z",
          payload: {
            type: "message",
            role: "assistant",
            content: [
              { type: "reasoning", text: "hidden" },
              { type: "output_text", text: "User-facing result" },
            ],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            output: "tool result",
          },
        },
      ),
    );

    expect(detail.outputs.map((output) => output.text)).toEqual(["User-facing result"]);
  });

  test("returns only the most recent bounded samples and marks clipped text", () => {
    const rows = Array.from({ length: 9 }, (_, index) => ({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `answer-${index}` }],
      },
    }));
    rows.push({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "x".repeat(detailOutputSampleCharacters + 1) },
        ],
      },
    });

    const detail = parseSessionDetailJsonl(jsonl(...rows));

    expect(detail.outputs).toHaveLength(detailOutputSampleCount);
    expect(detail.outputs[0]?.text).toBe("answer-2");
    expect(detail.outputs.at(-1)).toMatchObject({
      truncated: true,
      text: "x".repeat(detailOutputSampleCharacters),
    });
  });
});

describe("session file diff counts", () => {
  test("attributes apply_patch additions and deletions to each file", () => {
    const detail = parseSessionDetailJsonl(
      jsonl({
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          input: [
            "*** Begin Patch",
            "*** Update File: src/a.ts",
            "@@",
            "-before",
            "+after",
            "+another line",
            "*** Add File: src/b.ts",
            "+first line",
            "+second line",
            "*** End Patch",
          ].join("\n"),
        },
      }),
    );

    expect(detail.files).toEqual([
      {
        path: "src/a.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
      },
      {
        path: "src/b.ts",
        status: "added",
        additions: 2,
        deletions: 0,
      },
    ]);
    expect(detail.additions).toBe(4);
    expect(detail.deletions).toBe(1);
  });

  test("attributes Claude structured patch counts to the edited file", () => {
    const detail = parseSessionDetailJsonl(
      jsonl({
        type: "user",
        toolUseResult: {
          filePath: "src/c.ts",
          structuredPatch: [
            { lines: [" unchanged", "-before", "+after", "+another line"] },
          ],
        },
      }),
    );

    expect(detail.files).toEqual([
      {
        path: "src/c.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
      },
    ]);
  });

  test("marks per-file counts unavailable when only change metadata exists", () => {
    const detail = parseSessionDetailJsonl(
      jsonl({
        changes: {
          "src/unknown.ts": { type: "update" },
        },
      }),
    );

    expect(detail.files).toEqual([
      {
        path: "src/unknown.ts",
        status: "modified",
        additions: null,
        deletions: null,
      },
    ]);
  });

  test("reads counts from a structured unified diff", () => {
    const detail = parseSessionDetailJsonl(
      jsonl({
        changes: {
          "src/from-metadata.ts": {
            type: "update",
            unified_diff: "@@ -1 +1,2 @@\n-before\n+after\n+another line",
          },
        },
      }),
    );

    expect(detail.files).toEqual([
      {
        path: "src/from-metadata.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
      },
    ]);
    expect(detail.additions).toBe(2);
    expect(detail.deletions).toBe(1);
  });

  test("merges relative patch input with its absolute structured result", () => {
    const detail = parseSessionDetailJsonl(
      jsonl(
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "apply_patch",
            input: [
              "*** Begin Patch",
              "*** Update File: src/same.ts",
              "@@",
              "-before",
              "+after",
              "*** End Patch",
            ].join("\n"),
          },
        },
        {
          changes: {
            "/repo/src/same.ts": {
              type: "update",
              unified_diff: "@@ -1 +1 @@\n-before\n+after",
            },
          },
        },
      ),
    );

    expect(detail.files).toEqual([
      {
        path: "/repo/src/same.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
      },
    ]);
    expect(detail.additions).toBe(1);
    expect(detail.deletions).toBe(1);
  });
});
