import { AWS, LANE_STYLE } from "../../theme/aws-style";
import type { Lane } from "../layout";

/** A vpc's Availability Zone columns: subnet fill under a dashed AZ outline; drawn after the vpc frame, before its contents. */
export function LaneFrames({ lanes }: { lanes: Lane[] }) {
  return (
    <>
      {lanes.map((l, i) => (
        <rect key={i} x={l.rect.x} y={l.rect.y} width={l.rect.w} height={l.rect.h} fill={LANE_STYLE.fill}
          stroke={LANE_STYLE.stroke} strokeWidth={1.5} strokeDasharray={LANE_STYLE.dashed ? "6 4" : undefined} />
      ))}
    </>
  );
}

/** The AZ label and its subnet sublabel in each lane's top-left corner. */
export function LaneHeaders({ lanes }: { lanes: Lane[] }) {
  return (
    <>
      {lanes.map((l, i) => (
        <div key={i} style={{ position: "absolute", left: l.header.x + 6, top: l.header.y + 4, fontFamily: AWS.font, whiteSpace: "nowrap" }}>
          <div style={{ fontSize: LANE_STYLE.labelFont, color: LANE_STYLE.stroke, lineHeight: "16px" }}>{l.label}</div>
          {l.sublabel ? <div style={{ fontSize: LANE_STYLE.sublabelFont, color: AWS.muted, lineHeight: "16px" }}>{l.sublabel}</div> : null}
        </div>
      ))}
    </>
  );
}
