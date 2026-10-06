import { describe, expect, it } from "vitest";
import { activeIndex, TAG_H, edgePath, edgePoints, fitLabel, isSameColumn, layoutArchitecture, layoutDependency, layoutFlow } from "../src/primitives/layout";
import { ARCH_STEP, durationFor, HOLD, INTRO, STEP, unitProgress } from "../src/timing";

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

describe("layoutFlow", () => {
  const flow = {
    title: "F",
    actors: ["a", "b", "c"].map((id) => ({ id, label: id.toUpperCase(), kind: "compute" as const })),
    steps: Array.from({ length: 10 }, (_, i) => ({ from: "a", to: i % 2 ? "b" : "c", label: `s${i}`, caption: "c" })),
  };
  const l = layoutFlow(flow, 1200, 675);
  it("orders lanes left to right as declared", () => {
    expect(l.lanes.a!.x).toBeLessThan(l.lanes.b!.x);
    expect(l.lanes.b!.x).toBeLessThan(l.lanes.c!.x);
  });
  it("fits 10 rows above the caption bar", () => {
    expect(l.rowY(9)).toBeLessThan(675 - 18 - 48 - 8);
    expect(l.rowY(1)).toBeGreaterThan(l.rowY(0));
  });
});

describe("layoutDependency", () => {
  const dep = {
    title: "M",
    phases: [{ id: "p1", label: "P1" }, { id: "p2", label: "P2" }],
    tasks: [
      { id: "JE-1", label: "A", phase: "p1" },
      { id: "JE-2", label: "B", phase: "p2" },
      { id: "JE-3", label: "C", phase: "p2" },
    ],
    deps: [{ from: "JE-1", to: "JE-2" }],
  };
  const l = layoutDependency(dep, 1200, 675);
  it("puts each task inside its phase column", () => {
    for (const t of dep.tasks) {
      const r = l.tasks[t.id]!, p = l.phases[t.phase]!;
      expect(r.x).toBeGreaterThanOrEqual(p.x);
      expect(r.x + r.w).toBeLessThanOrEqual(p.x + p.w);
    }
  });
});

describe("dense zones", () => {
  const zoneIds = ["z1", "z2", "z3", "z4", "z5"];
  const counts = [3, 9, 2, 2, 2];
  const dense = {
    title: "D",
    zones: zoneIds.map((id) => ({ id, label: id })),
    nodes: zoneIds.flatMap((z, i) => Array.from({ length: counts[i]! }, (_, j) => ({ id: `${z}-n${j}`, label: "x", kind: "compute" as const, zone: z }))),
    edges: [],
  };
  const l = layoutArchitecture(dense, 1200, 675);
  it("has 18 nodes", () => expect(dense.nodes).toHaveLength(18));
  it("keeps every node >=44px tall, inside its zone and the canvas", () => {
    for (const n of dense.nodes) {
      const r = l.nodes[n.id]!, z = l.zones[n.zone]!;
      expect(r.h).toBeGreaterThanOrEqual(44);
      expect(r.x).toBeGreaterThanOrEqual(z.x);
      expect(r.y).toBeGreaterThanOrEqual(z.y);
      expect(r.x + r.w).toBeLessThanOrEqual(z.x + z.w);
      expect(r.y + r.h).toBeLessThanOrEqual(z.y + z.h);
      expect(r.x + r.w).toBeLessThanOrEqual(1200);
      expect(r.y + r.h).toBeLessThanOrEqual(675);
    }
  });
  it("does not overlap nodes in the two-column zone", () => {
    const rs = dense.nodes.filter((n) => n.zone === "z2").map((n) => l.nodes[n.id]!);
    for (const a of rs) for (const b of rs) {
      if (a === b) continue;
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      expect(apart).toBe(true);
    }
  });
});

describe("fitLabel", () => {
  it("fits a 22-char label at 5 zones without clipping", () => {
    const f = fitLabel("A".repeat(22), 183, 56, true);
    expect(f.size).toBeGreaterThanOrEqual(13);
    expect(f.lines).toBe(2);
    expect(f.clipped).toBe(false);
  });
  it("keeps a short label at full size on one line", () => {
    expect(fitLabel("Orders", 300, 56, true)).toMatchObject({ size: 18, lines: 1 });
  });
});

describe("edgePath", () => {
  const a = { x: 10, y: 100, w: 150, h: 50 };
  const b = { x: 10, y: 164, w: 150, h: 50 };
  it("detects stacked same-column boxes", () => {
    expect(isSameColumn(a, b)).toBe(true);
    expect(isSameColumn(a, { ...b, x: 300 })).toBe(false);
  });
  it("brackets a same-column edge through the right padding", () => {
    const p = edgePath(a, b, true);
    expect(p.d).toBe("M 160 125 H 172 V 189 H 160");
    expect(p.len).toBe(12 + 64 + 12);
    expect(p.label.anchor).toBe("end");
  });
  it("draws a straight line otherwise", () => {
    const p = edgePath({ x: 0, y: 0, w: 100, h: 40 }, { x: 300, y: 0, w: 100, h: 40 }, false);
    expect(p.d).toBe("M 100 20 L 300 20");
    expect(p.len).toBe(200);
    expect(p.label).toEqual({ x: 200, y: 12, anchor: "middle" });
  });
});

describe("activeIndex", () => {
  it("is undefined during the intro, indexes edges, and is undefined on the last frame", () => {
    expect(activeIndex(0, 3)).toBeUndefined();
    expect(activeIndex(INTRO, 3)).toBe(0);
    expect(activeIndex(INTRO + STEP, 3)).toBe(1);
    expect(activeIndex(durationFor(3) - 1, 3)).toBeUndefined();
  });

  it("steps by ARCH_STEP when asked, and is undefined on the last frame", () => {
    expect(ARCH_STEP).toBe(12);
    expect(durationFor(5, ARCH_STEP)).toBe(INTRO + 5 * ARCH_STEP + HOLD);
    expect(durationFor(5)).toBe(INTRO + 5 * STEP + HOLD);
    expect(activeIndex(INTRO + ARCH_STEP, 5, ARCH_STEP)).toBe(1);
    expect(activeIndex(INTRO + 5 * ARCH_STEP - 1, 5, ARCH_STEP)).toBe(4);
    expect(activeIndex(durationFor(5, ARCH_STEP) - 1, 5, ARCH_STEP)).toBeUndefined();
  });
});

describe("unitProgress", () => {
  it("defaults to STEP and reaches 1 before the next edge starts at ARCH_STEP", () => {
    expect(unitProgress(INTRO + STEP, 1)).toBe(0);
    expect(unitProgress(INTRO, 0, ARCH_STEP)).toBe(0);
    const next = INTRO + ARCH_STEP;
    expect(unitProgress(next - 1, 0, ARCH_STEP)).toBe(1);
    expect(unitProgress(next, 1, ARCH_STEP)).toBe(0);
  });
});

describe("layoutDependency at scale", () => {
  const phases = ["p1", "p2", "p3", "p4"];
  const counts = [12, 4, 4, 4];
  const dep = {
    title: "M",
    phases: phases.map((id) => ({ id, label: id })),
    tasks: phases.flatMap((p, i) => Array.from({ length: counts[i]! }, (_, j) => ({ id: `JE-${100 + i * 20 + j}`, label: "L".repeat(30), phase: p }))),
    deps: [],
  };
  const l = layoutDependency(dep, 1200, 675);
  it("has 24 tasks", () => expect(dep.tasks).toHaveLength(24));
  it("keeps every task >=44px tall, inside its phase and the canvas", () => {
    for (const t of dep.tasks) {
      const r = l.tasks[t.id]!, p = l.phases[t.phase]!;
      expect(r.h).toBeGreaterThanOrEqual(44);
      expect(r.x).toBeGreaterThanOrEqual(p.x);
      expect(r.y).toBeGreaterThanOrEqual(p.y);
      expect(r.x + r.w).toBeLessThanOrEqual(p.x + p.w);
      expect(r.y + r.h).toBeLessThanOrEqual(p.y + p.h);
      expect(r.x + r.w).toBeLessThanOrEqual(1200);
      expect(r.y + r.h).toBeLessThanOrEqual(675);
    }
  });
  it("fits the id tag plus a 30-char label in both the single- and two-column phases", () => {
    for (const id of ["JE-120", "JE-100"]) {
      const r = l.tasks[id]!;
      expect(fitLabel("L".repeat(30), r.w, r.h, false, TAG_H).clipped).toBe(false);
    }
  });
});
