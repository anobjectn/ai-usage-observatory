import { describe, expect, test } from "bun:test";
import { headroomOrbitRate } from "./scene";

describe("headroom orbit rate", () => {
  test("uses neutral motion when headroom is unknown", () => {
    expect(headroomOrbitRate(null)).toBe(0.36);
    expect(headroomOrbitRate(Number.NaN)).toBe(0.36);
  });

  test("clamps known values to the designed endpoints", () => {
    expect(headroomOrbitRate(-20)).toBe(0.22);
    expect(headroomOrbitRate(0)).toBe(0.22);
    expect(headroomOrbitRate(100)).toBe(0.62);
    expect(headroomOrbitRate(140)).toBe(0.62);
  });

  test("strictly increases across representative known values", () => {
    const rates = [0, 25, 50, 75, 100].map(headroomOrbitRate);
    for (let index = 1; index < rates.length; index++) {
      expect(rates[index]).toBeGreaterThan(rates[index - 1]);
    }
  });
});
