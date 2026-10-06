import { AbsoluteFill, useVideoConfig } from "remotion";
import type { DependencyData } from "../schema";
import { tokens } from "../theme/tokens";
import { edgePath, isSameColumn, layoutDependency } from "./layout";
import { Arrow } from "./shared/Arrow";
import { NodeBox } from "./shared/NodeBox";
import { Title } from "./shared/Title";

export function DependencyGraph({ data }: { data: DependencyData }) {
  const { width, height } = useVideoConfig();
  const l = layoutDependency(data, width, height);
  return (
    <AbsoluteFill style={{ background: tokens.bg }}>
      <Title title={data.title} />
      {data.phases.map((p) => {
        const r = l.phases[p.id]!;
        return (
          <div key={p.id} style={{ position: "absolute", left: r.x, top: r.y, width: r.w, height: r.h, background: tokens.zoneFill,
            border: `1.5px dashed ${tokens.zoneStroke}`, borderRadius: 14 }}>
            <div style={{ fontFamily: tokens.font, fontSize: 15, fontWeight: 600, color: tokens.muted, padding: "8px 12px" }}>{p.label}</div>
          </div>
        );
      })}
      <svg width={width} height={height} style={{ position: "absolute", inset: 0 }}>
        {data.deps.map((e, i) => <Arrow key={i} id={`d${i}`} path={edgePath(l.tasks[e.from]!, l.tasks[e.to]!, isSameColumn(l.tasks[e.from]!, l.tasks[e.to]!))} progress={1} />)}
      </svg>
      {data.tasks.map((t) => <NodeBox key={t.id} {...l.tasks[t.id]!} label={t.label} tag={t.id} kind="compute" />)}
    </AbsoluteFill>
  );
}
