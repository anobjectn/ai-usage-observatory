import { expect, test } from "bun:test";
import {
  appearanceModalSizeBounds,
  appearanceModalSizeStorageKey,
  benchmarkModalSizeBounds as bounds,
  benchmarkModalSizeStorageKey,
  normalizeModalSize,
  saveModalSize,
  savedModalSize,
} from "./app/preferences";

function withStorage(run: (stored: Map<string, string>) => void) {
  const stored = new Map<string, string>();
  const realStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  } as Storage;
  try {
    run(stored);
  } finally {
    globalThis.localStorage = realStorage;
  }
}

test("normalizeModalSize rounds, clamps, and rejects anything that is not a size", () => {
  expect(normalizeModalSize({ width: 800.4, height: 600.6 }, bounds)).toEqual({ width: 800, height: 601 });
  expect(normalizeModalSize({ width: 10, height: 10 }, bounds)).toEqual({
    width: bounds.minWidth,
    height: bounds.minHeight,
  });
  expect(normalizeModalSize({ width: 1e9, height: 1e9 }, bounds)).toEqual({
    width: bounds.max,
    height: bounds.max,
  });
  for (const bad of [null, undefined, "x", 5, {}, { width: 800 }, { width: "800", height: 600 }, { width: NaN, height: 600 }]) {
    expect(normalizeModalSize(bad, bounds)).toBeNull();
  }
});

test("the benchmark window size round-trips through storage and clearing restores the default", () => {
  withStorage((stored) => {
    expect(savedModalSize(benchmarkModalSizeStorageKey, bounds)).toBeNull();
    saveModalSize(benchmarkModalSizeStorageKey, { width: 1100, height: 700 });
    expect(savedModalSize(benchmarkModalSizeStorageKey, bounds)).toEqual({ width: 1100, height: 700 });
    saveModalSize(benchmarkModalSizeStorageKey, null);
    expect(stored.has(benchmarkModalSizeStorageKey)).toBe(false);
    expect(savedModalSize(benchmarkModalSizeStorageKey, bounds)).toBeNull();
    stored.set(benchmarkModalSizeStorageKey, "not json");
    expect(savedModalSize(benchmarkModalSizeStorageKey, bounds)).toBeNull();
  });
});

test("each window keeps its own saved size and floor", () => {
  withStorage(() => {
    saveModalSize(benchmarkModalSizeStorageKey, { width: 1100, height: 700 });
    expect(savedModalSize(appearanceModalSizeStorageKey, appearanceModalSizeBounds)).toBeNull();
    saveModalSize(appearanceModalSizeStorageKey, { width: 100, height: 900 });
    expect(savedModalSize(appearanceModalSizeStorageKey, appearanceModalSizeBounds)).toEqual({
      width: appearanceModalSizeBounds.minWidth,
      height: 900,
    });
    expect(savedModalSize(benchmarkModalSizeStorageKey, bounds)).toEqual({ width: 1100, height: 700 });
  });
});
