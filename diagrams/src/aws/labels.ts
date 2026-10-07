import { AWS } from "../theme/aws-style";
import { BADGE_GAP, badgeRect, gap } from "./badges";
import type { DiagramLayout, Point, Rect } from "./layout";
import { textWidth } from "./measure";
import type { AwsDiagramData } from "./schema";

/** Distance between an edge label and the line it labels; the far offset clears a badge sitting on the line. */
export const LABEL_OFFSET = 3;
export const LABEL_OFFSET_FAR = 16;
const NEAR = 6;
const END_CLEAR = 12;
const STEP = 2;
const GROUP_ICON = 32;

type Seg = { a: Point; b: Point };

const segments = (pts: Point[]): Seg[] => pts.slice(1).map((b, i) => ({ a: pts[i]!, b }));
const segRect = ({ a, b }: Seg, grow: number): Rect => ({
  x: Math.min(a.x, b.x) - grow, y: Math.min(a.y, b.y) - grow, w: Math.abs(a.x - b.x) + 2 * grow, h: Math.abs(a.y - b.y) + 2 * grow,
});
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const bbox = (pts: Point[]): Rect => {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
};

/** Shortest distance from a label box to a route. */
export function distanceToRoute(r: Rect, pts: Point[]): number {
  return Math.min(...segments(pts).map((s) => Math.max(0, gap(r, segRect(s, 0)))));
}

/** Label boxes `o` px beside the route: longest segment first, sliding out from its midpoint, both sides of the line. */
function* candidates(pts: Point[], w: number, h: number, o: number): Generator<Rect> {
  const segs = segments(pts).map((s) => ({ ...s, len: Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) })).sort((p, q) => q.len - p.len);
  for (const { a, b, len } of segs) {
    const horizontal = Math.abs(a.y - b.y) < 0.5;
    const half = (horizontal ? w : h) / 2;
    // WHY: a segment shorter than its label (a self-loop's side) still offers its midpoint, label overhanging.
    const mid = len / 2;
    const lo = Math.min(mid, END_CLEAR + half);
    for (let off = 0; mid - off >= lo; off += STEP) {
      for (const d of off ? [mid + off, mid - off] : [mid]) {
        const c = { x: a.x + ((b.x - a.x) * d) / len, y: a.y + ((b.y - a.y) * d) / len };
        if (horizontal) {
          yield { x: c.x - w / 2, y: c.y + o, w, h };
          yield { x: c.x - w / 2, y: c.y - o - h, w, h };
        } else {
          yield { x: c.x + o, y: c.y - h / 2, w, h };
          yield { x: c.x - o - w, y: c.y - h / 2, w, h };
        }
      }
    }
  }
}

/** Clearance a label keeps from every route but its own. */
export const LABEL_ROUTE_CLEAR = 6;
const OFFSETS = [LABEL_OFFSET, LABEL_OFFSET_FAR, 26];

/**
 * Edge label boxes placed after the badges: beside their own line and nearer it than any other route, at
 * least LABEL_ROUTE_CLEAR from the others, clear of nodes, group headers, badges and other labels; a self-loop
 * keeps its label outside the loop. ELK's spot is kept when it qualifies; when nothing qualifies, the
 * candidate with the most clearance from other routes wins.
 */
export function placeLabels(data: AwsDiagramData, layout: DiagramLayout, badges: Point[]): Record<string, Rect> {
  const nodes = Object.values(layout.nodes);
  const headers = data.groups.map((g) => {
    const r = layout.groups[g.id]!;
    return { x: r.x, y: r.y, w: GROUP_ICON + 8 + textWidth(g.label, 14), h: GROUP_ICON };
  });
  const badgeBoxes = badges.map((p) => badgeRect(p, BADGE_GAP));
  const bounds = { x: 0, y: AWS.titleH, w: layout.width, h: layout.height - AWS.titleH };
  const placed: Rect[] = [];
  const out: Record<string, Rect> = {};
  for (const e of data.edges) {
    const route = layout.edges[e.id]!;
    if (!e.label || !route.label) continue;
    const { w, h } = route.label;
    const loop = e.from === e.to ? bbox(route.points) : undefined;
    const others = Object.entries(layout.edges).filter(([id]) => id !== e.id).map(([, r]) => r.points);
    const fits = (r: Rect) =>
      r.x >= bounds.x && r.y >= bounds.y && r.x + r.w <= bounds.x + bounds.w && r.y + r.h <= bounds.y + bounds.h
      && !(loop && overlaps(r, loop))
      && ![...nodes, ...headers, ...badgeBoxes].some((o) => overlaps(r, o))
      && !placed.some((o) => gap(r, o) < 2);
    // Margin by which a box beats the ownership rule; ≥ 0 qualifies.
    const margin = (r: Rect) => {
      const own = distanceToRoute(r, route.points);
      const other = Math.min(Infinity, ...others.map((pts) => distanceToRoute(r, pts)));
      return Math.min(other - LABEL_ROUTE_CLEAR, other - own - 1);
    };
    let chosen: Rect | undefined;
    let best: { r: Rect; m: number } | undefined;
    const consider = (r: Rect) => {
      if (!fits(r)) return false;
      const m = margin(r);
      if (m >= 0) { chosen = r; return true; }
      if (!best || m > best.m) best = { r, m };
      return false;
    };
    if (distanceToRoute(route.label, route.points) <= NEAR) consider(route.label);
    for (const o of OFFSETS) {
      if (chosen) break;
      for (const r of candidates(route.points, w, h, o)) if (consider(r)) break;
    }
    out[e.id] = chosen ?? best?.r ?? route.label;
    placed.push(out[e.id]!);
  }
  return out;
}
