import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkExtendedEdge, ElkLabel, ElkNode } from "elkjs/lib/elk-api";
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
const LINE_H = 16;

const elk = new ELK();

const ROOT_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.spacing.nodeNodeBetweenLayers": "70",
  "elk.spacing.nodeNode": "40",
  "elk.spacing.edgeLabel": "6",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.padding": "[top=20,left=20,bottom=20,right=20]",
};

function nodeBox(n: AwsDiagramData["nodes"][number]): { w: number; h: number; labelLines: string[] } {
  if (n.icon === "task") return { w: AWS.taskW, h: AWS.taskH, labelLines: wrap(n.label, AWS.labelFont, AWS.taskW - 16, 2) };
  const maxW = Math.max(110, AWS.iconSize + 60);
  const labelLines = wrap(n.label, AWS.labelFont, maxW, 2);
  const lineWidths = labelLines.map((l) => textWidth(l, AWS.labelFont));
  if (n.sublabel) lineWidths.push(Math.min(maxW, textWidth(n.sublabel, AWS.edgeLabelFont)));
  const w = Math.max(AWS.iconSize + 24, Math.max(0, ...lineWidths) + 8);
  const h = AWS.iconSize + 6 + labelLines.length * LINE_H + (n.sublabel ? LINE_H : 0);
  return { w, h, labelLines };
}

function buildGraph(d: AwsDiagramData, labelLines: Map<string, string[]>): ElkNode {
  const root: ElkNode = { id: ROOT, layoutOptions: { ...ROOT_OPTIONS, "elk.direction": d.direction }, children: [], edges: [] };
  const elkGroups = new Map<string, ElkNode>();
  for (const g of d.groups) {
    // WHY: The minimum width keeps the corner icon and group label inside the container border.
    const minW = AWS.groupPad * 2 + GROUP_ICON + 8 + textWidth(g.label, AWS.labelFont);
    elkGroups.set(g.id, {
      id: g.id,
      children: [],
      layoutOptions: {
        "elk.padding": `[top=${AWS.groupHeader + AWS.groupPad},left=${AWS.groupPad},bottom=${AWS.groupPad},right=${AWS.groupPad}]`,
        "elk.nodeSize.constraints": "MINIMUM_SIZE",
        "elk.nodeSize.minimum": `(${minW},${AWS.groupHeader + AWS.groupPad * 2})`,
      },
    });
  }
  const childrenOf = (parent: string | undefined) => (parent ? elkGroups.get(parent)! : root).children!;
  for (const g of d.groups) childrenOf(g.parent).push(elkGroups.get(g.id)!);
  for (const n of d.nodes) {
    const box = nodeBox(n);
    labelLines.set(n.id, box.labelLines);
    childrenOf(n.group).push({ id: n.id, width: box.w, height: box.h });
  }
  for (const e of d.edges) {
    const labels: ElkLabel[] = e.label
      ? [{ id: `${e.id}__label`, text: e.label, width: textWidth(e.label, AWS.edgeLabelFont) + 8, height: LINE_H, layoutOptions: { "elk.edgeLabels.placement": "CENTER" } }]
      : [];
    root.edges!.push({ id: e.id, sources: [e.from], targets: [e.to], labels });
  }
  return root;
}

export async function layoutDiagram(d: AwsDiagramData): Promise<DiagramLayout> {
  const labelLines = new Map<string, string[]>();
  const result = await elk.layout(buildGraph(d, labelLines));
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
    const shift = (p: Point) => ({ x: base.x + p.x, y: base.y + p.y });
    const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map(shift);
    const l = e.labels?.[0];
    out.edges[e.id] = l ? { points, label: { ...shift({ x: l.x ?? 0, y: l.y ?? 0 }), w: l.width ?? 0, h: l.height ?? 0 } } : { points };
  }
  return out;
}
