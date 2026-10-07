import { describe, expect, it } from "vitest";
import { CANVAS_GRID, CANVAS_PAD, canvasSize, CAPTION_PX, STEP_LIST_BADGE, STEP_LIST_PX, TITLE_LINE_H, TITLE_PX } from "../src/aws/canvas";
import { textWidth } from "../src/aws/measure";
import { gifScale, stepPanelHeight } from "../src/aws/timing";

const narrow = { width: 366, height: 300 };

describe("canvasSize", () => {
  it("keeps a wide diagram's own size when its texts are short", () => {
    const c = canvasSize({ title: "T", steps: [] }, { width: 900, height: 400 });
    expect(c).toEqual({ width: 900, height: 400, dx: 0, dy: 0, titleLines: ["T"] });
  });
  it("widens a narrow diagram to fit a long title on one line and centres the diagram", () => {
    const title = "A".repeat(70);
    const c = canvasSize({ title, steps: [] }, narrow);
    expect(c.width).toBeGreaterThanOrEqual(textWidth(title, TITLE_PX) + 2 * CANVAS_PAD);
    expect(c.titleLines).toEqual([title]);
    expect(c.dx).toBe(Math.round((c.width - narrow.width) / 2));
    expect(c.dy).toBe(0);
  });
  it("widens for the subtitle, the caption bar and the step list", () => {
    const caption = "x".repeat(90);
    const c = canvasSize({ title: "T", subtitle: "s".repeat(110), steps: [{ edges: ["a"], caption }] }, narrow);
    expect(c.width).toBeGreaterThanOrEqual(textWidth(`1. ${caption}`, CAPTION_PX) + 2 * CANVAS_PAD);
    expect(c.width).toBeGreaterThanOrEqual(STEP_LIST_BADGE + textWidth(caption, STEP_LIST_PX) + 2 * CANVAS_PAD);
    expect(c.width).toBeGreaterThanOrEqual(textWidth("s".repeat(110), 14) + 2 * CANVAS_PAD);
    expect(c.height).toBe(Math.ceil((narrow.height + stepPanelHeight(1)) / CANVAS_GRID) * CANVAS_GRID);
  });
  it("wraps a title too wide for 1200px inside the title band and pushes the diagram down", () => {
    const title = Array.from({ length: 30 }, () => "Wwwwwwwwww").join(" ");
    const c = canvasSize({ title, steps: [] }, narrow);
    expect(c.titleLines).toHaveLength(2);
    expect(c.dy).toBe(TITLE_LINE_H);
    expect(c.height).toBe(Math.ceil((narrow.height + TITLE_LINE_H) / CANVAS_GRID) * CANVAS_GRID);
  });
  it("rounds fractional layouts up to a 20px grid that every GIF scale maps to even whole pixels", () => {
    for (const layout of [{ width: 1170.37, height: 611.2 }, { width: 2843.9, height: 805.01 }, { width: 366.5, height: 299.9 }]) {
      const c = canvasSize({ title: "T", steps: [{ edges: ["a"], caption: "c" }] }, layout);
      expect(c.width % CANVAS_GRID).toBe(0);
      expect(c.height % CANVAS_GRID).toBe(0);
      expect(c.width).toBeGreaterThanOrEqual(layout.width);
      const s = gifScale(c.width);
      for (const side of [c.width * s, c.height * s]) {
        expect(Math.abs(side - Math.round(side))).toBeLessThan(1e-9);
        expect(Math.round(side) % 2).toBe(0);
      }
      expect(c.width * s).toBeLessThanOrEqual(1200);
    }
  });
});
