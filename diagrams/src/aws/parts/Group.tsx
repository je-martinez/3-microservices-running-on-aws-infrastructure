import { Img } from "remotion";
import { GROUP_STYLE, AWS } from "../../theme/aws-style";
import { groupIconSrc } from "../../theme/aws-icons";
import type { Rect } from "../layout";
import type { GroupKind } from "../schema";

const ICON = 32;

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
  const left = s.icon ? ICON + 8 : 10;
  return (
    <>
      {s.icon ? <Img src={groupIconSrc(s.icon)} style={{ position: "absolute", left: r.x, top: r.y, width: ICON, height: ICON }} /> : null}
      <div style={{ position: "absolute", left: r.x + left, top: r.y, height: ICON, display: "flex", alignItems: "center",
        fontFamily: AWS.font, fontSize: 14, color: AWS.ink, whiteSpace: "nowrap" }}>
        {label}
      </div>
    </>
  );
}
