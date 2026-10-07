import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkExtendedEdge, ElkLabel, ElkNode, ElkPort } from "elkjs/lib/elk-api";
import { AWS } from "../theme/aws-style";
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
};

const ROOT = "__root__";
const GROUP_ICON = 32;
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

/** Band a group's corner icon and label occupy; routes keep out of it. */
export function groupHeaderRect(g: Rect, label: string): Rect {
  return { x: g.x, y: g.y, w: GROUP_ICON + 8 + textWidth(label, 14) + 4, h: GROUP_ICON };
}

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

type Side = "WEST" | "EAST" | "NORTH";
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
function facingSides(d: AwsDiagramData, c: Centres): EdgeSides {
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

function buildGraph(d: AwsDiagramData, labelLines: Map<string, string[]>, sides: EdgeSides, centres: Centres | undefined, lanes: Lanes): ElkNode {
  const root: ElkNode = { id: ROOT, layoutOptions: { ...ROOT_OPTIONS, "elk.direction": d.direction }, children: [], edges: [] };
  const elkGroups = new Map<string, ElkNode>();
  for (const g of d.groups) {
    // WHY: The minimum width keeps the corner icon and group label inside the container border.
    const minW = AWS.groupPad * 2 + GROUP_ICON + 8 + textWidth(g.label, AWS.labelFont);
    elkGroups.set(g.id, {
      id: g.id,
      children: [],
      layoutOptions: {
        ...EDGE_SPACING,
        "elk.padding": `[top=${AWS.groupHeader + AWS.groupPad + HEADER_LANE * (lanes.get(g.id) ?? 0)},left=${AWS.groupPad},bottom=${AWS.groupPad},right=${AWS.groupPad}]`,
        "elk.nodeSize.constraints": "MINIMUM_SIZE",
        "elk.nodeSize.minimum": `(${minW},${AWS.groupHeader + AWS.groupPad * 2})`,
      },
    });
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
  const end = (e: AwsDiagramData["edges"][number], which: "from" | "to") => (widths.has(e[which]) ? portId(e.id, which) : e[which]);
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
  const centres: Centres = new Map(Object.entries(first.nodes).map(([id, r]) => [id, { x: r.x + r.w / 2, y: r.y + r.h / 2 }]));
  const sides = facingSides(d, centres);
  const out = await place(d, sides, centres, new Map());
  // WHY: a group whose header several routes cross is laid out again with one lane per extra route.
  const lanes: Lanes = new Map([...out.headerCrossings].filter(([, n]) => n > 1).map(([g, n]) => [g, n - 1]));
  return lanes.size ? place(d, sides, centres, lanes) : out;
}

async function place(d: AwsDiagramData, sides: EdgeSides, centres: Centres | undefined, lanes: Lanes): Promise<DiagramLayout & { headerCrossings: Map<string, number> }> {
  const labelLines = new Map<string, string[]>();
  const result = await elk.layout(buildGraph(d, labelLines, sides, centres, lanes));
  const groupIds = new Set(d.groups.map((g) => g.id));
  const out: DiagramLayout = { width: result.width ?? 0, height: (result.height ?? 0) + AWS.titleH, groups: {}, nodes: {}, edges: {} };

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
  const headers = d.groups.map((g) => groupHeaderRect(out.groups[g.id]!, g.label));
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
