import { tokens } from "../../theme/tokens";

type Anchor = { x: number; y: number; anchor?: "middle" | "end" };

/** The halo'd label of an edge; rendered in its own layer above the nodes. */
export function ArrowLabel({ at, text }: { at: Anchor; text: string }) {
  return (
    <text x={at.x} y={at.y} textAnchor={at.anchor ?? "middle"} fontFamily={tokens.font} fontSize={14} fill={tokens.ink}
      stroke={tokens.bg} strokeWidth={4} paintOrder="stroke">{text}</text>
  );
}

/**
 * An SVG arrow from (x1,y1) to (x2,y2), or along `path` when given; `progress` 0→1 animates the stroke.
 * A `label` passed here is drawn inline; layouts with nodes draw it through ArrowLabel instead.
 */
export function Arrow(p: {
  x1?: number; y1?: number; x2?: number; y2?: number; path?: { d: string; len: number }; progress: number;
  label?: string; dashed?: boolean; active?: boolean; id: string;
}) {
  const straight = p.x1 !== undefined && p.y1 !== undefined && p.x2 !== undefined && p.y2 !== undefined;
  const d = p.path ? p.path.d : straight ? `M ${p.x1} ${p.y1} L ${p.x2} ${p.y2}` : "";
  const len = p.path ? p.path.len : straight ? Math.hypot(p.x2! - p.x1!, p.y2! - p.y1!) : 0;
  const colour = p.active ? tokens.accent : tokens.muted;
  return (
    <g opacity={p.progress > 0 ? 1 : 0}>
      <defs>
        <marker id={`h-${p.id}`} markerUnits="userSpaceOnUse" markerWidth="14" markerHeight="14" viewBox="0 0 10 10" refX="9" refY="5" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill={colour} />
        </marker>
      </defs>
      <path
        d={d} fill="none" stroke={colour} strokeWidth={p.active ? 3 : 2}
        strokeDasharray={p.dashed ? "8 6" : `${len}`} strokeDashoffset={p.dashed ? 0 : len * (1 - p.progress)}
        markerEnd={p.progress >= 1 ? `url(#h-${p.id})` : undefined}
      />
      {p.label && straight && p.progress >= 1 ? (
        <ArrowLabel at={{ x: (p.x1! + p.x2!) / 2, y: (p.y1! + p.y2!) / 2 - 8 }} text={p.label} />
      ) : null}
    </g>
  );
}
