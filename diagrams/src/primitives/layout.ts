import type { ArchitectureData, FlowData } from "../schema";

export type Rect = { x: number; y: number; w: number; h: number };

const PAD = 24;
const TOP = 96; // title band
const ZONE_HEADER = 32;
const NODE_H = 56;
const GAP = 14;

export function layoutArchitecture(d: ArchitectureData, w: number, h: number) {
  const zones: Record<string, Rect> = {};
  const nodes: Record<string, Rect> = {};
  const zw = (w - PAD * (d.zones.length + 1)) / d.zones.length;
  d.zones.forEach((z, i) => {
    const zone = { x: PAD + i * (zw + PAD), y: TOP, w: zw, h: h - TOP - PAD };
    zones[z.id] = zone;
    const members = d.nodes.filter((n) => n.zone === z.id);
    const nodeH = Math.min(NODE_H, (zone.h - ZONE_HEADER - GAP * (members.length + 1)) / members.length);
    members.forEach((n, j) => {
      nodes[n.id] = { x: zone.x + GAP, y: zone.y + ZONE_HEADER + GAP + j * (nodeH + GAP), w: zone.w - 2 * GAP, h: nodeH };
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
