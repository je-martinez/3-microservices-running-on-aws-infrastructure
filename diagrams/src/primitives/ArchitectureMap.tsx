import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { ArchitectureData } from "../schema";
import { tokens } from "../theme/tokens";
import { INTRO, STEP, unitProgress } from "../timing";
import { edgePoints, layoutArchitecture } from "./layout";
import { Arrow } from "./shared/Arrow";
import { Legend } from "./shared/Legend";
import { NodeBox } from "./shared/NodeBox";
import { Title } from "./shared/Title";

export function ArchitectureMap({ data }: { data: ArchitectureData }) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const l = layoutArchitecture(data, width, height);
  const fade = interpolate(frame, [0, INTRO], [0, 1], { extrapolateRight: "clamp" });
  const current = Math.floor((frame - INTRO) / STEP);
  const active = current >= 0 && current < data.edges.length ? data.edges[current] : undefined;

  return (
    <AbsoluteFill style={{ background: tokens.bg }}>
      <Title title={data.title} subtitle={data.subtitle} />
      <Legend kinds={data.nodes.map((n) => n.kind)} />
      {data.zones.map((z) => {
        const r = l.zones[z.id]!;
        return (
          <div key={z.id} style={{ position: "absolute", left: r.x, top: r.y, width: r.w, height: r.h, opacity: fade,
            background: tokens.zoneFill, border: `1.5px dashed ${tokens.zoneStroke}`, borderRadius: 14 }}>
            <div style={{ fontFamily: tokens.font, fontSize: 15, fontWeight: 600, color: tokens.muted, padding: "8px 12px" }}>{z.label}</div>
          </div>
        );
      })}
      <svg width={width} height={height} style={{ position: "absolute", inset: 0 }}>
        {data.edges.map((e, i) => (
          <Arrow key={i} id={`a${i}`} {...edgePoints(l.nodes[e.from]!, l.nodes[e.to]!)} label={e.label}
            progress={unitProgress(frame, i)} active={e === active} />
        ))}
      </svg>
      {data.nodes.map((n) => (
        <NodeBox key={n.id} {...l.nodes[n.id]!} label={n.label} kind={n.kind} aws={n.aws} opacity={fade}
          highlight={active !== undefined && (active.from === n.id || active.to === n.id)} />
      ))}
    </AbsoluteFill>
  );
}
