import { describe, expect, it } from "vitest";
import { edgePoints, layoutArchitecture } from "../src/primitives/layout";

const d = {
  title: "T",
  zones: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
  nodes: [
    { id: "n1", label: "N1", kind: "edge" as const, zone: "a" },
    { id: "n2", label: "N2", kind: "compute" as const, zone: "b" },
    { id: "n3", label: "N3", kind: "data" as const, zone: "b" },
  ],
  edges: [],
};

describe("layoutArchitecture", () => {
  const l = layoutArchitecture(d, 1200, 675);
  it("places zones left to right in declaration order", () => {
    expect(l.zones.a!.x).toBeLessThan(l.zones.b!.x);
  });
  it("keeps every node inside its zone and inside the canvas", () => {
    for (const n of d.nodes) {
      const r = l.nodes[n.id]!, z = l.zones[n.zone]!;
      expect(r.x).toBeGreaterThanOrEqual(z.x);
      expect(r.x + r.w).toBeLessThanOrEqual(z.x + z.w);
      expect(r.y + r.h).toBeLessThanOrEqual(675);
    }
  });
  it("stacks nodes of one zone without overlap", () => {
    expect(l.nodes.n2!.y + l.nodes.n2!.h).toBeLessThanOrEqual(l.nodes.n3!.y);
  });
});

describe("edgePoints", () => {
  it("connects facing sides of horizontally separated boxes", () => {
    const p = edgePoints({ x: 0, y: 0, w: 100, h: 40 }, { x: 300, y: 0, w: 100, h: 40 });
    expect(p).toEqual({ x1: 100, y1: 20, x2: 300, y2: 20 });
  });
  it("connects top/bottom for vertically stacked boxes", () => {
    const p = edgePoints({ x: 0, y: 0, w: 100, h: 40 }, { x: 0, y: 200, w: 100, h: 40 });
    expect(p).toEqual({ x1: 50, y1: 40, x2: 50, y2: 200 });
  });
});
