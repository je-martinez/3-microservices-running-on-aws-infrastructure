import { AbsoluteFill, useCurrentFrame } from "remotion";
import { AWS } from "../theme/aws-style";
import { badgeCentres } from "./badges";
import { placeLabels } from "./labels";
import { CANVAS_PAD, canvasSize, SUBTITLE_PX, TITLE_LINE_H, TITLE_PX } from "./canvas";
import type { DiagramLayout } from "./layout";
import { CaptionBar } from "./parts/CaptionBar";
import { ConnectorHead, ConnectorLabel, ConnectorLine } from "./parts/Connector";
import { GroupFrame, GroupHeader } from "./parts/Group";
import { NodeView } from "./parts/NodeView";
import { StepBadge } from "./parts/StepBadge";
import { StepList } from "./parts/StepList";
import type { AwsDiagramData } from "./schema";
import { activeStep, holdStart } from "./timing";

export type AwsDiagramProps = { data: AwsDiagramData; layout?: DiagramLayout };

function depth(id: string, groups: AwsDiagramData["groups"]): number {
  const g = groups.find((x) => x.id === id);
  return g?.parent ? 1 + depth(g.parent, groups) : 0;
}

// CONTRACT: groups and nodes are static from frame 0; only connector colour, badges and captions change per frame.
export function AwsDiagram({ data, layout }: AwsDiagramProps) {
  const frame = useCurrentFrame();
  if (!layout) throw new Error("AwsDiagram needs the layout computed by calculateMetadata");
  const canvas = canvasSize(data, layout);
  const steps = data.steps;
  const active = activeStep(frame, steps.length);
  const holding = steps.length > 0 && frame >= holdStart(steps.length);
  const lit = new Set(active === undefined ? [] : steps[active]!.edges);
  const shown = holding ? steps.length : active === undefined ? 0 : active + 1;
  // WHY: badges keep off ELK's reserved label spots, so most labels can stay where ELK made room for them.
  const elkLabels = Object.values(layout.edges).flatMap((r) => (r.label ? [r.label] : []));
  const allBadges = badgeCentres(steps, layout.edges, Object.values(layout.groups), Object.values(layout.nodes), elkLabels);
  const labels = placeLabels(data, layout, allBadges);
  const badges = allBadges.slice(0, shown);
  const groups = [...data.groups].sort((a, b) => depth(a.id, data.groups) - depth(b.id, data.groups));
  const svg = { position: "absolute", left: 0, top: 0, overflow: "visible" } as const;
  const below = layout.height + canvas.dy;
  return (
    <AbsoluteFill style={{ background: AWS.canvasBg }}>
      <div style={{ position: "absolute", left: CANVAS_PAD, top: 14, right: CANVAS_PAD, fontFamily: AWS.font, color: AWS.ink }}>
        {canvas.titleLines.map((l, i) => (
          <div key={i} style={{ fontSize: TITLE_PX, fontWeight: 700, lineHeight: `${TITLE_LINE_H}px`, whiteSpace: "nowrap" }}>{l}</div>
        ))}
        {data.subtitle ? <div style={{ fontSize: SUBTITLE_PX, color: AWS.muted, lineHeight: "18px", whiteSpace: "nowrap" }}>{data.subtitle}</div> : null}
      </div>
      <div style={{ position: "absolute", left: canvas.dx, top: canvas.dy, width: layout.width, height: layout.height }}>
        <svg width={layout.width} height={layout.height} style={svg}>
          {groups.map((g) => <GroupFrame key={g.id} kind={g.kind} r={layout.groups[g.id]!} />)}
        </svg>
        {groups.map((g) => <GroupHeader key={g.id} kind={g.kind} label={g.label} r={layout.groups[g.id]!} />)}
        {data.nodes.map((n) => <NodeView key={n.id} n={n} r={layout.nodes[n.id]!} />)}
        <svg width={layout.width} height={layout.height} style={svg}>
          {data.edges.filter((e) => !lit.has(e.id)).map((e) => <ConnectorLine key={e.id} route={layout.edges[e.id]!} async={e.async} active={false} />)}
          {data.edges.filter((e) => lit.has(e.id)).map((e) => <ConnectorLine key={e.id} route={layout.edges[e.id]!} async={e.async} active />)}
          {data.edges.map((e) => <ConnectorHead key={e.id} route={layout.edges[e.id]!} active={lit.has(e.id)} />)}
          {data.edges.map((e) => (e.label && labels[e.id] ? <ConnectorLabel key={e.id} box={labels[e.id]!} text={e.label} /> : null))}
          {badges.map((at, i) => <StepBadge key={i} n={i + 1} at={at} />)}
        </svg>
      </div>
      {active !== undefined ? <CaptionBar n={active + 1} caption={steps[active]!.caption} width={canvas.width} /> : null}
      {holding ? <StepList captions={steps.map((s) => s.caption)} top={below} width={canvas.width} /> : null}
    </AbsoluteFill>
  );
}
