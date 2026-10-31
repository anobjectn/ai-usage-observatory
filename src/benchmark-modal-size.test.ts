import { expect, test } from "bun:test";
import {
  benchmarkModalSizeBounds,
  benchmarkModalSizeStorageKey,
  normalizeBenchmarkModalSize,
  saveBenchmarkModalSize,
  savedBenchmarkModalSize,
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

test("normalizeBenchmarkModalSize rounds, clamps, and rejects anything that is not a size", () => {
  expect(normalizeBenchmarkModalSize({ width: 800.4, height: 600.6 })).toEqual({ width: 800, height: 601 });
  expect(normalizeBenchmarkModalSize({ width: 10, height: 10 })).toEqual({
    width: benchmarkModalSizeBounds.minWidth,
    height: benchmarkModalSizeBounds.minHeight,
  });
  expect(normalizeBenchmarkModalSize({ width: 1e9, height: 1e9 })).toEqual({
    width: benchmarkModalSizeBounds.max,
    height: benchmarkModalSizeBounds.max,
  });
  for (const bad of [null, undefined, "x", 5, {}, { width: 800 }, { width: "800", height: 600 }, { width: NaN, height: 600 }]) {
    expect(normalizeBenchmarkModalSize(bad)).toBeNull();
  }
});

test("the benchmark window size round-trips through storage and clearing restores the default", () => {
  withStorage((stored) => {
    expect(savedBenchmarkModalSize()).toBeNull();
    saveBenchmarkModalSize({ width: 1100, height: 700 });
    expect(savedBenchmarkModalSize()).toEqual({ width: 1100, height: 700 });
    saveBenchmarkModalSize(null);
    expect(stored.has(benchmarkModalSizeStorageKey)).toBe(false);
    expect(savedBenchmarkModalSize()).toBeNull();
    stored.set(benchmarkModalSizeStorageKey, "not json");
    expect(savedBenchmarkModalSize()).toBeNull();
  });
});
