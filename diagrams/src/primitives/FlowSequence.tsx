import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { FlowData } from "../schema";
import { tokens } from "../theme/tokens";
import { INTRO, STEP, unitProgress } from "../timing";
import { layoutFlow } from "./layout";
import { Arrow } from "./shared/Arrow";
import { Caption } from "./shared/Caption";
import { NodeBox } from "./shared/NodeBox";
import { Title } from "./shared/Title";

/** A step from an actor to itself: a loop that leaves the lifeline, drops and returns, label to its right. */
function SelfLoop(p: { id: string; x: number; y: number; label: string; progress: number; active: boolean }) {
  const colour = p.active ? tokens.accent : tokens.muted;
  const w = 56, drop = 22;
  const d = `M${p.x},${p.y - drop / 2} H${p.x + w} V${p.y + drop / 2} H${p.x + 2}`;
  const len = 2 * w + drop;
  return (
    <g opacity={p.progress > 0 ? 1 : 0}>
      <defs>
        <marker id={`h-${p.id}`} markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill={colour} />
        </marker>
      </defs>
      <path d={d} fill="none" stroke={colour} strokeWidth={p.active ? 3 : 2} strokeDasharray={len} strokeDashoffset={len * (1 - p.progress)}
        markerEnd={p.progress >= 1 ? `url(#h-${p.id})` : undefined} />
      {p.progress >= 1 ? (
        <text x={p.x + w + 10} y={p.y + 5} fontFamily={tokens.font} fontSize={14} fill={tokens.ink}>{p.label}</text>
      ) : null}
    </g>
  );
}

export function FlowSequence({ data }: { data: FlowData }) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const l = layoutFlow(data, width, height);
  const current = Math.min(data.steps.length - 1, Math.max(0, Math.floor((frame - INTRO) / STEP)));
  const bottom = height - 18 - 48 - 16;

  return (
    <AbsoluteFill style={{ background: tokens.bg }}>
      <Title title={data.title} subtitle={data.subtitle} />
      <svg width={width} height={height} style={{ position: "absolute", inset: 0 }}>
        {data.actors.map((a) => {
          const lane = l.lanes[a.id]!;
          return <line key={a.id} x1={lane.x} y1={lane.header.y + lane.header.h} x2={lane.x} y2={bottom} stroke={tokens.zoneStroke} strokeWidth={2} strokeDasharray="4 6" />;
        })}
        {data.steps.map((s, i) => {
          const y = l.rowY(i), from = l.lanes[s.from]!.x, to = l.lanes[s.to]!.x;
          const self = s.from === s.to;
          const active = i === current && frame >= INTRO;
          const label = `${i + 1}. ${s.label}`;
          return self ? (
            <SelfLoop key={i} id={`s${i}`} x={from} y={y} label={label} progress={unitProgress(frame, i)} active={active} />
          ) : (
            <Arrow key={i} id={`s${i}`} x1={from} y1={y} x2={to} y2={y} label={label} dashed={s.async}
              progress={unitProgress(frame, i)} active={active} />
          );
        })}
      </svg>
      {data.actors.map((a) => (
        <NodeBox key={a.id} {...l.lanes[a.id]!.header} label={a.label} kind={a.kind} aws={a.aws}
          highlight={frame >= INTRO && (data.steps[current]!.from === a.id || data.steps[current]!.to === a.id)} />
      ))}
      {frame >= INTRO ? <Caption n={current + 1} text={data.steps[current]!.caption} /> : null}
    </AbsoluteFill>
  );
}
