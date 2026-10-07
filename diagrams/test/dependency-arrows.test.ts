import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DependencyArrows } from "../src/primitives/DependencyGraph";

const paths = [{ d: "M 0 0 L 100 0", len: 100 }, { d: "M 100 0 L 200 0", len: 100 }];
const html = renderToStaticMarkup(createElement("svg", null, createElement(DependencyArrows, { paths })));

describe("DependencyArrows layer order", () => {
  it("draws halos, then strokes, then heads", () => {
    const at = (l: string) => html.indexOf(`data-layer="${l}"`);
    expect(at("halo")).toBeGreaterThan(-1);
    expect(at("halo")).toBeLessThan(at("stroke"));
    expect(at("stroke")).toBeLessThan(at("head"));
  });
  it("puts every background halo before any arrowhead", () => {
    const firstHead = html.indexOf("marker-end");
    expect(firstHead).toBeGreaterThan(-1);
    const headLayer = html.slice(html.indexOf('data-layer="head"'));
    expect((headLayer.match(/marker-end/g) ?? []).length).toBe(paths.length);
    expect(html.slice(0, html.indexOf('data-layer="head"'))).not.toContain("marker-end");
  });
});
