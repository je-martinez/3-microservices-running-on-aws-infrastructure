import { describe, expect, it } from "vitest";
import { BADGE, badgeCentres } from "../src/aws/badges";
import { placeLabels } from "../src/aws/labels";
import { type DiagramLayout, groupHeaderRect, layoutDiagram, type Point, type Rect } from "../src/aws/layout";
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
  const elkLabels = Object.values(layout.edges).flatMap((r) => (r.label ? [r.label] : []));
  const badges = badgeCentres(data.steps, layout.edges, Object.values(layout.groups), Object.values(layout.nodes), elkLabels);
  return { id: e.id, data, layout, badges, labels: placeLabels(data, layout, badges) };
}));
const rows = entries.map((x) => [x.id, x] as const);

// Rendered-quality rules every catalog diagram must satisfy with real ELK.
describe("catalog render quality", () => {
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
      const band = groupHeaderRect(x.layout.groups[g.id]!, g.label);
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
