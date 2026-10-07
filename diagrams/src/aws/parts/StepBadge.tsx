import { AWS } from "../../theme/aws-style";
import { BADGE } from "../badges";
import type { Point } from "../layout";

/** Rounded blue square with a white step number, centred on `at`. */
export function StepBadge({ n, at }: { n: number; at: Point }) {
  return (
    <g>
      <rect x={at.x - BADGE / 2} y={at.y - BADGE / 2} width={BADGE} height={BADGE} rx={4} fill={AWS.badge} />
      <text x={at.x} y={at.y} textAnchor="middle" dominantBaseline="central" fontFamily={AWS.font} fontWeight={700}
        fontSize={13} fill="#FFFFFF">{n}</text>
    </g>
  );
}
