import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { PieGlyph } from "./components/pie-glyph";

const render = (share: number, label?: string) => renderToStaticMarkup(createElement(PieGlyph, { share, label }));

describe("PieGlyph", () => {
  test("draws a wedge for a partial share, a disc for a whole one, and none for zero", () => {
    expect(render(0.25)).toContain("<path");
    expect(render(1)).not.toContain("<path");
    expect(render(1).match(/<circle/g)?.length).toBe(2);
    expect(render(0)).not.toContain("<path");
    expect(render(0).match(/<circle/g)?.length).toBe(1);
  });

  test("a quarter ends at three o'clock and more than half uses the large arc", () => {
    expect(render(0.25)).toContain("A5.5 5.5 0 0 1 13.500 8.000");
    expect(render(0.75)).toContain("A5.5 5.5 0 1 1");
  });

  test("a sliver stays visible and labelled glyphs are announced", () => {
    expect(render(0.001)).toContain("<path");
    expect(render(0.5, "Half left")).toContain('aria-label="Half left"');
    expect(render(0.5)).toContain('aria-hidden="true"');
  });
});
