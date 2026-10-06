import type { NodeKind } from "../../schema";
import { tokens } from "../../theme/tokens";

/** Each kind present, once, in tokens.kind order, so every legend lists kinds in the same sequence. */
export function legendKinds(kinds: NodeKind[]): NodeKind[] {
  const present = new Set(kinds);
  return (Object.keys(tokens.kind) as NodeKind[]).filter((k) => present.has(k));
}

export function Legend({ kinds }: { kinds: NodeKind[] }) {
  return (
    <div style={{ position: "absolute", right: 24, top: 24, display: "flex", gap: 12, fontFamily: tokens.font, fontSize: 14, color: tokens.ink }}>
      {legendKinds(kinds).map((k) => (
        <span key={k} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 14, height: 14, borderRadius: 4, background: tokens.kind[k].fill, border: `2px solid ${tokens.kind[k].stroke}` }} />
          {k}
        </span>
      ))}
    </div>
  );
}
