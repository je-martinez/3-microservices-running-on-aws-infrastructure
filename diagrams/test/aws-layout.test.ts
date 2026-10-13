import { describe, expect, it } from "vitest";
import { groupHeaderRect } from "../src/aws/header";
import { layoutDiagram, type Point, type Rect } from "../src/aws/layout";
import { AwsDiagramData, type GroupKind } from "../src/aws/schema";

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
    it(`${name} (${d.direction}): starts and ends every edge on the icon (task card for tasks), never on the label`, () => {
      const anchor = (id: string): Rect => {
        const r = l.nodes[id]!;
        const isTask = d.nodes.find((n) => n.id === id)!.icon === "task";
        return isTask ? r : { x: r.x + (r.w - 48) / 2, y: r.y, w: 48, h: 48 };
      };
      for (const e of d.edges) {
        const pts = l.edges[e.id]!.points;
        expect(pts.length).toBeGreaterThanOrEqual(2);
        expect(onBorder(pts[0]!, anchor(e.from)), `${e.id} start`).toBe(true);
        expect(onBorder(pts[pts.length - 1]!, anchor(e.to)), `${e.id} end`).toBe(true);
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
  it("nested sample: places each edge label beside its own route, not another edge's", async () => {
    const l = await layoutDiagram(nested);
    const dist = (pts: Point[], c: Point) => Math.min(...pts.slice(1).map((q, i) => {
      const p = pts[i]!;
      const x = Math.min(Math.max(c.x, Math.min(p.x, q.x)), Math.max(p.x, q.x));
      const y = Math.min(Math.max(c.y, Math.min(p.y, q.y)), Math.max(p.y, q.y));
      return Math.hypot(c.x - x, c.y - y);
    }));
    for (const e of nested.edges) {
      const label = l.edges[e.id]!.label;
      if (!label) continue;
      const c = { x: label.x + label.w / 2, y: label.y + label.h / 2 };
      const own = dist(l.edges[e.id]!.points, c);
      expect(own, `${e.id} label is ${own}px from its route`).toBeLessThanOrEqual(label.w / 2 + label.h);
      for (const o of nested.edges) if (o.id !== e.id) expect(own, `${e.id} label nearer ${o.id}`).toBeLessThanOrEqual(dist(l.edges[o.id]!.points, c) + 0.5);
    }
  });
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

describe("per-edge ports", async () => {
  const fanIn = AwsDiagramData.parse({
    title: "Fan-in",
    groups: [{ id: "vpc", kind: "vpc", label: "VPC" }],
    nodes: [
      { id: "orders", label: "Orders", icon: "ecs", group: "vpc" },
      { id: "tracking", label: "Tracking", icon: "ecs", group: "vpc" },
      { id: "users", label: "Users", icon: "ecs", group: "vpc" },
    ],
    edges: [{ id: "o-u", from: "orders", to: "users", label: "gRPC" }, { id: "t-u", from: "tracking", to: "users", label: "gRPC" }],
  });
  it("never lets two edges into the same node share their final segment", async () => {
    const l = await layoutDiagram(fanIn);
    const last = (id: string) => l.edges[id]!.points.slice(-2) as [Point, Point];
    const [[a1, a2], [b1, b2]] = [last("o-u"), last("t-u")];
    expect(a2).not.toEqual(b2);
    const collinear = (Math.abs(a1.y - a2.y) < 0.5 && Math.abs(b1.y - b2.y) < 0.5 && Math.abs(a1.y - b1.y) < 0.5)
      || (Math.abs(a1.x - a2.x) < 0.5 && Math.abs(b1.x - b2.x) < 0.5 && Math.abs(a1.x - b1.x) < 0.5);
    expect(collinear, "final segments run on the same line").toBe(false);
  });

  for (const direction of ["RIGHT", "DOWN"] as const) {
    it(`${direction}: routes a back edge straight across, not around the group`, async () => {
      const chain = AwsDiagramData.parse({
        title: "Back edge",
        direction,
        groups: [{ id: "g", kind: "generic", label: "Group" }],
        nodes: [
          { id: "a", label: "Queue", icon: "sqs", group: "g" },
          { id: "b", label: "Worker", icon: "lambda", group: "g" },
          { id: "c", label: "Users", icon: "ecs", group: "g" },
          { id: "x", label: "Store", icon: "rds", group: "g" },
          { id: "y", label: "Cache", icon: "elasticache", group: "g" },
        ],
        edges: [
          { id: "ab", from: "a", to: "b" }, { id: "bc", from: "b", to: "c" }, { id: "ca", from: "c", to: "a", async: true },
          { id: "bx", from: "b", to: "x" }, { id: "by", from: "b", to: "y" },
        ],
      });
      const l = await layoutDiagram(chain);
      const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
      const [a, c] = [centre(l.nodes.a!), centre(l.nodes.c!)];
      const pts = l.edges.ca!.points;
      const length = pts.slice(1).reduce((sum, p, i) => sum + Math.abs(p.x - pts[i]!.x) + Math.abs(p.y - pts[i]!.y), 0);
      // One layer spacing (70px) of detour at most; a loop around the group is several times that.
      expect(length).toBeLessThanOrEqual(Math.abs(a.x - c.x) + Math.abs(a.y - c.y) + 70);
      const g = l.groups.g!;
      for (const p of pts) expect(p.x >= g.x && p.x <= g.x + g.w && p.y >= g.y && p.y <= g.y + g.h).toBe(true);
    });
  }
  it("routes a back edge into a group holding nodes on both sides of another group from the near side", async () => {
    const d = AwsDiagramData.parse({
      title: "Auth",
      groups: [{ id: "compose", kind: "generic", label: "Docker Compose" }, { id: "floci", kind: "local-floci", label: "Floci (:4566)" }],
      nodes: [
        { id: "web", label: "Web app", sublabel: "browser", icon: "client" },
        { id: "gw", label: "API Gateway", sublabel: "JWT authorizer", icon: "api-gateway", group: "floci" },
        { id: "users", label: "Users service", icon: "server", group: "compose" },
        { id: "cognito", label: "Cognito", icon: "cognito", group: "floci" },
        { id: "trigger", label: "Pre-token trigger", icon: "lambda", group: "floci" },
      ],
      edges: [
        { id: "call", from: "web", to: "gw", label: "sign in" }, { id: "proxy", from: "gw", to: "users", label: "proxy" },
        { id: "auth", from: "users", to: "cognito", label: "password" }, { id: "claims", from: "cognito", to: "trigger" },
      ],
    });
    const l = await layoutDiagram(d);
    const pts = l.edges.auth!.points;
    const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    const [u, c] = [centre(l.nodes.users!), centre(l.nodes.cognito!)];
    const length = pts.slice(1).reduce((sum, p, i) => sum + Math.abs(p.x - pts[i]!.x) + Math.abs(p.y - pts[i]!.y), 0);
    expect(length).toBeLessThanOrEqual(Math.abs(u.x - c.x) + Math.abs(u.y - c.y) + 140);
  });
});

describe("group endpoints", () => {
  const onFrame = (p: Point, r: Rect) => onBorder(p, r);
  const icon = (r: Rect): Rect => ({ x: r.x + (r.w - 48) / 2, y: r.y, w: 48, h: 48 });
  const header = (r: Rect, kind: GroupKind, label: string) => groupHeaderRect(r, kind, label);
  const inBand = (p: Point, h: Rect) => p.x >= h.x - 1 && p.x <= h.x + h.w + 1 && p.y >= h.y - 1 && p.y <= h.y + h.h + 1;

  for (const direction of ["RIGHT", "DOWN"] as const) {
    const d = AwsDiagramData.parse({
      title: "Groups",
      direction,
      groups: [
        { id: "floci", kind: "local-floci", label: "Floci (:4566)" },
        { id: "vpc", kind: "vpc", label: "VPC 10.0.0.0/16", parent: "floci" },
        { id: "subnets", kind: "private-subnet", label: "Subnets a + b", parent: "vpc" },
        { id: "compose", kind: "generic", label: "Docker Compose: services" },
      ],
      nodes: [
        { id: "web", label: "Browser", icon: "client" },
        { id: "orders", label: "Orders", icon: "server", group: "compose" },
        { id: "users", label: "Users", icon: "server", group: "compose" },
        { id: "cache", label: "ElastiCache", icon: "elasticache", group: "floci" },
        { id: "db", label: "RDS", icon: "rds", group: "subnets" },
        { id: "topic", label: "Events topic", icon: "sns", group: "floci" },
      ],
      edges: [
        { id: "node-group", from: "web", to: "compose", label: "HTTP" },
        { id: "group-node", from: "compose", to: "cache", label: "cache" },
        { id: "group-nested", from: "compose", to: "subnets", label: "SQL" },
        { id: "group-async", from: "compose", to: "topic", async: true },
        { id: "inside", from: "orders", to: "users", label: "gRPC" },
      ],
    });
    it(`${direction}: ends a group edge on the group's frame (outside its header) and a node edge on the icon`, async () => {
      const l = await layoutDiagram(d);
      const groupIds = new Set(d.groups.map((g) => g.id));
      const anchor = (id: string) => (groupIds.has(id) ? l.groups[id]! : icon(l.nodes[id]!));
      for (const e of d.edges) {
        const pts = l.edges[e.id]!.points;
        for (const [id, p] of [[e.from, pts[0]!], [e.to, pts[pts.length - 1]!]] as const) {
          expect(onFrame(p, anchor(id)), `${e.id} end on ${id}`).toBe(true);
          if (groupIds.has(id)) expect(inBand(p, header(l.groups[id]!, d.groups.find((g) => g.id === id)!.kind, d.groups.find((g) => g.id === id)!.label)), `${e.id} in ${id} header`).toBe(false);
        }
      }
    });
    it(`${direction}: routes group edges clear of every node`, async () => {
      const l = await layoutDiagram(d);
      for (const e of d.edges) {
        const pts = l.edges[e.id]!.points;
        for (const n of d.nodes) {
          if (n.id === e.from || n.id === e.to) continue;
          for (let i = 1; i < pts.length; i++) expect(segHitsRect(pts[i - 1]!, pts[i]!, l.nodes[n.id]!), `${e.id} crosses ${n.id}`).toBe(false);
        }
      }
    });
  }
  it("DOWN: makes every group frame at least as wide as its header", async () => {
    const d = AwsDiagramData.parse({
      title: "Down", direction: "DOWN",
      groups: [{ id: "compose", kind: "generic", label: "Docker Compose: services" }, { id: "vpc", kind: "vpc", label: "VPC 10.0.0.0/16" }],
      nodes: [{ id: "a", label: "A", icon: "server", group: "compose" }, { id: "b", label: "B", icon: "rds", group: "vpc" }],
      edges: [{ id: "ab", from: "a", to: "b" }],
    });
    const l = await layoutDiagram(d);
    for (const g of d.groups) expect(l.groups[g.id]!.w, g.id).toBeGreaterThanOrEqual(groupHeaderRect(l.groups[g.id]!, g.kind, g.label).w);
  });
});
