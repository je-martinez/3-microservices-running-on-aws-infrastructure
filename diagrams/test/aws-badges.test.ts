import { describe, expect, it } from "vitest";
import { BADGE, BADGE_GAP, BADGE_PITCH, badgeCentres } from "../src/aws/badges";
import { distanceToRoute, LABEL_OFFSET_FAR, placeLabels } from "../src/aws/labels";
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
  it("slides a badge off an obstacle with at least the gap", () => {
    const label = { x: 80, y: 4, w: 40, h: 16 };
    const [at] = badgeCentres([{ edges: ["a"] }], { a: line(0, 300) }, [], [label]);
    expect(at!.y).toBe(0);
    expect(gap(box(at!), label)).toBeGreaterThanOrEqual(BADGE_GAP);
  });
  it("centres the run of badges of steps sharing an edge, 26px apart", () => {
    const [a, b] = badgeCentres([{ edges: ["a"] }, { edges: ["a"] }], { a: line(0, 200) }, []);
    expect(a!.x).toBeCloseTo(87);
    expect(b!.x).toBeCloseTo(87 + BADGE_PITCH);
    expect([a!.y, b!.y]).toEqual([0, 0]);
  });
  it("orders a shared edge's badges by step from the source end, clear of obstacles", () => {
    const label = { x: 140, y: -8, w: 40, h: 16 };
    const edges = { back: line(400, 0), other: line(0, 100, 200) };
    const steps = [{ edges: ["back"] }, { edges: ["other"] }, { edges: ["back"] }, { edges: ["back"] }, { edges: ["back"] }];
    const at = badgeCentres(steps, edges, [], [label]);
    const mine = [0, 2, 3, 4].map((i) => at[i]!);
    for (let i = 1; i < mine.length; i++) expect(mine[i - 1]!.x - mine[i]!.x).toBeCloseTo(BADGE_PITCH);
    for (const p of mine) expect(gap(box(p), label)).toBeGreaterThanOrEqual(BADGE_GAP);
  });
  it("keeps a badge off a group border the edge crosses", () => {
    const group = { x: 100, y: -50, w: 200, h: 100 };
    const [at] = badgeCentres([{ edges: ["a"] }], { a: line(0, 200) }, [group]);
    expect(Math.abs(at!.x - group.x)).toBeGreaterThanOrEqual(BADGE / 2 + BADGE_GAP);
  });
  it("in a real ELK layout, labels placed after the badges clear them and stay beside their own line", async () => {
    const d = AwsDiagramData.parse({
      title: "T",
      groups: [{ id: "cloud", kind: "aws-cloud", label: "AWS Cloud" }],
      nodes: [
        { id: "web", label: "Browser", icon: "client" },
        { id: "gw", label: "API Gateway", icon: "api-gateway", group: "cloud" },
        { id: "fn", label: "Handler", icon: "lambda", group: "cloud" },
      ],
      edges: [
        { id: "a", from: "web", to: "gw", label: "spans, errors" }, { id: "b", from: "gw", to: "fn", label: "invoke" },
        { id: "loop", from: "fn", to: "fn", label: "dispatch" },
      ],
      steps: [{ edges: ["a"], caption: "x" }, { edges: ["b"], caption: "y" }, { edges: ["a"], caption: "z" }, { edges: ["loop"], caption: "w" }, { edges: ["a"], caption: "v" }],
    });
    const l = await layoutDiagram(d);
    const at = badgeCentres(d.steps, l.edges, Object.values(l.groups), Object.values(l.nodes));
    // A badge clears every node but the endpoints of its own edge (a tight self-loop hugs its node).
    at.forEach((p, i) => {
      const e = d.edges.find((x) => x.id === d.steps[i]!.edges[0])!;
      for (const n of d.nodes) if (n.id !== e.from && n.id !== e.to) expect(gap(box(p), l.nodes[n.id]!), `badge ${i + 1} on ${n.id}`).toBeGreaterThanOrEqual(BADGE_GAP);
    });
    const labels = placeLabels(d, l, at);
    for (const [id, r] of Object.entries(labels)) {
      for (const p of at) expect(gap(box(p), r), `${id} label vs badge`).toBeGreaterThanOrEqual(BADGE_GAP);
      expect(distanceToRoute(r, l.edges[id]!.points), `${id} label far from its line`).toBeLessThanOrEqual(LABEL_OFFSET_FAR + 1);
      for (const n of Object.values(l.nodes)) expect(gap(r, n), `${id} label on a node`).toBeGreaterThanOrEqual(0);
    }
    const loopPts = l.edges.loop!.points;
    const xs = loopPts.map((p) => p.x), ys = loopPts.map((p) => p.y);
    const loopBox = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    expect(gap(labels.loop!, loopBox), "self-loop label inside its loop").toBeGreaterThanOrEqual(0);
    const onA = [0, 2, 4].map((i) => at[i]!);
    const pts = l.edges.a!.points;
    const dir = { x: Math.sign(pts[pts.length - 1]!.x - pts[0]!.x), y: Math.sign(pts[pts.length - 1]!.y - pts[0]!.y) };
    for (let i = 1; i < onA.length; i++) expect((onA[i]!.x - onA[i - 1]!.x) * dir.x + (onA[i]!.y - onA[i - 1]!.y) * dir.y).toBeGreaterThan(0);
  });
});
