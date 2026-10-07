import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { ArchitectureData } from "../schema";
import { tokens } from "../theme/tokens";
import { ARCH_STEP, unitProgress } from "../timing";
import { activeIndex, edgePath, isSameColumn, layoutArchitecture } from "./layout";
import { Arrow, ArrowLabel } from "./shared/Arrow";
import { Legend } from "./shared/Legend";
import { NodeBox } from "./shared/NodeBox";
import { Title } from "./shared/Title";

export function ArchitectureMap({ data }: { data: ArchitectureData }) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const l = layoutArchitecture(data, width, height);
  const current = activeIndex(frame, data.edges.length, ARCH_STEP);
  const active = current === undefined ? undefined : data.edges[current];
  const paths = data.edges.map((e) => {
    const a = l.nodes[e.from]!, b = l.nodes[e.to]!;
    return edgePath(a, b, isSameColumn(a, b));
  });

  return (
    <AbsoluteFill style={{ background: tokens.bg }}>
      <Title title={data.title} subtitle={data.subtitle} />
      <Legend kinds={data.nodes.map((n) => n.kind)} />
      {data.zones.map((z) => {
        const r = l.zones[z.id]!;
        return (
          <div key={z.id} style={{ position: "absolute", left: r.x, top: r.y, width: r.w, height: r.h,
            background: tokens.zoneFill, border: `1.5px dashed ${tokens.zoneStroke}`, borderRadius: 14 }}>
            <div style={{ fontFamily: tokens.font, fontSize: 15, fontWeight: 600, color: tokens.muted, padding: "8px 12px" }}>{z.label}</div>
          </div>
        );
      })}
      <svg width={width} height={height} style={{ position: "absolute", inset: 0 }}>
        {data.edges.map((e, i) => (
          <Arrow key={i} id={`a${i}`} path={paths[i]!} progress={unitProgress(frame, i, ARCH_STEP)} active={e === active} />
        ))}
      </svg>
      {data.nodes.map((n) => (
        <NodeBox key={n.id} {...l.nodes[n.id]!} label={n.label} kind={n.kind} aws={n.aws}
          highlight={active !== undefined && (active.from === n.id || active.to === n.id)} />
      ))}
      <svg width={width} height={height} style={{ position: "absolute", inset: 0 }}>
        {data.edges.map((e, i) =>
          e.label && unitProgress(frame, i, ARCH_STEP) >= 1 ? <ArrowLabel key={i} at={paths[i]!.label} text={e.label} /> : null,
        )}
      </svg>
    </AbsoluteFill>
  );
}
