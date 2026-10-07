import { AWS } from "../../theme/aws-style";
import type { Point } from "../layout";

export const BADGE = 22;

/** Rounded blue square with a white step number, centred on `at`. */
export function StepBadge({ n, at, size = BADGE }: { n: number; at: Point; size?: number }) {
  return (
    <g>
      <rect x={at.x - size / 2} y={at.y - size / 2} width={size} height={size} rx={4} fill={AWS.badge} />
      <text x={at.x} y={at.y} textAnchor="middle" dominantBaseline="central" fontFamily={AWS.font} fontWeight={700}
        fontSize={13} fill="#FFFFFF">{n}</text>
    </g>
  );
}

const OFFSET = 26;

/** Badge centre on the longest segment of a route, shifted `nth` × 26px along it for repeated edges. */
export function badgePoint(points: Point[], nth: number): Point {
  let best = { a: points[0]!, b: points[1] ?? points[0]!, len: -1 };
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1]!, points[i]!];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > best.len) best = { a, b, len };
  }
  const len = best.len || 1;
  const t = Math.min(len, Math.max(0, len / 2 + nth * OFFSET)) / len;
  return { x: best.a.x + (best.b.x - best.a.x) * t, y: best.a.y + (best.b.y - best.a.y) * t };
}
