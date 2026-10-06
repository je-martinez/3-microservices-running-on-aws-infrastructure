import type { NodeKind } from "../../schema";
import { tokens } from "../../theme/tokens";

export function Legend({ kinds }: { kinds: NodeKind[] }) {
  return (
    <div style={{ position: "absolute", right: 24, top: 24, display: "flex", gap: 12, fontFamily: tokens.font, fontSize: 14, color: tokens.ink }}>
      {[...new Set(kinds)].map((k) => (
        <span key={k} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 14, height: 14, borderRadius: 4, background: tokens.kind[k].fill, border: `2px solid ${tokens.kind[k].stroke}` }} />
          {k}
        </span>
      ))}
    </div>
  );
}
