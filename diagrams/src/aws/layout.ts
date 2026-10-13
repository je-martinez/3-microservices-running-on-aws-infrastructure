import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkExtendedEdge, ElkLabel, ElkNode, ElkPort } from "elkjs/lib/elk-api";
import { AWS } from "../theme/aws-style";
import { GROUP_ICON, groupHeader, groupHeaderRect } from "./header";
import { textWidth, wrap } from "./measure";
import type { AwsDiagramData } from "./schema";

export type Rect = { x: number; y: number; w: number; h: number };
export type Point = { x: number; y: number };
export type DiagramLayout = {
  width: number;
  height: number;
  groups: Record<string, Rect>;
  nodes: Record<string, Rect & { labelLines: string[] }>;
  edges: Record<string, { points: Point[]; label?: Rect }>;
  /** A vpc's Availability Zone lanes, in declared order; drawn behind its contents. */
  lanes: Record<string, Lane[]>;
};
export type Lane = { label: string; sublabel?: string; rect: Rect; header: Rect };

/** Height of a lane's header (AZ label plus subnet sublabel); a vpc with lanes reserves it above its contents. */
export const LANE_HEADER_H = 40;
const LANE_INSET = 10;
const LANE_GAP = 8;
const LANE_TEXT_PAD = 6;

/** The area a vpc's lanes split between them: below its header, inset from its frame. */
export function vpcLaneArea(vpc: Rect): Rect {
  const top = vpc.y + AWS.groupHeader;
  return { x: vpc.x + LANE_INSET, y: top, w: vpc.w - 2 * LANE_INSET, h: vpc.y + vpc.h - LANE_INSET - top };
}

function laneRects(g: AwsDiagramData["groups"][number], vpc: Rect): Lane[] {
  const area = vpcLaneArea(vpc);
  const n = g.lanes!.length;
  const w = (area.w - (n - 1) * LANE_GAP) / n;
  return g.lanes!.map((lane, i) => {
    const rect = { x: area.x + i * (w + LANE_GAP), y: area.y, w, h: area.h };
    const textW = Math.max(textWidth(lane.label, 13), lane.sublabel ? textWidth(lane.sublabel, 12) : 0);
    return { ...lane, rect, header: { x: rect.x, y: rect.y, w: Math.min(w, textW + 2 * LANE_TEXT_PAD), h: LANE_HEADER_H } };
  });
}

const ROOT = "__root__";
// WHY: each route jogging round a group's header needs its own 16px lane under the header.
const HEADER_LANE = 16;
type Lanes = Map<string, number>;
const LINE_H = 16;

const elk = new ELK();

// WHY: parallel routes 16px apart leave room for a 22px badge on one without hiding its neighbours. ELK reads
// spacing from the graph that holds the route, so every group carries it too.
const EDGE_SPACING = {
  "elk.spacing.edgeEdge": "16",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "16",
  "elk.spacing.edgeNode": "20",
  "elk.layered.spacing.edgeNodeBetweenLayers": "20",
  "elk.spacing.portPort": "16",
  // WHY: a self-loop taller than a badge stays visible beside the badge that numbers it.
  "elk.spacing.nodeSelfLoop": "28",
};

const ROOT_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.spacing.nodeNodeBetweenLayers": "70",
  "elk.spacing.nodeNode": "40",
  "elk.spacing.edgeLabel": "6",
  ...EDGE_SPACING,
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.padding": "[top=20,left=20,bottom=20,right=20]",
};


function nodeBox(n: AwsDiagramData["nodes"][number]): { w: number; h: number; labelLines: string[] } {
  if (n.icon === "task") return { w: AWS.taskW, h: AWS.taskH, labelLines: wrap(n.label, AWS.labelFont, AWS.taskW - 16, 2) };
  const maxW = Math.max(110, AWS.iconSize + 60);
  const labelLines = wrap(n.label, AWS.labelFont, maxW, 2);
  const lineWidths = labelLines.map((l) => textWidth(l, AWS.labelFont));
  if (n.sublabel) lineWidths.push(Math.min(maxW, textWidth(n.sublabel, AWS.sublabelFont)));
  const w = Math.max(AWS.iconSize + 24, Math.max(0, ...lineWidths) + 8);
  const h = AWS.iconSize + 6 + labelLines.length * LINE_H + (n.sublabel ? LINE_H : 0);
  return { w, h, labelLines };
}

type Side = "WEST" | "EAST" | "NORTH" | "SOUTH";
type EdgeSides = Map<string, { from: Side; to: Side; back?: boolean }>;
type Centres = Map<string, Point>;

// WHY: endpoints closer than this along the flow axis share a layer/row and connect side by side.
const SAME_LAYER = 30;

/** Forward-flow sides, used for the first pass before node positions are known. */
function flowSides(d: AwsDiagramData): EdgeSides {
  const side = d.direction === "RIGHT" ? { from: "EAST", to: "WEST" } as const : { from: "EAST", to: "NORTH" } as const;
  return new Map(d.edges.map((e) => [e.id, side]));
}

// CONTRACT: no edge ends on a SOUTH side: below an icon sits its label. Back edges leave and enter on the
// sides facing each other and reach ELK reversed (`back`), so they never loop around a group or the canvas.
function facingSides(d: AwsDiagramData, c: Centres, frames: Record<string, Rect>): EdgeSides {
  const out: EdgeSides = new Map();
  for (const e of d.edges) {
    if (e.from === e.to) continue;
    const a = c.get(e.from)!, b = c.get(e.to)!;
    const dx = b.x - a.x, dy = b.y - a.y;
    const across = (): { from: Side; to: Side } => (dx >= 0 ? { from: "EAST", to: "WEST" } : { from: "WEST", to: "EAST" });
    if (d.direction === "RIGHT") {
      if (Math.abs(dx) > SAME_LAYER) out.set(e.id, { ...across(), back: dx < 0 });
      else out.set(e.id, dy >= 0 ? { from: "EAST", to: "NORTH" } : { from: "NORTH", to: "EAST" });
    } else if (dy > SAME_LAYER) out.set(e.id, { from: dx < -SAME_LAYER ? "WEST" : "EAST", to: "NORTH" });
    else if (dy < -SAME_LAYER) out.set(e.id, { from: "NORTH", to: dx >= 0 ? "WEST" : "EAST", back: true });
    else out.set(e.id, across());
  }
  for (const e of d.edges) if (e.from === e.to) out.set(e.id, loopSides(e.from, d, out));
  // A group end takes the frame side facing the far end; a group has no label below, so SOUTH is fine.
  const groupIds = new Set(d.groups.map((g) => g.id));
  for (const e of d.edges) {
    const s = out.get(e.id)!;
    const facing = (self: string, other: string): Side => {
      const [a, b] = [c.get(self)!, c.get(other)!];
      const [dx, dy] = [b.x - a.x, b.y - a.y];
      const side: Side = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? "EAST" : "WEST") : (dy >= 0 ? "SOUTH" : "NORTH");
      const frame = frames[self]!;
      const g = d.groups.find((x) => x.id === self)!;
      // WHY: a header spanning the top leaves no room for a port there; the side facing the far end takes it.
      const roomy = frame.w - groupHeader(g.kind, g.label).width - 2 * GROUP_PORT_MARGIN >= 0;
      return side === "NORTH" && !roomy ? (dx >= 0 ? "EAST" : "WEST") : side;
    };
    if (groupIds.has(e.from)) s.from = facing(e.from, e.to);
    if (groupIds.has(e.to)) s.to = facing(e.to, e.from);
  }
  return out;
}

const LOOP_SIDES: { from: Side; to: Side }[] = [
  { from: "NORTH", to: "NORTH" }, { from: "WEST", to: "NORTH" }, { from: "EAST", to: "NORTH" },
  { from: "WEST", to: "WEST" }, { from: "EAST", to: "EAST" },
];

/** A self-loop goes on the sides its node's other edges use least, so it crosses none of them. */
function loopSides(node: string, d: AwsDiagramData, sides: EdgeSides): { from: Side; to: Side } {
  const used = new Map<Side, number>();
  for (const e of d.edges) {
    if (e.from === e.to) continue;
    const s = sides.get(e.id)!;
    if (e.from === node) used.set(s.from, (used.get(s.from) ?? 0) + 1);
    if (e.to === node) used.set(s.to, (used.get(s.to) ?? 0) + 1);
  }
  const cost = (o: { from: Side; to: Side }) => (used.get(o.from) ?? 0) + (o.to === o.from ? 0 : used.get(o.to) ?? 0);
  return LOOP_SIDES.reduce((best, o) => (cost(o) < cost(best) ? o : best));
}

const PORT_PITCH = 16;

const portId = (edge: string, end: "from" | "to") => `${edge}__${end}`;

// CONTRACT: one port per edge end, spread across the icon band of its side (never the label below), ordered
// by the far endpoint so parallel edges neither share a trunk nor cross at the node.
function iconPorts(d: AwsDiagramData, sides: EdgeSides, c: Centres | undefined, widths: Map<string, number>): Map<string, ElkPort[]> {
  const bySide = new Map<string, { id: string; side: Side; key: number }[]>();
  d.edges.forEach((e, i) => {
    for (const end of ["from", "to"] as const) {
      const node = e[end], far = e[end === "from" ? "to" : "from"];
      if (!widths.has(node)) continue;
      const side = sides.get(e.id)![end];
      const fp = c?.get(far);
      // WHY: a self-loop's ports sit at the corner its two sides share, so the loop stays small.
      const loopKey = side === "NORTH" ? (sides.get(e.id)![end === "from" ? "to" : "from"] === "EAST" ? Infinity : -Infinity) : -Infinity;
      const key = e.from === e.to ? loopKey : fp ? (side === "NORTH" ? fp.x : fp.y) : i;
      const k = `${node}|${side}`;
      bySide.set(k, [...(bySide.get(k) ?? []), { id: portId(e.id, end), side, key }]);
    }
  });
  const ports = new Map<string, ElkPort[]>();
  for (const [k, list] of bySide) {
    const node = k.slice(0, k.indexOf("|"));
    const left = (widths.get(node)! - AWS.iconSize) / 2;
    list.sort((p, q) => p.key - q.key);
    // WHY: ports PORT_PITCH apart leave a badge (22px) room between parallel routes; a fan that cannot fit
    // compresses to the icon's full height.
    const span = AWS.iconSize / (list.length + 1);
    // WHY: a self-loop alone on a side spans the icon, so the loop is wide enough to show beside its badge.
    const loopOnly = list.length === 2 && list[0]!.id.replace(/__(from|to)$/, "") === list[1]!.id.replace(/__(from|to)$/, "");
    const pitch = loopOnly ? AWS.iconSize - 8
      : span >= PORT_PITCH ? span : (list.length - 1) * PORT_PITCH <= AWS.iconSize ? PORT_PITCH : AWS.iconSize / (list.length - 1);
    list.forEach((p, i) => {
      const t = AWS.iconSize / 2 + (i - (list.length - 1) / 2) * pitch;
      const x = p.side === "NORTH" ? left + t : p.side === "WEST" ? left : left + AWS.iconSize;
      const y = p.side === "NORTH" ? 0 : t;
      const port: ElkPort = { id: p.id, x, y, width: 0, height: 0,
        layoutOptions: { "elk.port.side": p.side, "elk.port.borderOffset": String(p.side === "NORTH" ? 0 : -left) } };
      ports.set(node, [...(ports.get(node) ?? []), port]);
    });
  }
  return ports;
}

const GROUP_PORT_MARGIN = 12;
const MEMBER_CLEAR = 10;

/** Every node inside group `gid`, at any depth. */
function membersOf(d: AwsDiagramData, gid: string): string[] {
  const parent = new Map(d.groups.map((g) => [g.id, g.parent]));
  const inside = (g: string | undefined): boolean => g !== undefined && (g === gid || inside(parent.get(g)));
  return d.nodes.filter((n) => inside(n.group)).map((n) => n.id);
}

/** Group-frame ports per group, ranked along each side by the far endpoint so their routes do not cross. */
function groupPortsBySide(d: AwsDiagramData, sides: EdgeSides, c: Centres | undefined) {
  const groupIds = new Set(d.groups.map((g) => g.id));
  const raw = new Map<string, { id: string; side: Side; key: number }[]>();
  d.edges.forEach((e, i) => {
    for (const which of ["from", "to"] as const) {
      const gid = e[which];
      if (!groupIds.has(gid)) continue;
      const side = sides.get(e.id)![which];
      const far = c?.get(e[which === "from" ? "to" : "from"]);
      const key = far ? (side === "NORTH" || side === "SOUTH" ? far.x : far.y) : i;
      raw.set(gid, [...(raw.get(gid) ?? []), { id: portId(e.id, which), side, key }]);
    }
  });
  const out = new Map<string, { id: string; side: Side; rank: number; count: number }[]>();
  for (const [gid, list] of raw) {
    const ranked = list.map((p) => {
      const same = list.filter((q) => q.side === p.side).sort((a, b) => a.key - b.key);
      return { id: p.id, side: p.side, rank: same.indexOf(p), count: same.length };
    });
    out.set(gid, ranked);
  }
  return out;
}

function buildGraph(
  d: AwsDiagramData, labelLines: Map<string, string[]>, sides: EdgeSides, centres: Centres | undefined, lanes: Lanes,
  frames?: Record<string, Rect>, nodesPrev?: Record<string, Rect>,
): ElkNode {
  const root: ElkNode = { id: ROOT, layoutOptions: { ...ROOT_OPTIONS, "elk.direction": d.direction }, children: [], edges: [] };
  const elkGroups = new Map<string, ElkNode>();
  for (const g of d.groups) {
    // WHY: The minimum width keeps the corner icon and group label inside the container border.
    const minW = groupHeader(g.kind, g.label).width + AWS.groupPad;
    elkGroups.set(g.id, {
      id: g.id,
      children: [],
      layoutOptions: {
        ...EDGE_SPACING,
        "elk.padding": `[top=${AWS.groupHeader + AWS.groupPad + (g.lanes ? LANE_HEADER_H : 0) + HEADER_LANE * (lanes.get(g.id) ?? 0)},left=${AWS.groupPad},bottom=${AWS.groupPad},right=${AWS.groupPad}]`,
        "elk.nodeSize.constraints": "MINIMUM_SIZE",
        // WORKAROUND(provider): Do NOT pass the minimum as (w,h) in a DOWN layout: elkjs 0.12 reads a compound
        // node's minimum transposed there, and the frame comes out narrower than its header label.
        "elk.nodeSize.minimum": d.direction === "DOWN" ? `(${AWS.groupHeader + AWS.groupPad * 2},${minW})` : `(${minW},${AWS.groupHeader + AWS.groupPad * 2})`,
      },
    });
  }
  // CONTRACT: a group endpoint is a port on the group's frame, never in its header band. Before the frame's
  // size is known ELK picks the spot on the side; afterwards ports spread over the side's free stretch.
  const groupIds = new Set(d.groups.map((g) => g.id));
  for (const [gid, list] of groupPortsBySide(d, sides, centres)) {
    const g = elkGroups.get(gid)!;
    const frame = frames?.[gid];
    const grp = d.groups.find((x) => x.id === gid)!;
    const members = frame && nodesPrev ? membersOf(d, gid).map((id) => nodesPrev[id]!) : [];
    g.ports = list.map((p) => {
      const port: ElkPort = { id: p.id, width: 0, height: 0, layoutOptions: { "elk.port.side": p.side } };
      if (!frame) return port;
      const horizontal = p.side === "NORTH" || p.side === "SOUTH";
      const along = horizontal ? frame.w : frame.h;
      const lo = p.side === "NORTH" ? groupHeader(grp.kind, grp.label).width + GROUP_PORT_MARGIN
        : p.side === "SOUTH" ? GROUP_PORT_MARGIN : GROUP_ICON + GROUP_PORT_MARGIN;
      const hi = along - GROUP_PORT_MARGIN;
      // WHY: a frame port level with a member icon reads as that member's own edge; ports use the gaps between members.
      const blocked: [number, number][] = members.map((n) => (horizontal ? [n.x - frame.x, n.x - frame.x + n.w] : [n.y - frame.y, n.y - frame.y + AWS.iconSize]));
      const free: number[] = [];
      for (let v = lo; v <= hi; v += 2) if (!blocked.some(([a, b]) => v > a - MEMBER_CLEAR && v < b + MEMBER_CLEAR)) free.push(v);
      const t = free.length ? free[Math.round(((p.rank + 0.5) / p.count) * (free.length - 1))]!
        : hi > lo ? lo + ((hi - lo) * (p.rank + 1)) / (p.count + 1) : along / 2;
      return { ...port, ...(p.side === "NORTH" ? { x: t, y: 0 } : p.side === "SOUTH" ? { x: t, y: frame.h } : p.side === "WEST" ? { x: 0, y: t } : { x: frame.w, y: t }) };
    });
    Object.assign(g.layoutOptions!, { "elk.portConstraints": frame ? "FIXED_POS" : "FIXED_SIDE" });
  }
  const childrenOf = (parent: string | undefined) => (parent ? elkGroups.get(parent)! : root).children!;
  for (const g of d.groups) childrenOf(g.parent).push(elkGroups.get(g.id)!);
  const widths = new Map(d.nodes.filter((n) => n.icon !== "task").map((n) => [n.id, nodeBox(n).w]));
  const ports = iconPorts(d, sides, centres, widths);
  for (const n of d.nodes) {
    const box = nodeBox(n);
    labelLines.set(n.id, box.labelLines);
    if (!widths.has(n.id)) { childrenOf(n.group).push({ id: n.id, width: box.w, height: box.h }); continue; }
    childrenOf(n.group).push({ id: n.id, width: box.w, height: box.h, ports: ports.get(n.id) ?? [],
      layoutOptions: { "elk.portConstraints": "FIXED_POS" } });
  }
  const end = (e: AwsDiagramData["edges"][number], which: "from" | "to") =>
    (widths.has(e[which]) || groupIds.has(e[which]) ? portId(e.id, which) : e[which]);
  for (const e of d.edges) {
    const labels: ElkLabel[] = e.label
      ? [{ id: `${e.id}__label`, text: e.label, width: textWidth(e.label, AWS.edgeLabelFont) + 8, height: LINE_H, layoutOptions: { "elk.edgeLabels.placement": "CENTER" } }]
      : [];
    const [src, dst] = sides.get(e.id)!.back ? [end(e, "to"), end(e, "from")] : [end(e, "from"), end(e, "to")];
    root.edges!.push({ id: e.id, sources: [src], targets: [dst], labels });
  }
  return root;
}

// WHY two passes: port sides depend on where ELK puts the endpoints, so a forward-flow pass places the
// nodes and the final pass gives every edge the sides facing its far endpoint.
export async function layoutDiagram(d: AwsDiagramData): Promise<DiagramLayout> {
  const first = await place(d, flowSides(d), undefined, new Map());
  const centres: Centres = new Map(Object.entries({ ...first.groups, ...first.nodes }).map(([id, r]) => [id, { x: r.x + r.w / 2, y: r.y + r.h / 2 }]));
  const sides = facingSides(d, centres, first.groups);
  let out = await place(d, sides, centres, new Map(), first.groups, first.nodes);
  // WHY: a group whose header several routes cross is laid out again with one lane per extra route.
  const lanes: Lanes = new Map([...out.headerCrossings].filter(([, n]) => n > 1).map(([g, n]) => [g, n - 1]));
  if (lanes.size) out = await place(d, sides, centres, lanes, out.groups, out.nodes);
  return out;
}

// CONTRACT: a group-frame edge end never sits level with a member icon (it would read as that member's own
// edge) nor in the header band. ELK places ports of a nested compound node itself, ignoring FIXED_POS, so the
// end slides along its frame side to the nearest free spot and the route's first leg follows it orthogonally.
function settleFramePorts(d: AwsDiagramData, l: DiagramLayout): void {
  const taken = new Map<string, number[]>();
  const parent = new Map(d.groups.map((g) => [g.id, g.parent]));
  const depth = (g: string | undefined): number => (g ? 1 + depth(parent.get(g)) : 0);
  // WHY: nested frames settle first, so an outer frame's ports can avoid the routes leaving them.
  const ends = d.edges.flatMap((e) => (["from", "to"] as const).filter((w) => l.groups[e[w]]).map((which) => ({ e, which })))
    .sort((a, b) => depth(b.e[b.which]) - depth(a.e[a.which]));
  for (const { e, which } of ends) {
    const gid = e[which];
    const frame = l.groups[gid]!;
    const route = l.edges[e.id]!;
    const pts = which === "from" ? route.points : [...route.points].reverse();
    const [p, q] = [pts[0]!, pts[1]!];
    const side = Math.abs(p.x - frame.x) < 1 ? "WEST" : Math.abs(p.x - frame.x - frame.w) < 1 ? "EAST" : Math.abs(p.y - frame.y) < 1 ? "NORTH" : "SOUTH";
    const vertical = side === "WEST" || side === "EAST";
    const grp = d.groups.find((g) => g.id === gid)!;
    const [start, end] = vertical ? [frame.y, frame.y + frame.h] : [frame.x, frame.x + frame.w];
    const lo = start + (side === "NORTH" ? groupHeader(grp.kind, grp.label).width : vertical ? GROUP_ICON : 0) + GROUP_PORT_MARGIN;
    const hi = end - GROUP_PORT_MARGIN;
    const bands = membersOf(d, gid).map((id) => {
      const r = l.nodes[id]!;
      return vertical ? [r.y, r.y + AWS.iconSize] : [r.x + (r.w - AWS.iconSize) / 2, r.x + (r.w + AWS.iconSize) / 2];
    });
    const key = `${gid}|${side}`;
    // WHY: a route leaving nested content crosses this side too; a port level with it would run on top of it.
    const line = vertical ? (side === "WEST" ? frame.x : frame.x + frame.w) : (side === "NORTH" ? frame.y : frame.y + frame.h);
    const crossings = d.edges.filter((o) => o.id !== e.id).flatMap((o) => {
      const pts2 = l.edges[o.id]!.points;
      return pts2.slice(1).flatMap((b, i) => {
        const a = pts2[i]!;
        const [u0, u1, w0] = vertical ? [a.x, b.x, a.y] : [a.y, b.y, a.x];
        const along2 = vertical ? b.y : b.x;
        const crosses = Math.abs(along2 - w0) < 0.5 && Math.min(u0, u1) < line - 0.5 && Math.max(u0, u1) > line + 0.5;
        return crosses && w0 > start && w0 < end ? [w0] : [];
      });
    });
    const others = [...(taken.get(key) ?? []), ...crossings];
    const ok = (v: number) => v >= lo && v <= hi && !bands.some(([a, b]) => v > a! - MEMBER_CLEAR && v < b! + MEMBER_CLEAR)
      && others.every((o) => Math.abs(o - v) >= PORT_PITCH);
    const cur = vertical ? p.y : p.x;
    let v = cur;
    if (!ok(cur)) for (let off = 2; off <= end - start; off += 2) {
      if (ok(cur + off)) { v = cur + off; break; }
      if (ok(cur - off)) { v = cur - off; break; }
    }
    taken.set(key, [...(taken.get(key) ?? []), v]);
    if (v === cur) continue;
    const moved = vertical ? { x: p.x, y: v } : { x: v, y: p.y };
    const perpendicular = vertical ? Math.abs(q.y - p.y) < 0.5 : Math.abs(q.x - p.x) < 0.5;
    // The first leg leaves the frame perpendicular to it; it keeps that direction at the new offset.
    const out = perpendicular && pts.length > 2
      ? [moved, vertical ? { x: q.x, y: v } : { x: v, y: q.y }, ...pts.slice(2)]
      : (() => {
        const mid = vertical ? { x: (p.x + q.x) / 2, y: v } : { x: v, y: (p.y + q.y) / 2 };
        const back = vertical ? { x: mid.x, y: p.y } : { x: p.x, y: mid.y };
        return [moved, mid, back, ...pts.slice(1)];
      })();
    route.points = which === "from" ? out : out.reverse();
  }
}

async function place(
  d: AwsDiagramData, sides: EdgeSides, centres: Centres | undefined, lanes: Lanes, frames?: Record<string, Rect>, nodesPrev?: Record<string, Rect>,
): Promise<DiagramLayout & { headerCrossings: Map<string, number> }> {
  const labelLines = new Map<string, string[]>();
  const result = await elk.layout(buildGraph(d, labelLines, sides, centres, lanes, frames, nodesPrev));
  const groupIds = new Set(d.groups.map((g) => g.id));
  const out: DiagramLayout = { width: result.width ?? 0, height: (result.height ?? 0) + AWS.titleH, groups: {}, nodes: {}, edges: {}, lanes: {} };

  // CONTRACT: ELK shapes are relative to their parent; edge sections and labels are relative to the edge's
  // `container` (the lowest common ancestor of its endpoints), whatever level declared the edge.
  const origin = new Map<string, Point>([[ROOT, { x: 0, y: AWS.titleH }]]);
  const edges: ElkExtendedEdge[] = [];
  const visit = (node: ElkNode, base: Point) => {
    edges.push(...(node.edges ?? []));
    for (const c of node.children ?? []) {
      const abs = { x: base.x + (c.x ?? 0), y: base.y + (c.y ?? 0) };
      origin.set(c.id, abs);
      const rect = { x: abs.x, y: abs.y, w: c.width ?? 0, h: c.height ?? 0 };
      if (groupIds.has(c.id)) out.groups[c.id] = rect;
      else out.nodes[c.id] = { ...rect, labelLines: labelLines.get(c.id) ?? [] };
      visit(c, abs);
    }
  };
  visit(result, origin.get(ROOT)!);

  for (const e of edges) {
    const base = origin.get((e as ElkExtendedEdge & { container?: string }).container ?? ROOT);
    const section = e.sections?.[0];
    if (!base || !section) throw new Error(`ELK returned no route for edge "${e.id}"`);
    // CONTRACT: one polyline per edge; a split route would silently drop every section after the first.
    if ((e.sections?.length ?? 0) > 1) throw new Error(`ELK returned ${e.sections!.length} sections for edge "${e.id}"`);
    const shift = (p: Point) => ({ x: base.x + p.x, y: base.y + p.y });
    const routed = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map(shift);
    const points = sides.get(e.id)!.back ? routed.reverse() : routed;
    const l = e.labels?.[0];
    out.edges[e.id] = l ? { points, label: { ...shift({ x: l.x ?? 0, y: l.y ?? 0 }), w: l.width ?? 0, h: l.height ?? 0 } } : { points };
  }
  for (const g of d.groups) if (g.lanes) out.lanes[g.id] = laneRects(g, out.groups[g.id]!);
  settleFramePorts(d, out);
  const headers = [
    ...d.groups.map((g) => groupHeaderRect(out.groups[g.id]!, g.kind, g.label)),
    ...Object.values(out.lanes).flat().map((lane) => lane.header),
  ];
  const headerCrossings = new Map(d.groups.map((g, i) => [g.id, Object.values(out.edges).filter((r) => crossesHeader(r.points, headers[i]!)).length]));
  for (const [id, route] of Object.entries(out.edges)) {
    const others = Object.entries(out.edges).filter(([o]) => o !== id).map(([, r]) => r.points);
    route.points = clearHeaders(route.points, headers, others);
  }
  return { ...out, headerCrossings };
}

function crossesHeader(points: Point[], h: Rect): boolean {
  return points.slice(1).some((q, i) => {
    const p = points[i]!;
    return Math.min(p.x, q.x) < h.x + h.w && Math.max(p.x, q.x) > h.x && Math.min(p.y, q.y) < h.y + h.h && Math.max(p.y, q.y) > h.y;
  });
}

const HEADER_CLEAR = 8;

// CONTRACT: no route crosses a group's corner icon and label. ELK routes into a group through its top padding,
// so a segment crossing a header jogs around the header's far side, through the gaps above and below it.
function clearHeaders(points: Point[], headers: Rect[], others: Point[][]): Point[] {
  // A jog lane runs where no other route runs within 12px along the same stretch.
  const busy = (vertical: boolean, at: number, from: number, to: number) => others.some((o) => o.slice(1).some((q, i) => {
    const p = o[i]!;
    const along = vertical ? Math.abs(p.x - q.x) < 0.5 : Math.abs(p.y - q.y) < 0.5;
    const pos = vertical ? p.x : p.y;
    const [lo, hi] = vertical ? [Math.min(p.y, q.y), Math.max(p.y, q.y)] : [Math.min(p.x, q.x), Math.max(p.x, q.x)];
    return along && Math.abs(pos - at) < 12 && lo < Math.max(from, to) && hi > Math.min(from, to);
  }));
  let pts = points;
  for (const h of headers) {
    const out: Point[] = [pts[0]!];
    for (let i = 1; i < pts.length; i++) {
      const [p, q] = [pts[i - 1]!, pts[i]!];
      const vertical = Math.abs(p.x - q.x) < 0.5;
      const [lo, hi] = vertical ? [Math.min(p.y, q.y), Math.max(p.y, q.y)] : [Math.min(p.x, q.x), Math.max(p.x, q.x)];
      const crosses = vertical
        ? p.x > h.x && p.x < h.x + h.w && lo < h.y + h.h && hi > h.y
        : p.y > h.y && p.y < h.y + h.h && lo < h.x + h.w && hi > h.x;
      const [before, after] = vertical ? [h.y - HEADER_CLEAR, h.y + h.h + HEADER_CLEAR] : [h.x - HEADER_CLEAR, h.x + h.w + HEADER_CLEAR];
      if (!crosses || lo > before || hi < after) { out.push(q); continue; }
      const forward = vertical ? q.y > p.y : q.x > p.x;
      const [a, b] = forward ? [before, after] : [after, before];
      // WHY: each jog takes the first free lanes: the detour steps 16px outward, the legs 16px away from the header.
      const step = forward ? 16 : -16;
      let lane = vertical ? h.x + h.w + HEADER_CLEAR : h.y + h.h + HEADER_CLEAR;
      while (busy(vertical, lane, a - 16, b + 16)) lane += 16;
      const from = vertical ? p.x : p.y;
      let [la, lb] = [a, b];
      for (let k = 0; k < 6; k++) if (!busy(!vertical, a - step * k, from, lane)) { la = a - step * k; break; }
      for (let k = 0; k < 6; k++) if (!busy(!vertical, b + step * k, from, lane)) { lb = b + step * k; break; }
      out.push(...(vertical
        ? [{ x: p.x, y: la }, { x: lane, y: la }, { x: lane, y: lb }, { x: p.x, y: lb }]
        : [{ x: la, y: p.y }, { x: la, y: lane }, { x: lb, y: lane }, { x: lb, y: p.y }]), q);
    }
    pts = out;
  }
  return pts;
}
