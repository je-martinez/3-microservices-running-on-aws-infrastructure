import { AbsoluteFill, useCurrentFrame } from "remotion";
import { AWS } from "../theme/aws-style";
import type { DiagramLayout, Point, Rect } from "./layout";
import { CaptionBar } from "./parts/CaptionBar";
import { ConnectorHead, ConnectorLabel, ConnectorLine } from "./parts/Connector";
import { GroupFrame, GroupHeader } from "./parts/Group";
import { NodeView } from "./parts/NodeView";
import { badgePoint, StepBadge } from "./parts/StepBadge";
import { StepList } from "./parts/StepList";
import type { AwsDiagramData } from "./schema";
import { activeStep, holdStart } from "./timing";

export type AwsDiagramProps = { data: AwsDiagramData; layout?: DiagramLayout };

function depth(id: string, groups: AwsDiagramData["groups"]): number {
  const g = groups.find((x) => x.id === id);
  return g?.parent ? 1 + depth(g.parent, groups) : 0;
}

/** Moves a route end lying on the side of an icon node's box onto the icon itself, so the line touches the icon. */
function snapEnd(end: Point, next: Point, n: AwsDiagramData["nodes"][number], r: Rect): Point {
  if (n.icon === "task" || Math.abs(end.y - next.y) > 0.5 || end.y < r.y || end.y > r.y + AWS.iconSize) return end;
  const left = r.x + (r.w - AWS.iconSize) / 2;
  if (Math.abs(end.x - r.x) < 1) return { x: left, y: end.y };
  if (Math.abs(end.x - (r.x + r.w)) < 1) return { x: left + AWS.iconSize, y: end.y };
  return end;
}

function routes(data: AwsDiagramData, layout: DiagramLayout): DiagramLayout["edges"] {
  const nodes = new Map(data.nodes.map((n) => [n.id, n]));
  const out: DiagramLayout["edges"] = {};
  for (const e of data.edges) {
    const route = layout.edges[e.id]!;
    const pts = [...route.points];
    const last = pts.length - 1;
    pts[0] = snapEnd(pts[0]!, pts[1]!, nodes.get(e.from)!, layout.nodes[e.from]!);
    pts[last] = snapEnd(pts[last]!, pts[last - 1]!, nodes.get(e.to)!, layout.nodes[e.to]!);
    out[e.id] = { ...route, points: pts };
  }
  return out;
}

/** Badge centre per step: on its first edge, nudged along the edge when an earlier step shares it. */
function badgeCentres(data: AwsDiagramData, edges: DiagramLayout["edges"]): Point[] {
  const used = new Map<string, number>();
  return data.steps.map((s) => {
    const id = s.edges[0]!;
    const nth = used.get(id) ?? 0;
    used.set(id, nth + 1);
    return badgePoint(edges[id]!.points, nth);
  });
}

// CONTRACT: groups and nodes are static from frame 0; only connector colour, badges and captions change per frame.
export function AwsDiagram({ data, layout }: AwsDiagramProps) {
  const frame = useCurrentFrame();
  if (!layout) throw new Error("AwsDiagram needs the layout computed by calculateMetadata");
  const steps = data.steps;
  const active = activeStep(frame, steps.length);
  const holding = steps.length > 0 && frame >= holdStart(steps.length);
  const lit = new Set(active === undefined ? [] : steps[active]!.edges);
  const shown = holding ? steps.length : active === undefined ? 0 : active + 1;
  const edges = routes(data, layout);
  const badges = badgeCentres(data, edges).slice(0, shown);
  const groups = [...data.groups].sort((a, b) => depth(a.id, data.groups) - depth(b.id, data.groups));
  const svg = { position: "absolute", left: 0, top: 0, overflow: "visible" } as const;
  return (
    <AbsoluteFill style={{ background: AWS.canvasBg }}>
      <div style={{ position: "absolute", left: 20, top: 14, fontFamily: AWS.font, color: AWS.ink }}>
        <div style={{ fontSize: 22, fontWeight: 700, lineHeight: "28px" }}>{data.title}</div>
        {data.subtitle ? <div style={{ fontSize: 14, color: AWS.muted, lineHeight: "18px" }}>{data.subtitle}</div> : null}
      </div>
      <svg width={layout.width} height={layout.height} style={svg}>
        {groups.map((g) => <GroupFrame key={g.id} kind={g.kind} r={layout.groups[g.id]!} />)}
      </svg>
      {groups.map((g) => <GroupHeader key={g.id} kind={g.kind} label={g.label} r={layout.groups[g.id]!} />)}
      {data.nodes.map((n) => <NodeView key={n.id} n={n} r={layout.nodes[n.id]!} />)}
      <svg width={layout.width} height={layout.height} style={svg}>
        {data.edges.filter((e) => !lit.has(e.id)).map((e) => <ConnectorLine key={e.id} route={edges[e.id]!} async={e.async} active={false} />)}
        {data.edges.filter((e) => lit.has(e.id)).map((e) => <ConnectorLine key={e.id} route={edges[e.id]!} async={e.async} active />)}
        {data.edges.map((e) => <ConnectorHead key={e.id} route={edges[e.id]!} active={lit.has(e.id)} />)}
        {data.edges.map((e) => (e.label ? <ConnectorLabel key={e.id} route={edges[e.id]!} text={e.label} /> : null))}
        {badges.map((at, i) => <StepBadge key={i} n={i + 1} at={at} />)}
      </svg>
      {active !== undefined ? <CaptionBar n={active + 1} caption={steps[active]!.caption} top={layout.height} width={layout.width} /> : null}
      {holding ? <StepList captions={steps.map((s) => s.caption)} top={layout.height} width={layout.width} /> : null}
    </AbsoluteFill>
  );
}
