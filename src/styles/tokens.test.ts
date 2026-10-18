import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { defaultAccent, defaultProviderColors } from "../app/preferences";

const tokens = await Bun.file(new URL("./tokens.css", import.meta.url)).text();
const declared = (name: string) => tokens.match(new RegExp(`\\n\\s*--${name}:\\s*([^;]+);`))?.[1];
const resolve = (name: string): string | undefined => {
  const value = declared(name);
  const alias = value?.match(/^var\(--([a-z0-9-]+)\)$/);
  return alias ? resolve(alias[1]) : value;
};

describe("design tokens", () => {
  test("runtime defaults match the stylesheet defaults", () => {
    // App.tsx overwrites these at runtime; the stylesheet values paint before it runs.
    expect(resolve("color-accent")).toBe(defaultAccent);
    expect(resolve("color-provider-anthropic")).toBe(defaultProviderColors.anthropic);
    expect(resolve("color-provider-openai")).toBe(defaultProviderColors.openai);
    expect(resolve("color-provider-warp")).toBe(defaultProviderColors.warp);
  });

  test("palette values are read only by tokens.css", async () => {
    for (const file of new Glob("src/**/*.{css,ts,tsx}").scanSync(".")) {
      if (file.endsWith("tokens.css") || file.endsWith("tokens.test.ts")) continue;
      expect({ file, palette: (await Bun.file(file).text()).match(/var\(--palette-[a-z0-9-]+\)/g) })
        .toEqual({ file, palette: null });
    }
  });

  test("every referenced custom property is declared", async () => {
    const defined = new Set<string>();
    const referenced = new Map<string, string>();
    for (const file of new Glob("src/**/*.{css,ts,tsx}").scanSync(".")) {
      if (file.endsWith(".test.ts")) continue;
      const text = await Bun.file(file).text();
      // CSS declarations, plus string literals in components (inline styles and setProperty).
      for (const [, name] of text.matchAll(/(?:^|[\s{;(])(--[a-z][a-z0-9-]*)\s*:/g)) defined.add(name);
      if (!file.endsWith(".css")) for (const [, name] of text.matchAll(/["'`](--[a-z][a-z0-9-]*)["'`]/g)) defined.add(name);
      for (const [, name] of text.matchAll(/var\((--[a-z][a-z0-9-]*[a-z0-9])[,)]/g)) referenced.set(name, file);
    }
    const missing = [...referenced].filter(([name]) => !defined.has(name)).map(([name, file]) => `${name} (${file})`);
    expect(missing).toEqual([]);
  });

  test("stylesheets use tokens for font sizes and radii", async () => {
    for (const file of new Glob("src/styles/**/*.css").scanSync(".")) {
      if (file.endsWith("tokens.css")) continue;
      const text = await Bun.file(file).text();
      // A line height after the slash in a font shorthand may stay literal; the size may not.
      const raw = [
        ...(text.match(/font-size\s*:[^;]*\b\d+(?:\.\d+)?(?:px|r?em)\b/g) ?? []),
        ...(text.match(/font\s*:[^;/]*?\b\d+(?:\.\d+)?(?:px|r?em)\b/g) ?? []),
        ...(text.match(/border(?:-[a-z]+)*-radius\s*:[^;]*\b\d+(?:\.\d+)?(?:px|r?em)\b/g) ?? []),
      ];
      expect({ file, raw }).toEqual({ file, raw: [] });
    }
  });

  test("stylesheets use tokens instead of raw colours", async () => {
    for (const file of new Glob("src/styles/**/*.css").scanSync(".")) {
      if (file.endsWith("tokens.css")) continue;
      // Mask gradients use #000 for opacity only; they carry no colour.
      const raw = (await Bun.file(file).text())
        .replace(/(?:-webkit-)?mask:[^;]+;/g, "")
        .match(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/gi);
      expect({ file, raw }).toEqual({ file, raw: null });
    }
  });
});
