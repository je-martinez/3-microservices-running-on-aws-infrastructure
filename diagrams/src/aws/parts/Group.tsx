import { Img } from "remotion";
import { GROUP_STYLE, AWS } from "../../theme/aws-style";
import { groupIconSrc } from "../../theme/aws-icons";
import { GROUP_LABEL_PX, groupHeader } from "../header";
import type { Rect } from "../layout";
import type { GroupKind } from "../schema";


/** Group frame as an SVG rect; drawn below connectors. */
export function GroupFrame({ kind, r }: { kind: GroupKind; r: Rect }) {
  const s = GROUP_STYLE[kind];
  return (
    <rect x={r.x} y={r.y} width={r.w} height={r.h} fill={s.fill} stroke={s.stroke} strokeWidth={1.5}
      strokeDasharray={s.dashed ? "6 4" : undefined} />
  );
}

/** Corner icon and label of a group, flush with its top-left corner. */
export function GroupHeader({ kind, label, r }: { kind: GroupKind; label: string; r: Rect }) {
  const s = GROUP_STYLE[kind];
  const h = groupHeader(kind, label);
  return (
    <>
      {s.icon ? <Img src={groupIconSrc(s.icon)} style={{ position: "absolute", left: r.x, top: r.y, width: h.iconSize, height: h.iconSize }} /> : null}
      <div style={{ position: "absolute", left: r.x + h.textLeft, top: r.y, height: h.height, display: "flex", alignItems: "center",
        fontFamily: AWS.font, fontSize: GROUP_LABEL_PX, color: AWS.ink, whiteSpace: "nowrap" }}>
        {label}
      </div>
    </>
  );
}
