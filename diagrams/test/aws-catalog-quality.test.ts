import { describe, expect, it } from "vitest";
import { annotate } from "../src/aws/annotate";
import { BADGE, BADGE_GAP } from "../src/aws/badges";
import { groupHeaderRect } from "../src/aws/header";
import { type DiagramLayout, layoutDiagram, type Point, type Rect } from "../src/aws/layout";
import { AwsDiagramData } from "../src/aws/schema";
import { catalog } from "../src/catalog";

type Seg = [Point, Point];
const segs = (pts: Point[]): Seg[] => pts.slice(1).map((q, i) => [pts[i]!, q]);
const segRect = ([a, b]: Seg): Rect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
const gap = (a: Rect, b: Rect) => Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));
const routeGap = (r: Rect, pts: Point[]) => Math.min(...segs(pts).map((s) => gap(r, segRect(s))));
const crosses = (s: Seg, r: Rect) => gap(segRect(s), r) < 0;
const horizontal = ([a, b]: Seg) => Math.abs(a.y - b.y) < 0.5;

const entries = await Promise.all(catalog.map(async (e) => {
  const data = AwsDiagramData.parse(e.data);
  const layout: DiagramLayout = await layoutDiagram(data);
  const { badges, labels } = annotate(e.id, data, layout);
  return { id: e.id, data, layout, badges, labels };
}));
const rows = entries.map((x) => [x.id, x] as const);

const box = (c: Point): Rect => ({ x: c.x - BADGE / 2, y: c.y - BADGE / 2, w: BADGE, h: BADGE });
const inside = (a: Rect, b: Rect) => a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.w <= b.x + b.w + 0.5 && a.y + a.h <= b.y + b.h + 0.5;
const bbox = (pts: Point[]): Rect => {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
};
const headers = (x: (typeof entries)[number]) => x.data.groups.map((g) => ({ id: g.id, r: groupHeaderRect(x.layout.groups[g.id]!, g.kind, g.label) }));

// Rendered-quality rules every catalog diagram must satisfy with real ELK.
describe("catalog render quality", () => {
  it.each(rows)("%s: badges clear every node, group header, label and other badge, and sit outside self-loops", (_id, x) => {
    x.badges.forEach((c, i) => {
      const b = box(c);
      for (const [id, n] of Object.entries(x.layout.nodes)) expect(gap(b, n), `badge ${i + 1} on node ${id}`).toBeGreaterThanOrEqual(BADGE_GAP - 1e-6);
      for (const h of headers(x)) expect(gap(b, h.r), `badge ${i + 1} on ${h.id} header`).toBeGreaterThanOrEqual(BADGE_GAP - 1e-6);
      for (const [id, l] of Object.entries(x.labels)) expect(gap(b, l), `badge ${i + 1} on label of ${id}`).toBeGreaterThanOrEqual(BADGE_GAP - 1e-6);
      x.badges.forEach((o, j) => { if (j > i) expect(gap(b, box(o)), `badge ${i + 1} on badge ${j + 1}`).toBeGreaterThanOrEqual(BADGE_GAP - 1e-6); });
      const e = x.data.edges.find((ed) => ed.id === x.data.steps[i]!.edges[0])!;
      if (e.from === e.to) expect(gap(b, bbox(x.layout.edges[e.id]!.points)), `badge ${i + 1} inside its loop`).toBeGreaterThanOrEqual(BADGE_GAP - 1e-6);
    });
  });
  it.each(rows)("%s: labels sit inside the canvas, off nodes, group headers and each other", (_id, x) => {
    const ls = Object.entries(x.labels);
    for (const [id, l] of ls) {
      expect(inside(l, { x: 0, y: 0, w: x.layout.width, h: x.layout.height }), `label of ${id} outside the canvas`).toBe(true);
      for (const [nid, n] of Object.entries(x.layout.nodes)) expect(gap(l, n), `label of ${id} on node ${nid}`).toBeGreaterThanOrEqual(0);
      for (const h of headers(x)) expect(gap(l, h.r), `label of ${id} on ${h.id} header`).toBeGreaterThanOrEqual(0);
      for (const [oid, o] of ls) if (oid !== id) expect(gap(l, o), `label of ${id} on label of ${oid}`).toBeGreaterThanOrEqual(0);
    }
  });
  it.each(rows)("%s: every node sits inside its group, every group inside its parent, every route inside the canvas", (_id, x) => {
    for (const n of x.data.nodes) if (n.group) expect(inside(x.layout.nodes[n.id]!, x.layout.groups[n.group]!), `${n.id} outside ${n.group}`).toBe(true);
    for (const g of x.data.groups) if (g.parent) expect(inside(x.layout.groups[g.id]!, x.layout.groups[g.parent]!), `${g.id} outside ${g.parent}`).toBe(true);
    for (const [id, r] of Object.entries(x.layout.edges)) for (const p of r.points) {
      expect(p.x >= 0 && p.x <= x.layout.width && p.y >= 0 && p.y <= x.layout.height, `${id} leaves the canvas at ${p.x},${p.y}`).toBe(true);
    }
  });
  it.each(rows)("%s: a group-frame edge end is not level with a member icon", (_id, x) => {
    const parent = new Map(x.data.groups.map((g) => [g.id, g.parent]));
    const within = (g: string | undefined, gid: string): boolean => g !== undefined && (g === gid || within(parent.get(g), gid));
    for (const e of x.data.edges) {
      const pts = x.layout.edges[e.id]!.points;
      for (const [gid, p] of [[e.from, pts[0]!], [e.to, pts[pts.length - 1]!]] as const) {
        const frame = x.layout.groups[gid];
        if (!frame) continue;
        const sideways = Math.abs(p.x - frame.x) < 1 || Math.abs(p.x - frame.x - frame.w) < 1;
        for (const n of x.data.nodes.filter((nd) => within(nd.group, gid))) {
          const r = x.layout.nodes[n.id]!;
          const icon = { x: r.x + (r.w - 48) / 2, y: r.y, w: 48, h: 48 };
          const level = sideways ? p.y > icon.y && p.y < icon.y + icon.h : p.x > icon.x && p.x < icon.x + icon.w;
          expect(level, `${e.id} leaves ${gid} level with ${n.id}`).toBe(false);
        }
      }
    }
  });
  it.each(rows)("%s: lays out and annotates deterministically", async (id, x) => {
    const again = await layoutDiagram(x.data);
    expect(again).toEqual(x.layout);
    expect(annotate(id, x.data, again)).toEqual({ badges: x.badges, labels: x.labels });
  });
  it.each(rows)("%s: every edge label is nearer its own route than any other, and ≥6px from the others", (_id, x) => {
    for (const [id, r] of Object.entries(x.labels)) {
      const own = routeGap(r, x.layout.edges[id]!.points);
      for (const [other, route] of Object.entries(x.layout.edges)) {
        if (other === id) continue;
        const d = routeGap(r, route.points);
        expect(d, `label of ${id} vs route ${other}`).toBeGreaterThanOrEqual(6);
        expect(own, `label of ${id} nearer ${other}`).toBeLessThan(d);
      }
    }
  });
  it.each(rows)("%s: a self-loop crosses no other edge of its node", (_id, x) => {
    for (const e of x.data.edges.filter((e) => e.from === e.to)) {
      const others = x.data.edges.filter((o) => o.id !== e.id && (o.from === e.from || o.to === e.from));
      for (const s of segs(x.layout.edges[e.id]!.points)) for (const o of others) for (const t of segs(x.layout.edges[o.id]!.points)) {
        if (horizontal(s) === horizontal(t)) continue;
        expect(gap(segRect(s), segRect(t)) < 0, `${e.id} crosses ${o.id}`).toBe(false);
      }
    }
  });
  it.each(rows)("%s: no route runs through a node it does not connect", (_id, x) => {
    for (const e of x.data.edges) for (const s of segs(x.layout.edges[e.id]!.points)) for (const n of x.data.nodes) {
      if (n.id === e.from || n.id === e.to) continue;
      const r = x.layout.nodes[n.id]!;
      expect(gap(segRect(s), { x: r.x + 2, y: r.y + 2, w: r.w - 4, h: r.h - 4 }) < 0, `${e.id} through ${n.id}`).toBe(false);
    }
  });
  it.each(rows)("%s: no route crosses a group's header (corner icon and label)", (_id, x) => {
    for (const g of x.data.groups) {
      const band = groupHeaderRect(x.layout.groups[g.id]!, g.kind, g.label);
      for (const [id, route] of Object.entries(x.layout.edges)) for (const s of segs(route.points)) expect(crosses(s, band), `${id} through ${g.id} header`).toBe(false);
    }
  });
  it.each(rows)("%s: parallel routes run ≥12px apart and badges sit clear of neighbouring lines", (_id, x) => {
    const all = Object.entries(x.layout.edges).flatMap(([id, r]) => segs(r.points).map((s) => ({ id, s })));
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const [p, q] = [all[i]!, all[j]!];
      if (p.id === q.id || horizontal(p.s) !== horizontal(q.s)) continue;
      const h = horizontal(p.s);
      const [a, b] = [segRect(p.s), segRect(q.s)];
      const overlap = h ? Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) : Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (overlap < 20) continue;
      // A fan of more ports than fit 12px apart on one icon side compresses; its stubs are exempt.
      const touches = (sg: Seg) => Object.values(x.layout.nodes).filter((n) => sg.some((pt) => gap({ ...pt, w: 0, h: 0 }, n) <= 0.5));
      const fan = touches(p.s).some((n) => touches(q.s).includes(n));
      if (fan) continue;
      const d = h ? Math.abs(a.y - b.y) : Math.abs(a.x - b.x);
      expect(d, `${p.id} and ${q.id} run ${d}px apart for ${Math.round(overlap)}px`).toBeGreaterThanOrEqual(12);
    }
    x.badges.forEach((c, i) => {
      const own = x.data.steps[i]!.edges[0]!;
      const box = { x: c.x - BADGE / 2, y: c.y - BADGE / 2, w: BADGE, h: BADGE };
      for (const [id, r] of Object.entries(x.layout.edges)) if (id !== own) expect(routeGap(box, r.points), `badge ${i + 1} on ${id}`).toBeGreaterThanOrEqual(2);
    });
  });
});
