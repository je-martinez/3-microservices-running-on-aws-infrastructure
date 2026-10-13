import type { DiagramLayout, Point, Rect } from "./layout";

export const BADGE = 22;
/** Minimum clearance between a badge and an edge label, another badge or a group border. */
export const BADGE_GAP = 4;
/** Centre-to-centre distance of consecutive badges on one edge. */
export const BADGE_PITCH = BADGE + BADGE_GAP;
// WHY: keeps a badge off the arrowhead (8px) and the route's first pixels at the source.
const END_CLEAR = 12;
const STEP = 2;

type Edges = DiagramLayout["edges"];

export const badgeRect = (p: Point, grow: number): Rect => ({ x: p.x - BADGE / 2 - grow, y: p.y - BADGE / 2 - grow, w: BADGE + 2 * grow, h: BADGE + 2 * grow });
export const gap = (a: Rect, b: Rect) => Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));
const borders = (g: Rect): Rect[] => [
  { x: g.x, y: g.y, w: g.w, h: 0 }, { x: g.x, y: g.y + g.h, w: g.w, h: 0 },
  { x: g.x, y: g.y, w: 0, h: g.h }, { x: g.x + g.w, y: g.y, w: 0, h: g.h },
];

/** Point at arc length `s` along a polyline. */
function along(points: Point[], s: number): Point {
  let left = s;
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1]!, points[i]!];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= len || i === points.length - 1) {
      const t = len ? Math.min(1, left / len) : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    left -= len;
  }
  return points[0]!;
}

/**
 * Runs of `k` badges, as arc-length starts, in preference order: whole runs on one segment (longest
 * segment first, sliding out from its midpoint), then runs across bends sliding out from the route's midpoint.
 */
function* runStarts(points: Point[], k: number): Generator<number> {
  const span = (k - 1) * BADGE_PITCH;
  const reach = BADGE / 2 + END_CLEAR;
  const segs: { from: number; len: number }[] = [];
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const len = Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
    segs.push({ from: acc, len });
    acc += len;
  }
  const slide = function* (lo: number, hi: number): Generator<number> {
    if (hi < lo) return;
    const mid = (lo + hi) / 2;
    for (let off = 0; mid - off >= lo; off += STEP) {
      yield mid + off;
      if (off) yield mid - off;
    }
  };
  for (const s of [...segs].sort((p, q) => q.len - p.len)) yield* slide(s.from + reach, s.from + s.len - reach - span);
  yield* slide(reach, acc - reach - span);
  yield* slide(0, Math.max(0, acc - span));
}

/** Runs of `k` badges in a row beside a self-loop's bounding box: above it first, then left and right, further out each ring. */
function* loopRuns(loop: Rect, k: number): Generator<Point[]> {
  const span = (k - 1) * BADGE_PITCH;
  const row = (x0: number, y: number) => Array.from({ length: k }, (_, j) => ({ x: x0 + j * BADGE_PITCH, y }));
  const cx = loop.x + loop.w / 2, cy = loop.y + loop.h / 2;
  for (let ring = 0; ring <= LOOP_REACH; ring += STEP) {
    const above = loop.y - BADGE_GAP - BADGE / 2 - ring;
    for (let off = 0; off <= LOOP_REACH; off += STEP) {
      yield row(cx - span / 2 + off, above);
      if (off) yield row(cx - span / 2 - off, above);
    }
    yield row(loop.x - BADGE_GAP - BADGE / 2 - span - ring, cy);
    yield row(loop.x + loop.w + BADGE_GAP + BADGE / 2 + ring, cy);
  }
}

const LOOP_REACH = 80;

// CONTRACT: hard rules (badges clear `avoid`, earlier badges and their own self-loop by BADGE_GAP) are never
// broken: when no spot meets them, even badge by badge, this throws. Soft rules drop in this order when the
// route offers no spot: group borders, `prefer` (ELK's label boxes), other routes.
/** Badge centre per step on its first edge, shared edges in step order from the source; self-loop badges sit beside the loop. */
export function badgeCentres(
  steps: { edges: string[] }[], edges: Edges, groups: Rect[], avoid: Rect[] = [], prefer: Rect[] = [], loops: ReadonlySet<string> = new Set(),
): Point[] {
  const lines = groups.flatMap(borders);
  const byEdge = new Map<string, number[]>();
  steps.forEach((s, i) => byEdge.set(s.edges[0]!, [...(byEdge.get(s.edges[0]!) ?? []), i]));
  const placed: Rect[] = [];
  const out: Point[] = new Array(steps.length);
  for (const [edge, stepIdx] of byEdge) {
    const points = edges[edge]!.points;
    const loop = loops.has(edge) ? bbox(points) : undefined;
    const hard = [...avoid, ...(loop ? [loop] : [])];
    const others = Object.entries(edges).filter(([id]) => id !== edge).flatMap(([, r]) => r.points.slice(1).map((b, i) => {
      const a = r.points[i]!;
      return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
    }));
    const clear = (ps: Point[], soft: Rect[]) => {
      const rects = ps.map((p) => badgeRect(p, 0));
      return rects.every((r) => [...hard, ...placed, ...soft].every((o) => gap(r, o) >= BADGE_GAP));
    };
    const runs = (): Iterable<Point[]> => (loop ? loopRuns(loop, stepIdx.length)
      : (function* () { for (const s of runStarts(points, stepIdx.length)) yield stepIdx.map((_, j) => along(points, s + j * BADGE_PITCH)); })());
    let chosen: Point[] | undefined;
    for (const soft of [[...others, ...prefer, ...lines], [...others, ...prefer], others, []]) {
      for (const ps of runs()) if (clear(ps, soft)) { chosen = ps; break; }
      if (chosen) break;
    }
    if (!chosen && !loop) chosen = oneByOne(points, stepIdx.length, (p) => clear([p], []));
    if (!chosen) throw new Error(`no room for the badge of step ${stepIdx[0]! + 1} on edge "${edge}"`);
    chosen.forEach((p, j) => { out[stepIdx[j]!] = p; placed.push(badgeRect(p, 0)); });
  }
  return out;
}

/** A run that does not fit in one piece, placed badge by badge in route order, each after the previous one. */
function oneByOne(points: Point[], k: number, ok: (p: Point) => boolean): Point[] | undefined {
  const total = points.slice(1).reduce((sum, q, i) => sum + Math.hypot(q.x - points[i]!.x, q.y - points[i]!.y), 0);
  const ps: Point[] = [];
  let s = 0;
  for (let j = 0; j < k; j++) {
    let found: Point | undefined;
    for (; s <= total; s += STEP) {
      const p = along(points, s);
      if (ok(p) && ps.every((q) => Math.hypot(q.x - p.x, q.y - p.y) >= BADGE_PITCH)) { found = p; s += BADGE_PITCH; break; }
    }
    if (!found) return undefined;
    ps.push(found);
  }
  return ps;
}

const bbox = (pts: Point[]): Rect => {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
};
