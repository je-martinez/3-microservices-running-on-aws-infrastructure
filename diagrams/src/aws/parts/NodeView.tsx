import { Img } from "remotion";
import { AWS } from "../../theme/aws-style";
import { awsIcon, genericIconSrc } from "../../theme/aws-icons";
import type { DiagramLayout } from "../layout";
import { GenericIcon, type AwsDiagramData } from "../schema";

const LINE_H = 16;
const TASK_BORDER = "#7D8998";

type Node = AwsDiagramData["nodes"][number];
type Box = DiagramLayout["nodes"][string];

function TaskCard({ n, r }: { n: Node; r: Box }) {
  return (
    <div style={{ position: "absolute", left: r.x, top: r.y, width: r.w, height: r.h, boxSizing: "border-box", background: AWS.canvasBg,
      border: `1.5px solid ${TASK_BORDER}`, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center",
      fontFamily: AWS.font, color: AWS.ink, textAlign: "center" }}>
      <div style={{ fontSize: 12, fontWeight: 700, lineHeight: `${LINE_H}px` }}>{n.id}</div>
      {r.labelLines.map((l, i) => <div key={i} style={{ fontSize: AWS.labelFont, lineHeight: `${LINE_H}px` }}>{l}</div>)}
    </div>
  );
}

/** A service, generic resource or task node: icon on top, label lines centred below. */
export function NodeView({ n, r }: { n: Node; r: Box }) {
  if (n.icon === "task") return <TaskCard n={n} r={r} />;
  const size = AWS.iconSize;
  const iconLeft = r.x + (r.w - size) / 2;
  const generic = GenericIcon.safeParse(n.icon);
  const Service = generic.success ? undefined : awsIcon(n.icon as Exclude<Node["icon"], GenericIcon | "task">);
  return (
    <>
      {generic.success
        ? <Img src={genericIconSrc(generic.data)} style={{ position: "absolute", left: iconLeft, top: r.y, width: size, height: size }} />
        : <div style={{ position: "absolute", left: iconLeft, top: r.y, width: size, height: size }}>{Service ? <Service size={size} /> : null}</div>}
      <div style={{ position: "absolute", left: r.x - 20, top: r.y + size + 6, width: r.w + 40, textAlign: "center",
        fontFamily: AWS.font, color: AWS.ink, fontSize: AWS.labelFont, lineHeight: `${LINE_H}px` }}>
        {r.labelLines.map((l, i) => <div key={i} style={{ whiteSpace: "nowrap" }}>{l}</div>)}
        {n.sublabel ? <div style={{ fontStyle: "italic", fontSize: AWS.edgeLabelFont, color: AWS.muted, whiteSpace: "nowrap" }}>{n.sublabel}</div> : null}
      </div>
    </>
  );
}
