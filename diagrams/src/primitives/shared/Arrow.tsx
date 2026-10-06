import { tokens } from "../../theme/tokens";

/** An SVG arrow drawn from (x1,y1) to (x2,y2); `progress` 0→1 animates the stroke. */
export function Arrow(p: { x1: number; y1: number; x2: number; y2: number; progress: number; label?: string; dashed?: boolean; active?: boolean; id: string }) {
  const len = Math.hypot(p.x2 - p.x1, p.y2 - p.y1);
  const colour = p.active ? tokens.accent : tokens.muted;
  return (
    <g opacity={p.progress > 0 ? 1 : 0}>
      <defs>
        <marker id={`h-${p.id}`} markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill={colour} />
        </marker>
      </defs>
      <line
        x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2} stroke={colour} strokeWidth={p.active ? 3 : 2}
        strokeDasharray={p.dashed ? "8 6" : `${len}`} strokeDashoffset={p.dashed ? 0 : len * (1 - p.progress)}
        markerEnd={p.progress >= 1 ? `url(#h-${p.id})` : undefined}
      />
      {p.label && p.progress >= 1 ? (
        <text x={(p.x1 + p.x2) / 2} y={(p.y1 + p.y2) / 2 - 8} textAnchor="middle" fontFamily={tokens.font} fontSize={14} fill={tokens.ink}
          stroke={tokens.bg} strokeWidth={4} paintOrder="stroke">{p.label}</text>
      ) : null}
    </g>
  );
}
