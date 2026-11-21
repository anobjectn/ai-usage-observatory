import { expect, test } from "bun:test";
import {
  defaultSessionPageSize,
  normalizeSessionPageSize,
  pageAfterResize,
  savedSessionPageSize,
  saveSessionPageSize,
  sessionPageSizeOptions,
  sessionPageSizeStorageKey,
} from "./app/preferences";

test("normalizeSessionPageSize accepts only the offered sizes", () => {
  for (const size of sessionPageSizeOptions) {
    expect(normalizeSessionPageSize(size)).toBe(size);
    expect(normalizeSessionPageSize(String(size))).toBe(size);
  }
  for (const raw of [null, undefined, "", "0", "7", "-15", "15.5", "abc", 0, 1000, NaN, {}]) {
    expect(normalizeSessionPageSize(raw)).toBe(defaultSessionPageSize);
  }
});

test("savedSessionPageSize restores a stored size and falls back without storage", () => {
  const stored = new Map<string, string>();
  const realStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (key: string) => stored.get(key) ?? null } as Storage;
  try {
    expect(savedSessionPageSize()).toBe(defaultSessionPageSize);
    stored.set(sessionPageSizeStorageKey, "50");
    expect(savedSessionPageSize()).toBe(50);
    stored.set(sessionPageSizeStorageKey, "bogus");
    expect(savedSessionPageSize()).toBe(defaultSessionPageSize);
  } finally {
    globalThis.localStorage = realStorage;
  }
  expect(savedSessionPageSize()).toBe(defaultSessionPageSize);
});

test("saveSessionPageSize stores a size that savedSessionPageSize restores", () => {
  const stored = new Map<string, string>();
  const realStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  } as Storage;
  try {
    for (const size of sessionPageSizeOptions) {
      saveSessionPageSize(size);
      expect(stored.get(sessionPageSizeStorageKey)).toBe(String(size));
      expect(savedSessionPageSize()).toBe(size);
    }
  } finally {
    globalThis.localStorage = realStorage;
  }
  // Without storage the choice still applies until reload; saving must not throw.
  expect(() => saveSessionPageSize(50)).not.toThrow();
});

test("pageAfterResize lands on the page that holds the current page's first row", () => {
  // Page 3 at 15 rows starts at row 31 (index 30).
  expect(pageAfterResize(3, 15, 50)).toBe(1); // rows 1–50
  expect(pageAfterResize(3, 15, 10)).toBe(4); // rows 31–40
  expect(pageAfterResize(3, 15, 25)).toBe(2); // rows 26–50
  expect(pageAfterResize(1, 15, 100)).toBe(1);
  // Whichever page the reader lands on, its range holds the row that was first on screen.
  for (const [page, from] of [[1, 10], [7, 10], [4, 25], [2, 100], [9, 15]] as const) {
    for (const to of sessionPageSizeOptions) {
      const firstRow = (page - 1) * from;
      const next = pageAfterResize(page, from, to);
      expect(firstRow).toBeGreaterThanOrEqual((next - 1) * to);
      expect(firstRow).toBeLessThan(next * to);
    }
  }
});
