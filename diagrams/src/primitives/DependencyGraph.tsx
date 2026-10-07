import { AbsoluteFill, useVideoConfig } from "remotion";
import type { DependencyData } from "../schema";
import { tokens } from "../theme/tokens";
import { depPath, layoutDependency } from "./layout";
import { Arrow } from "./shared/Arrow";
import { NodeBox } from "./shared/NodeBox";
import { Title } from "./shared/Title";

type DepPath = { d: string; len: number };

/** CONTRACT: halos, then strokes, then heads; a later arrow's halo must never cover an earlier arrow's head. */
export function DependencyArrows({ paths }: { paths: DepPath[] }) {
  return (
    <>
      {(["halo", "stroke", "head"] as const).map((layer) => (
        <g key={layer} data-layer={layer}>
          {paths.map((path, i) => <Arrow key={i} id={`d${i}`} path={path} progress={1} halo layer={layer} />)}
        </g>
      ))}
    </>
  );
}

export function DependencyGraph({ data }: { data: DependencyData }) {
  const { width, height } = useVideoConfig();
  const l = layoutDependency(data, width, height);
  const rects = Object.values(l.tasks);
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
      {data.tasks.map((t) => <NodeBox key={t.id} {...l.tasks[t.id]!} label={t.label} tag={t.id} kind="compute" />)}
      {/* CONTRACT: arrows render ABOVE the tasks; underneath, a skip-phase arrow vanishes behind an intermediate task and reads as starting there. */}
      <svg width={width} height={height} style={{ position: "absolute", inset: 0 }}>
        <DependencyArrows paths={data.deps.map((e) => depPath(l.tasks[e.from]!, l.tasks[e.to]!, rects))} />
      </svg>
    </AbsoluteFill>
  );
}
