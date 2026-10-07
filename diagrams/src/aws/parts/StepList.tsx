import { AWS } from "../../theme/aws-style";

const BADGE = 18;

/** Numbered step list drawn below the diagram so the last frame stands alone. */
export function StepList({ captions, top, width }: { captions: string[]; top: number; width: number }) {
  return (
    <div style={{ position: "absolute", left: 0, top, width, padding: "8px 20px", boxSizing: "border-box", fontFamily: AWS.font }}>
      {captions.map((c, i) => (
        <div key={i} style={{ height: AWS.stepRowH, display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: AWS.ink }}>
          <div style={{ width: BADGE, height: BADGE, borderRadius: 4, background: AWS.badge, color: "#FFFFFF", fontWeight: 700,
            fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{i + 1}</div>
          <div style={{ whiteSpace: "nowrap" }}>{c}</div>
        </div>
      ))}
    </div>
  );
}
