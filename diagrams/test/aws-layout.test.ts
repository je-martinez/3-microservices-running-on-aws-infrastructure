import { describe, expect, it } from "vitest";
import { layoutDiagram, type Rect } from "../src/aws/layout";
import { AwsDiagramData } from "../src/aws/schema";

const inside = (a: Rect, b: Rect) => a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.w <= b.x + b.w + 0.5 && a.y + a.h <= b.y + b.h + 0.5;
const segHitsRect = (p: { x: number; y: number }, q: { x: number; y: number }, r: Rect) => {
  const pad = 2;
  const [x1, x2] = [Math.min(p.x, q.x), Math.max(p.x, q.x)];
  const [y1, y2] = [Math.min(p.y, q.y), Math.max(p.y, q.y)];
  return x2 > r.x + pad && x1 < r.x + r.w - pad && y2 > r.y + pad && y1 < r.y + r.h - pad;
};

const data = AwsDiagramData.parse({
  title: "T",
  direction: "RIGHT",
  groups: [
    { id: "cloud", kind: "aws-cloud", label: "AWS Cloud" },
    { id: "vpc", kind: "vpc", label: "VPC", parent: "cloud" },
    { id: "priv", kind: "private-subnet", label: "Private subnet", parent: "vpc" },
  ],
  nodes: [
    { id: "web", label: "Browser", icon: "client" },
    { id: "gw", label: "API Gateway", icon: "api-gateway", group: "cloud" },
    { id: "users", label: "Users service", icon: "ecs", group: "priv" },
    { id: "orders", label: "Orders service", icon: "ecs", group: "priv" },
    { id: "db", label: "RDS Postgres", icon: "rds", group: "priv" },
    { id: "q", label: "Events queue", icon: "sqs", group: "cloud" },
  ],
  edges: [
    { id: "a", from: "web", to: "gw", label: "HTTPS" },
    { id: "b", from: "gw", to: "users" },
    { id: "c", from: "gw", to: "orders" },
    { id: "d", from: "users", to: "db" },
    { id: "e", from: "orders", to: "q", async: true },
  ],
});

describe("layoutDiagram (real ELK)", async () => {
  const l = await layoutDiagram(data);
  it("gives every node and group a box inside the canvas", () => {
    for (const r of [...Object.values(l.nodes), ...Object.values(l.groups)]) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(l.width);
      expect(r.y + r.h).toBeLessThanOrEqual(l.height);
    }
  });
  it("keeps every node inside its group and every group inside its parent", () => {
    for (const n of data.nodes) if (n.group) expect(inside(l.nodes[n.id]!, l.groups[n.group]!)).toBe(true);
    for (const g of data.groups) if (g.parent) expect(inside(l.groups[g.id]!, l.groups[g.parent]!)).toBe(true);
  });
  it("routes edges orthogonally", () => {
    for (const e of Object.values(l.edges)) {
      for (let i = 1; i < e.points.length; i++) {
        const [p, q] = [e.points[i - 1]!, e.points[i]!];
        expect(Math.abs(p.x - q.x) < 0.5 || Math.abs(p.y - q.y) < 0.5).toBe(true);
      }
    }
  });
  it("never routes an edge through a node it does not connect", () => {
    for (const e of data.edges) {
      const pts = l.edges[e.id]!.points;
      for (const n of data.nodes) {
        if (n.id === e.from || n.id === e.to) continue;
        for (let i = 1; i < pts.length; i++) expect(segHitsRect(pts[i - 1]!, pts[i]!, l.nodes[n.id]!), `${e.id} crosses ${n.id}`).toBe(false);
      }
    }
  });
  it("is deterministic", async () => {
    expect(await layoutDiagram(data)).toEqual(l);
  });
});

// Absolute-coordinate conversion: an edge's section is relative to its container (the lowest common
// ancestor of its endpoints), so endpoints at different depths expose a wrong offset sum.
const onBorder = (p: { x: number; y: number }, r: Rect) => {
  const tol = 1;
  const withinX = p.x >= r.x - tol && p.x <= r.x + r.w + tol;
  const withinY = p.y >= r.y - tol && p.y <= r.y + r.h + tol;
  const onV = Math.abs(p.x - r.x) <= tol || Math.abs(p.x - (r.x + r.w)) <= tol;
  const onH = Math.abs(p.y - r.y) <= tol || Math.abs(p.y - (r.y + r.h)) <= tol;
  return withinX && withinY && (onV || onH);
};

const nested = AwsDiagramData.parse({
  title: "Nested",
  direction: "DOWN",
  groups: [
    { id: "cloud", kind: "aws-cloud", label: "AWS Cloud" },
    { id: "region", kind: "region", label: "us-east-1", parent: "cloud" },
    { id: "vpc", kind: "vpc", label: "VPC", parent: "region" },
    { id: "pub", kind: "public-subnet", label: "Public subnet", parent: "vpc" },
    { id: "priv", kind: "private-subnet", label: "Private subnet", parent: "vpc" },
  ],
  nodes: [
    { id: "user", label: "Customer", icon: "users" },
    { id: "cdn", label: "Edge function", icon: "lambda", group: "cloud" },
    { id: "alb", label: "Load balancer", icon: "elb", group: "pub" },
    { id: "svc", label: "Orders service", sublabel: "ECS Fargate", icon: "ecs", group: "priv" },
    { id: "nat", label: "NAT gateway", icon: "task", group: "vpc" },
  ],
  edges: [
    { id: "root-to-depth4", from: "user", to: "alb", label: "HTTPS" },
    { id: "depth1-to-depth4", from: "cdn", to: "svc" },
    { id: "sibling-subnets", from: "alb", to: "svc", label: "HTTP" },
    { id: "depth3-to-depth4", from: "nat", to: "svc", async: true },
  ],
});

describe("layoutDiagram absolute coordinates", async () => {
  for (const [name, d] of [["flat sample", data], ["nested sample", nested]] as const) {
    const l = await layoutDiagram(d);
    it(`${name}: starts and ends every edge on its endpoints' borders`, () => {
      for (const e of d.edges) {
        const pts = l.edges[e.id]!.points;
        expect(pts.length).toBeGreaterThanOrEqual(2);
        expect(onBorder(pts[0]!, l.nodes[e.from]!), `${e.id} start`).toBe(true);
        expect(onBorder(pts[pts.length - 1]!, l.nodes[e.to]!), `${e.id} end`).toBe(true);
      }
    });
    it(`${name}: places the diagram below the title band`, () => {
      for (const r of [...Object.values(l.nodes), ...Object.values(l.groups)]) expect(r.y).toBeGreaterThanOrEqual(64);
    });
    it(`${name}: keeps edge labels inside the canvas and off unrelated nodes`, () => {
      for (const e of d.edges) {
        const label = l.edges[e.id]!.label;
        if (!e.label) { expect(label).toBeUndefined(); continue; }
        expect(label).toBeDefined();
        expect(label!.x).toBeGreaterThanOrEqual(0);
        expect(label!.x + label!.w).toBeLessThanOrEqual(l.width);
        expect(label!.y + label!.h).toBeLessThanOrEqual(l.height);
        for (const n of d.nodes) {
          const r = l.nodes[n.id]!;
          const overlap = label!.x < r.x + r.w && label!.x + label!.w > r.x && label!.y < r.y + r.h && label!.y + label!.h > r.y;
          expect(overlap, `${e.id} label over ${n.id}`).toBe(false);
        }
      }
    });
  }
  it("nested sample: keeps the deep groups nested and edges clear of other nodes", async () => {
    const l = await layoutDiagram(nested);
    for (const n of nested.nodes) if (n.group) expect(inside(l.nodes[n.id]!, l.groups[n.group]!)).toBe(true);
    for (const g of nested.groups) if (g.parent) expect(inside(l.groups[g.id]!, l.groups[g.parent]!)).toBe(true);
    for (const e of nested.edges) {
      const pts = l.edges[e.id]!.points;
      for (const n of nested.nodes) {
        if (n.id === e.from || n.id === e.to) continue;
        for (let i = 1; i < pts.length; i++) expect(segHitsRect(pts[i - 1]!, pts[i]!, l.nodes[n.id]!), `${e.id} crosses ${n.id}`).toBe(false);
      }
    }
  });
});

describe("node sizing", async () => {
  const l = await layoutDiagram(nested);
  it("sizes task nodes to the task box and icon nodes to icon plus label", () => {
    expect(l.nodes.nat).toMatchObject({ w: 150, h: 54 });
    expect(l.nodes.svc!.w).toBeGreaterThanOrEqual(48 + 24);
    expect(l.nodes.svc!.h).toBe(48 + 6 + l.nodes.svc!.labelLines.length * 16 + 16);
    expect(l.nodes.user!.h).toBe(48 + 6 + l.nodes.user!.labelLines.length * 16);
  });
});
