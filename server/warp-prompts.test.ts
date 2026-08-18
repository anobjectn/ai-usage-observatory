import { describe, expect, test } from "bun:test";
import { parseWarpQueryInput } from "./warp-prompts";

const input = (...variants: unknown[]) => JSON.stringify(variants);

describe("Warp query input parsing", () => {
  test("reads the typed prompt out of a Query variant", () => {
    expect(
      parseWarpQueryInput(
        input({
          Query: {
            text: "  resolve the port conflict  ",
            context: [{ Directory: { pwd: "/Users/luis" } }],
          },
        }),
      ),
    ).toEqual(["resolve the port conflict"]);
  });

  test("reads a RefineUserQuery follow-up, which is also user-authored", () => {
    expect(parseWarpQueryInput(input({ RefineUserQuery: { query: "narrow it to tags" } }))).toEqual([
      "narrow it to tags",
    ]);
  });

  // ActionResult is the agent reporting a tool outcome to itself. Treating it as a
  // prompt would attribute the agent's own bookkeeping to the person.
  test("ignores ActionResult turns", () => {
    expect(
      parseWarpQueryInput(
        input(
          { ActionResult: { id: "abc", result: { SuggestCreatePlan: { result: "Proceed" } } } },
          { Query: { text: "and now deploy" } },
        ),
      ),
    ).toEqual(["and now deploy"]);
  });

  test("returns nothing for unparseable, empty, or unknown input", () => {
    expect(parseWarpQueryInput("not json at all")).toEqual([]);
    expect(parseWarpQueryInput(input({ Query: { text: "   " } }))).toEqual([]);
    expect(parseWarpQueryInput(input({ SomethingNew: { text: "later schema" } }))).toEqual([]);
  });

  test("accepts a bare object as well as the array Warp writes today", () => {
    expect(parseWarpQueryInput(JSON.stringify({ Query: { text: "bare" } }))).toEqual(["bare"]);
  });
});
