import { describe, expect, it } from "vitest";
import { BADGE, BADGE_GAP, badgeCentres } from "../src/aws/badges";
import { layoutDiagram, type Point, type Rect } from "../src/aws/layout";
import { AwsDiagramData } from "../src/aws/schema";

const box = (p: Point): Rect => ({ x: p.x - BADGE / 2, y: p.y - BADGE / 2, w: BADGE, h: BADGE });
const gap = (a: Rect, b: Rect) => Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));
const line = (x1: number, x2: number, y = 0) => ({ points: [{ x: x1, y }, { x: x2, y }] });

describe("badgeCentres", () => {
  it("centres a badge on the longest segment of an unlabelled edge", () => {
    const edges = { a: { points: [{ x: 0, y: 0 }, { x: 0, y: 40 }, { x: 200, y: 40 }] } };
    expect(badgeCentres([{ edges: ["a"] }], edges, [])).toEqual([{ x: 100, y: 40 }]);
  });
  it("slides a badge off its edge's label with at least the gap", () => {
    const label = { x: 80, y: 4, w: 40, h: 16 };
    const [at] = badgeCentres([{ edges: ["a"] }], { a: { ...line(0, 300), label } }, []);
    expect(at!.y).toBe(0);
    expect(gap(box(at!), label)).toBeGreaterThanOrEqual(BADGE_GAP);
  });
  it("stacks badges of steps sharing an edge 26px apart along it", () => {
    const [a, b] = badgeCentres([{ edges: ["a"] }, { edges: ["a"] }], { a: line(0, 200) }, []);
    expect(a).toEqual({ x: 100, y: 0 });
    expect(b!.y).toBe(0);
    expect(Math.abs(b!.x - a!.x)).toBe(BADGE + BADGE_GAP);
  });
  it("keeps a badge off a group border the edge crosses", () => {
    const group = { x: 100, y: -50, w: 200, h: 100 };
    const [at] = badgeCentres([{ edges: ["a"] }], { a: line(0, 200) }, [group]);
    expect(Math.abs(at!.x - group.x)).toBeGreaterThanOrEqual(BADGE / 2 + BADGE_GAP);
  });
  it("clears every edge label in a real ELK layout", async () => {
    const d = AwsDiagramData.parse({
      title: "T",
      groups: [{ id: "cloud", kind: "aws-cloud", label: "AWS Cloud" }],
      nodes: [
        { id: "web", label: "Browser", icon: "client" },
        { id: "gw", label: "API Gateway", icon: "api-gateway", group: "cloud" },
        { id: "fn", label: "Handler", icon: "lambda", group: "cloud" },
      ],
      edges: [{ id: "a", from: "web", to: "gw", label: "HTTPS" }, { id: "b", from: "gw", to: "fn", label: "invoke" }],
      steps: [{ edges: ["a"], caption: "x" }, { edges: ["b"], caption: "y" }, { edges: ["a"], caption: "z" }],
    });
    const l = await layoutDiagram(d);
    const at = badgeCentres(d.steps, l.edges, Object.values(l.groups));
    for (const p of at) for (const e of Object.values(l.edges)) if (e.label) expect(gap(box(p), e.label)).toBeGreaterThanOrEqual(BADGE_GAP);
    expect(Math.hypot(at[0]!.x - at[2]!.x, at[0]!.y - at[2]!.y)).toBeGreaterThanOrEqual(BADGE + BADGE_GAP);
  });
});
