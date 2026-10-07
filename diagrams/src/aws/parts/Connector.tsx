import { AWS } from "../../theme/aws-style";
import type { DiagramLayout, Point, Rect } from "../layout";

const HEAD = 8;

type Route = DiagramLayout["edges"][string];

/** Orthogonal connector line; its arrowhead is a separate layer so no later stroke covers it. */
export function ConnectorLine({ route, async, active }: { route: Route; async?: boolean; active: boolean }) {
  return (
    <polyline points={route.points.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={active ? AWS.accent : AWS.edge}
      strokeWidth={active ? 2.5 : 1.5} strokeDasharray={async ? "6 4" : undefined} strokeLinejoin="miter" />
  );
}

/** Small open arrowhead at the route's end, pointing along its last segment. */
export function ConnectorHead({ route, active }: { route: Route; active: boolean }) {
  const pts = route.points;
  const tip = pts[pts.length - 1]!;
  const prev = pts[pts.length - 2] ?? tip;
  const len = Math.hypot(tip.x - prev.x, tip.y - prev.y) || 1;
  const ux = (tip.x - prev.x) / len, uy = (tip.y - prev.y) / len;
  const at = (back: number, side: number): Point => ({ x: tip.x - ux * back - uy * side, y: tip.y - uy * back + ux * side });
  const [a, b] = [at(HEAD, HEAD / 2), at(HEAD, -HEAD / 2)];
  return (
    <polyline points={`${a.x},${a.y} ${tip.x},${tip.y} ${b.x},${b.y}`} fill="none" stroke={active ? AWS.accent : AWS.edge}
      strokeWidth={active ? 2.5 : 1.5} strokeLinejoin="miter" strokeLinecap="round" />
  );
}

/** Edge label centred in its placed box, haloed so a crossing line stays readable. */
export function ConnectorLabel({ box, text }: { box: Rect; text: string }) {
  return (
    <text x={box.x + box.w / 2} y={box.y + box.h / 2} textAnchor="middle" dominantBaseline="central" fontFamily={AWS.font}
      fontSize={AWS.edgeLabelFont} fill={AWS.ink} stroke={AWS.canvasBg} strokeWidth={4} paintOrder="stroke" strokeLinejoin="round">
      {text}
    </text>
  );
}
