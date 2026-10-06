import type { ArchitectureData } from "../schema";

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
