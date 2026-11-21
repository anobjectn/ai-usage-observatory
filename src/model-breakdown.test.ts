import { describe, expect, test } from "bun:test";
import { addOneHourWrites } from "./types";

describe("addOneHourWrites", () => {
  test("sums the 1-hour split while every contributor reports it", () => {
    const current = { cacheCreation1hTokens: 0 };
    addOneHourWrites(current, { cacheCreation1hTokens: 100 });
    addOneHourWrites(current, { cacheCreation1hTokens: 50 });
    expect(current.cacheCreation1hTokens).toBe(150);
  });

  test("drops the split once any contributor lacks it", () => {
    const current: { cacheCreation1hTokens?: number } = { cacheCreation1hTokens: 0 };
    addOneHourWrites(current, { cacheCreation1hTokens: 100 });
    addOneHourWrites(current, {});
    addOneHourWrites(current, { cacheCreation1hTokens: 50 });
    expect("cacheCreation1hTokens" in current).toBe(false);
  });
});
