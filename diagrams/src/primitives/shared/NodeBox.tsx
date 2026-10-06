import type { AwsService, NodeKind } from "../../schema";
import { awsIcon } from "../../theme/aws-icons";
import { tokens } from "../../theme/tokens";
import type { Rect } from "../layout";

export function NodeBox(props: Rect & { label: string; kind: NodeKind; aws?: AwsService; opacity?: number; highlight?: boolean }) {
  const c = tokens.kind[props.kind];
  const Icon = props.aws ? awsIcon(props.aws) : null;
  const icon = Math.min(36, props.h - 16);
  return (
    <div
      style={{
        position: "absolute", left: props.x, top: props.y, width: props.w, height: props.h,
        background: c.fill, border: `2px solid ${props.highlight ? tokens.accent : c.stroke}`, borderRadius: 10,
        display: "flex", alignItems: "center", gap: 10, padding: "0 12px", boxSizing: "border-box",
        color: c.text, fontFamily: tokens.font, fontWeight: 600, fontSize: 18, opacity: props.opacity ?? 1,
        boxShadow: props.highlight ? `0 0 0 4px ${tokens.accent}33` : "none",
      }}
    >
      {Icon ? <Icon size={icon} /> : null}
      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{props.label}</span>
    </div>
  );
}
