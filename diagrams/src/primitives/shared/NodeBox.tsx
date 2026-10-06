import type { AwsService, NodeKind } from "../../schema";
import { awsIcon } from "../../theme/aws-icons";
import { tokens } from "../../theme/tokens";
import { fitLabel, ICON_MIN_W, type Rect } from "../layout";

export function NodeBox(props: Rect & { label: string; kind: NodeKind; aws?: AwsService; opacity?: number; highlight?: boolean }) {
  const c = tokens.kind[props.kind];
  const Icon = props.aws && props.w >= ICON_MIN_W ? awsIcon(props.aws) : null;
  const fit = fitLabel(props.label, props.w, props.h, Icon !== null);
  return (
    <div
      style={{
        position: "absolute", left: props.x, top: props.y, width: props.w, height: props.h,
        background: c.fill, border: `2px solid ${props.highlight ? tokens.accent : c.stroke}`, borderRadius: 10,
        display: "flex", alignItems: "center", gap: 10, padding: `0 ${fit.pad}px`, boxSizing: "border-box",
        color: c.text, fontFamily: tokens.font, fontWeight: 600, fontSize: fit.size, lineHeight: 1.1, opacity: props.opacity ?? 1,
        boxShadow: props.highlight ? `0 0 0 4px ${tokens.accent}33` : "none",
      }}
    >
      {Icon ? <span style={{ flex: "none", display: "flex" }}><Icon size={fit.icon} /></span> : null}
      <span style={{ minWidth: 0, overflowWrap: "anywhere", display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: fit.lines, overflow: "hidden" }}>
        {props.label}
      </span>
    </div>
  );
}
