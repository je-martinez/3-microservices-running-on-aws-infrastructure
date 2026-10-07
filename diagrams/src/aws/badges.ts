import type { DiagramLayout, Point, Rect } from "./layout";

export const BADGE = 22;
/** Minimum clearance between a badge and an edge label, another badge or a group border. */
export const BADGE_GAP = 4;
// WHY: keeps a badge off the arrowhead (8px) and the route's first pixels at the source.
const END_CLEAR = 12;
const STEP = 2;

type Edges = DiagramLayout["edges"];

const badgeRect = (p: Point, grow: number): Rect => ({ x: p.x - BADGE / 2 - grow, y: p.y - BADGE / 2 - grow, w: BADGE + 2 * grow, h: BADGE + 2 * grow });
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const borders = (g: Rect): Rect[] => [
  { x: g.x, y: g.y, w: g.w, h: 0 }, { x: g.x, y: g.y + g.h, w: g.w, h: 0 },
  { x: g.x, y: g.y, w: 0, h: g.h }, { x: g.x + g.w, y: g.y, w: 0, h: g.h },
];

/** Positions along a route, longest segment first, sliding outward from each segment's midpoint. */
function* candidates(points: Point[]): Generator<Point> {
  const segs = points.slice(1).map((b, i) => ({ a: points[i]!, b, len: Math.hypot(b.x - points[i]!.x, b.y - points[i]!.y) }));
  segs.sort((s, t) => t.len - s.len);
  const reach = BADGE / 2 + END_CLEAR;
  for (const { a, b, len } of segs) {
    if (len < 2 * reach) continue;
    const at = (d: number) => ({ x: a.x + ((b.x - a.x) * d) / len, y: a.y + ((b.y - a.y) * d) / len });
    for (let off = 0; len / 2 - off >= reach; off += STEP) {
      yield at(len / 2 + off);
      if (off) yield at(len / 2 - off);
    }
  }
}

function longestMidpoint(points: Point[]): Point {
  let best = { a: points[0]!, b: points[1] ?? points[0]!, len: -1 };
  for (let i = 1; i < points.length; i++) {
    const len = Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
    if (len > best.len) best = { a: points[i - 1]!, b: points[i]!, len };
  }
  return { x: (best.a.x + best.b.x) / 2, y: (best.a.y + best.b.y) / 2 };
}

/**
 * Badge centre per step, on the step's first edge: clear of every edge label and earlier badge by BADGE_GAP,
 * and off group borders when the route allows it. A repeated edge therefore stacks its badges 26px apart.
 */
export function badgeCentres(steps: { edges: string[] }[], edges: Edges, groups: Rect[]): Point[] {
  const labels = Object.values(edges).flatMap((e) => (e.label ? [e.label] : []));
  const lines = groups.flatMap(borders);
  const placed: Rect[] = [];
  return steps.map((s) => {
    const points = edges[s.edges[0]!]!.points;
    const hard = [...labels, ...placed];
    const clear = (p: Point, soft: Rect[]) => {
      const r = badgeRect(p, BADGE_GAP);
      return !hard.some((o) => overlaps(r, o)) && !soft.some((o) => overlaps(r, o));
    };
    let found: Point | undefined;
    for (const p of candidates(points)) if (clear(p, lines)) { found = p; break; }
    if (!found) for (const p of candidates(points)) if (clear(p, [])) { found = p; break; }
    const at = found ?? longestMidpoint(points);
    placed.push(badgeRect(at, 0));
    return at;
  });
}
