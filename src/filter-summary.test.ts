import { describe, expect, test } from "bun:test";
import { agentEntry, modelEntry } from "./agent-filter";
import { filterEmptyMessage } from "./filter-summary";

describe("filtered widget empty message", () => {
  test("uses a generic message when nothing narrows the widget", () => {
    expect(filterEmptyMessage([], "all", "all")).toBe(
      "No data is available for this widget.",
    );
  });

  test("describes agent and model selections", () => {
    expect(filterEmptyMessage([agentEntry("claude")], "all", "all")).toBe(
      "No data matches Agent: claude.",
    );
    expect(filterEmptyMessage([modelEntry("gpt-5.6-sol")], "all", "all")).toBe(
      "No data matches Agent: gpt-5.6-sol.",
    );
    expect(
      filterEmptyMessage(
        [agentEntry("claude"), modelEntry("gpt-5.6-sol")],
        "all",
        "all",
      ),
    ).toBe("No data matches Agent: claude + gpt-5.6-sol.");
  });

  test("describes range, path, and combined narrowing", () => {
    expect(filterEmptyMessage([], "30", "all")).toBe(
      "No data matches Range: 30 days.",
    );
    expect(filterEmptyMessage([], "all", "observatory")).toBe(
      "No data matches Path: observatory.",
    );
    expect(
      filterEmptyMessage(
        [agentEntry("claude")],
        "1",
        "observatory",
      ),
    ).toBe(
      "No data matches Agent: claude · Range: 1 day · Path: observatory.",
    );
    expect(
      filterEmptyMessage([], "custom", "all", { from: "2026-07-01", to: "2026-07-10" }),
    ).toBe("No data matches Range: Jul 1–Jul 10, 2026.");
  });
});
