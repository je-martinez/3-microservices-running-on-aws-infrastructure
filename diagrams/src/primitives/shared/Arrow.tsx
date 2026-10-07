import { tokens } from "../../theme/tokens";

type Anchor = { x: number; y: number; anchor?: "middle" | "end" };

/** The halo'd label of an edge; rendered in its own layer above the nodes. */
export function ArrowLabel({ at, text }: { at: Anchor; text: string }) {
  return (
    <text x={at.x} y={at.y} textAnchor={at.anchor ?? "middle"} fontFamily={tokens.font} fontSize={14} fill={tokens.ink}
      stroke={tokens.bg} strokeWidth={4} paintOrder="stroke">{text}</text>
  );
}

function headMarker(id: string, colour: string) {
  return (
    <defs>
      <marker id={`h-${id}`} markerUnits="userSpaceOnUse" markerWidth="14" markerHeight="14" viewBox="0 0 10 10" refX="9" refY="5" orient="auto">
        <path d="M0,0 L10,5 L0,10 z" fill={colour} />
      </marker>
    </defs>
  );
}

/**
 * An SVG arrow from (x1,y1) to (x2,y2), or along `path`; `progress` 0→1 animates the stroke.
 * `label` is drawn inline (layouts with nodes use ArrowLabel). `halo` underlays a background stroke.
 * `layer` draws one pass ("halo" | "stroke" | "head") so a graph can stack all halos under all heads.
 */
export function Arrow(p: {
  x1?: number; y1?: number; x2?: number; y2?: number; path?: { d: string; len: number }; progress: number;
  label?: string; dashed?: boolean; active?: boolean; halo?: boolean; id: string; layer?: "all" | "halo" | "stroke" | "head";
}) {
  const straight = p.x1 !== undefined && p.y1 !== undefined && p.x2 !== undefined && p.y2 !== undefined;
  const d = p.path ? p.path.d : straight ? `M ${p.x1} ${p.y1} L ${p.x2} ${p.y2}` : "";
  const len = p.path ? p.path.len : straight ? Math.hypot(p.x2! - p.x1!, p.y2! - p.y1!) : 0;
  const colour = p.active ? tokens.accent : tokens.muted;
  const layer = p.layer ?? "all";
  const showHalo = p.halo && (layer === "all" || layer === "halo");
  const showStroke = layer === "all" || layer === "stroke";
  const showHead = layer === "all" || layer === "head";
  const marker = showHead && p.progress >= 1 ? `url(#h-${p.id})` : undefined;
  if (layer === "head") {
    return (
      <g opacity={p.progress > 0 ? 1 : 0}>
        {headMarker(p.id, colour)}
        <path d={d} fill="none" stroke="none" markerEnd={marker} />
      </g>
    );
  }
  return (
    <g opacity={p.progress > 0 ? 1 : 0}>
      {layer === "all" ? headMarker(p.id, colour) : null}
      {showHalo ? (
        <path d={d} fill="none" stroke={tokens.bg} strokeWidth={8} strokeLinejoin="round"
          strokeDasharray={`${len}`} strokeDashoffset={len * (1 - p.progress)} />
      ) : null}
      {showStroke ? (
        <path
          d={d} fill="none" stroke={colour} strokeWidth={p.active ? 3 : 2}
          strokeDasharray={p.dashed ? "8 6" : `${len}`} strokeDashoffset={p.dashed ? 0 : len * (1 - p.progress)}
          markerEnd={layer === "all" ? marker : undefined}
        />
      ) : null}
      {p.label && straight && p.progress >= 1 ? (
        <ArrowLabel at={{ x: (p.x1! + p.x2!) / 2, y: (p.y1! + p.y2!) / 2 - 8 }} text={p.label} />
      ) : null}
    </g>
  );
}
