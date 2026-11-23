import { expect, test } from "bun:test";
import {
  defaultHeadroomLines,
  defaultProviderColors,
  headroomLinesStorageKey,
  providerColorsStorageKey,
  saveHeadroomLines,
  savedHeadroomLines,
  savedProviderColors,
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

test("Antigravity defaults to Google Blue and the Google label to a distinct Google Green", () => {
  expect(defaultProviderColors.antigravity).toBe("#4285f4");
  expect(defaultProviderColors.google).toBe("#34a853");
  expect(defaultProviderColors.google).not.toBe(defaultProviderColors.antigravity);
});

test("both Google colours are adjustable and survive a reload", () => {
  withStorage((stored) => {
    stored.set(providerColorsStorageKey, JSON.stringify({ ...defaultProviderColors, antigravity: "#1a73e8", google: "#fbbc05" }));
    expect(savedProviderColors()).toMatchObject({ antigravity: "#1a73e8", google: "#fbbc05" });
    // A malformed value falls back to its default without disturbing the others.
    stored.set(providerColorsStorageKey, JSON.stringify({ anthropic: "#123456", google: "green" }));
    expect(savedProviderColors()).toMatchObject({ anthropic: "#123456", google: "#34a853", antigravity: "#4285f4" });
  });
});

test("Antigravity's weekly headroom line is on by default and its five-hour line off", () => {
  withStorage(() => {
    expect(savedHeadroomLines()).toEqual(defaultHeadroomLines);
    expect(defaultHeadroomLines).toContain("headroomAntigravity");
    expect(defaultHeadroomLines).not.toContain("fiveHourHeadroomAntigravity");
  });
});

test("a choice saved before Antigravity's lines existed keeps its own lines and gives the new ones their default", () => {
  withStorage((stored) => {
    stored.set(headroomLinesStorageKey, JSON.stringify(["headroomAnthropic", "fiveHourHeadroomCodex"]));
    expect(savedHeadroomLines()).toEqual(["headroomAnthropic", "headroomAntigravity", "fiveHourHeadroomCodex"]);
  });
});

test("a saved choice switching an Antigravity line off stays off", () => {
  withStorage((stored) => {
    saveHeadroomLines(["headroomCodex", "fiveHourHeadroomAntigravity"]);
    expect(JSON.parse(stored.get(headroomLinesStorageKey)!).known).toContain("headroomAntigravity");
    expect(savedHeadroomLines()).toEqual(["headroomCodex", "fiveHourHeadroomAntigravity"]);
    stored.set(headroomLinesStorageKey, "{not json");
    expect(savedHeadroomLines()).toEqual(defaultHeadroomLines);
  });
});
