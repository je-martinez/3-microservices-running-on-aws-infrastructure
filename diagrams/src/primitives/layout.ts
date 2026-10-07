import type { ArchitectureData, DependencyData, FlowData } from "../schema";
import { INTRO, STEP } from "../timing";

export type Rect = { x: number; y: number; w: number; h: number };

const PAD = 24;
const TOP = 96; // title band
const ZONE_HEADER = 32;
const NODE_H = 56;
const MIN_NODE_H = 44;
const NODE_H_DENSE = 72; // two-column zones have the room for 3 label lines plus a tag
const GAP = 14;
const BRACKET_OUT = 12;

export function layoutArchitecture(d: ArchitectureData, w: number, h: number) {
  const zones: Record<string, Rect> = {};
  const nodes: Record<string, Rect> = {};
  const zw = (w - PAD * (d.zones.length + 1)) / d.zones.length;
  d.zones.forEach((z, i) => {
    const zone = { x: PAD + i * (zw + PAD), y: TOP, w: zw, h: h - TOP - PAD };
    zones[z.id] = zone;
    const members = d.nodes.filter((n) => n.zone === z.id);
    const fit = (rows: number, cap = NODE_H) => Math.min(cap, (zone.h - ZONE_HEADER - GAP * (rows + 1)) / rows);
    // CONTRACT: a zone whose single column would drop nodes below MIN_NODE_H lays out in two sub-columns.
    const cols = members.length > 1 && fit(members.length) < MIN_NODE_H ? 2 : 1;
    const rows = Math.ceil(members.length / cols);
    const nodeH = fit(Math.max(rows, 1), cols === 2 ? NODE_H_DENSE : NODE_H);
    const nodeW = (zone.w - GAP * (cols + 1)) / cols;
    members.forEach((n, j) => {
      const col = Math.floor(j / rows), row = j % rows;
      nodes[n.id] = { x: zone.x + GAP + col * (nodeW + GAP), y: zone.y + ZONE_HEADER + GAP + row * (nodeH + GAP), w: nodeW, h: nodeH };
    });
  });
  return { zones, nodes };
}

export function edgePoints(a: Rect, b: Rect) {
  const acx = a.x + a.w / 2, acy = a.y + a.h / 2, bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
  if (Math.abs(bcx - acx) >= Math.abs(bcy - acy)) {
    const right = bcx > acx;
    return { x1: right ? a.x + a.w : a.x, y1: acy, x2: right ? b.x : b.x + b.w, y2: bcy };
  }
  const down = bcy > acy;
  return { x1: acx, y1: down ? a.y + a.h : a.y, x2: bcx, y2: down ? b.y : b.y + b.h };
}

/** True when two boxes are stacked in one column, where a straight edge would be ~GAP long. */
export function isSameColumn(a: Rect, b: Rect): boolean {
  return Math.abs(a.x - b.x) < 1 && Math.abs(a.w - b.w) < 1;
}

export type EdgePath = { d: string; len: number; label: { x: number; y: number; anchor: "middle" | "end" } };

/** SVG path for an edge; same-column edges bracket out through the zone's right padding. */
export function edgePath(a: Rect, b: Rect, sameColumn: boolean): EdgePath {
  if (sameColumn) {
    const ay = a.y + a.h / 2, by = b.y + b.h / 2;
    const ax = a.x + a.w, bx = b.x + b.w;
    const rx = Math.max(ax, bx) + BRACKET_OUT;
    const len = rx - ax + Math.abs(by - ay) + (rx - bx);
    return { d: `M ${ax} ${ay} H ${rx} V ${by} H ${bx}`, len, label: { x: rx - 4, y: (ay + by) / 2 + 5, anchor: "end" } };
  }
  const p = edgePoints(a, b);
  return {
    d: `M ${p.x1} ${p.y1} L ${p.x2} ${p.y2}`,
    len: Math.hypot(p.x2 - p.x1, p.y2 - p.y1),
    label: { x: (p.x1 + p.x2) / 2, y: (p.y1 + p.y2) / 2 - 8, anchor: "middle" },
  };
}

/** Boxes narrower than this drop their AWS icon so the label keeps the width. */
export const ICON_MIN_W = 140;

/** Height of the small id line a tagged box (dependency task) draws above its label. */
export const TAG_H = 16;

/** Pick the label font size and line count that fit `label` in a box `w` x `h`; `clipped` when none does. */
export function fitLabel(label: string, w: number, h: number, hasIcon: boolean, reserved = 0) {
  const pad = w < 120 ? 8 : 10;
  const icon = hasIcon ? Math.max(20, Math.min(36, h - 16, w * 0.2)) : 0;
  const avail = w - 4 - 2 * pad - (hasIcon ? icon + 10 : 0);
  const inner = h - 8 - reserved;
  const width = (size: number) => label.length * size * 0.58;
  for (let lines = 1; lines <= 3; lines++) {
    const sizes = lines === 1 ? [18, 17, 16, 15] : [17, 16, 15, 14, 13];
    for (const size of sizes) {
      if (lines * size * 1.1 <= inner && width(size) <= avail * lines * (lines === 1 ? 1 : 0.92)) return { size, lines, icon, pad, clipped: false };
    }
  }
  return { size: 13, lines: Math.max(1, Math.min(3, Math.floor(inner / 14.3))), icon, pad, clipped: true };
}

const JOG = 26; // half the free run between two phase columns' tasks (GAP + PAD + GAP)
const LANE_MIN = 8; // the arrow's halo width: a row gap narrower than this is not a lane

/** True when the segment crosses the interior of `r` (Liang-Barsky clip). */
function segmentHits(x1: number, y1: number, x2: number, y2: number, r: Rect): boolean {
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  const clips: [number, number][] = [[-dx, x1 - r.x], [dx, r.x + r.w - x1], [-dy, y1 - r.y], [dy, r.y + r.h - y1]];
  for (const [p, q] of clips) {
    if (p === 0) { if (q <= 0) return false; continue; }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    if (t0 >= t1) return false;
  }
  return true;
}

/** The y of the free horizontal lane in [xa, xb] closest to `near`: a row gap, else below the lowest task. */
function laneY(xa: number, xb: number, near: number, others: Rect[]): number {
  const spans = others.filter((r) => r.x < xb && r.x + r.w > xa).map((r) => [r.y, r.y + r.h] as const).sort((p, q) => p[0] - q[0]);
  const lanes: number[] = [];
  let bottom = -Infinity;
  for (const [top, end] of spans) {
    if (bottom > -Infinity && top - bottom >= LANE_MIN) lanes.push((bottom + top) / 2);
    bottom = Math.max(bottom, end);
  }
  lanes.push(bottom + 7);
  return lanes.reduce((best, y) => (Math.abs(y - near) < Math.abs(best - near) ? y : best));
}

/**
 * SVG path for a dependency arrow: side to side between columns, whatever the row gap, so a steep
 * edge never leaves through the top of its task. When another task sits on that line, the arrow
 * detours through the nearest free row gap instead of cutting through the task's label.
 */
export function depPath(a: Rect, b: Rect, tasks: Rect[] = []): EdgePath {
  if (isSameColumn(a, b)) return edgePath(a, b, true);
  const right = b.x > a.x;
  const x1 = right ? a.x + a.w : a.x, y1 = a.y + a.h / 2, x2 = right ? b.x : b.x + b.w, y2 = b.y + b.h / 2;
  const others = tasks.filter((r) => r !== a && r !== b);
  if (!others.some((r) => segmentHits(x1, y1, x2, y2, r))) {
    return {
      d: `M ${x1} ${y1} L ${x2} ${y2}`,
      len: Math.hypot(x2 - x1, y2 - y1),
      label: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 8, anchor: "middle" },
    };
  }
  const dir = right ? 1 : -1;
  const xa = x1 + dir * JOG, xb = x2 - dir * JOG;
  // WHY nearest the SOURCE row: every detour leaving one task shares a single trunk and reads as a tree.
  const ly = laneY(Math.min(xa, xb), Math.max(xa, xb), y1, others);
  return {
    d: `M ${x1} ${y1} H ${xa} V ${ly} H ${xb} V ${y2} H ${x2}`,
    len: 2 * JOG + Math.abs(ly - y1) + Math.abs(xb - xa) + Math.abs(y2 - ly),
    label: { x: (xa + xb) / 2, y: ly - 8, anchor: "middle" },
  };
}

/** Index of the edge/step animating at `frame`; undefined during the intro and once all are done. */
export function activeIndex(frame: number, n: number, step = STEP): number | undefined {
  const i = Math.floor((frame - INTRO) / step);
  return i >= 0 && i < n ? i : undefined;
}

const LANE_TOP = 96;
const HEADER_H = 52;
const CAPTION_SPACE = 18 + 48 + 16;

export function layoutFlow(d: FlowData, w: number, h: number) {
  const laneW = (w - PAD * 2) / d.actors.length;
  const lanes: Record<string, { x: number; header: Rect }> = {};
  d.actors.forEach((a, i) => {
    const x = PAD + laneW * i + laneW / 2;
    lanes[a.id] = { x, header: { x: x - Math.min(200, laneW - 16) / 2, y: LANE_TOP, w: Math.min(200, laneW - 16), h: HEADER_H } };
  });
  const firstRow = LANE_TOP + HEADER_H + 30;
  const rowH = (h - CAPTION_SPACE - firstRow) / Math.max(d.steps.length, 1);
  return { lanes, rowY: (i: number) => firstRow + rowH * i + rowH / 2 };
}

export function layoutDependency(d: DependencyData, w: number, h: number) {
  // WARNING: do NOT route this through ArchitectureData.parse; task labels allow 30 chars, node labels 22.
  const { zones, nodes } = layoutArchitecture(
    { title: d.title, zones: d.phases, nodes: d.tasks.map((t) => ({ id: t.id, label: t.label, kind: "compute" as const, zone: t.phase })), edges: [] },
    w,
    h,
  );
  return { phases: zones, tasks: nodes };
}
