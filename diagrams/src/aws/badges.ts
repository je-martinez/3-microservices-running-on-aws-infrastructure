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

/**
 * Badge centre per step, on the step's first edge. Steps sharing an edge sit along it in step order from
 * the source end, BADGE_PITCH apart; every badge clears `avoid` and earlier badges by BADGE_GAP and keeps
 * off group borders when the route allows it, else the most clear run wins. Edge labels are placed after
 * the badges (see labels.ts), so they are not obstacles here.
 */
export function badgeCentres(steps: { edges: string[] }[], edges: Edges, groups: Rect[], avoid: Rect[] = []): Point[] {
  const labels = avoid;
  const lines = groups.flatMap(borders);
  const byEdge = new Map<string, number[]>();
  steps.forEach((s, i) => byEdge.set(s.edges[0]!, [...(byEdge.get(s.edges[0]!) ?? []), i]));
  const placed: Rect[] = [];
  const out: Point[] = new Array(steps.length);
  for (const [edge, stepIdx] of byEdge) {
    const points = edges[edge]!.points;
    const run = (s: number) => stepIdx.map((_, j) => along(points, s + j * BADGE_PITCH));
    const clearance = (ps: Point[], soft: Rect[]) =>
      Math.min(Infinity, ...ps.flatMap((p) => [...labels, ...placed, ...soft].map((o) => gap(badgeRect(p, 0), o))));
    let best: { ps: Point[]; score: number } | undefined;
    let chosen: Point[] | undefined;
    for (const soft of [lines, []]) {
      for (const s of runStarts(points, stepIdx.length)) {
        const ps = run(s);
        const score = clearance(ps, soft);
        if (score >= BADGE_GAP) { chosen = ps; break; }
        if (!best || score > best.score) best = { ps, score };
      }
      if (chosen) break;
    }
    const ps = chosen ?? best?.ps ?? run(0);
    ps.forEach((p, j) => { out[stepIdx[j]!] = p; placed.push(badgeRect(p, 0)); });
  }
  return out;
}
