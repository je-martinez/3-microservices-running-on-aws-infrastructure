import { tokens } from "../../theme/tokens";

/** The one-line caption bar at the bottom of a flow. */
export function Caption({ n, text }: { n: number; text: string }) {
  return (
    <div style={{ position: "absolute", left: 24, right: 24, bottom: 18, height: 48, borderRadius: 10, background: tokens.ink,
      color: "#FFFFFF", fontFamily: tokens.font, fontSize: 20, display: "flex", alignItems: "center", gap: 14, padding: "0 16px" }}>
      <span style={{ background: tokens.accent, borderRadius: 999, width: 30, height: 30, display: "grid", placeItems: "center", fontWeight: 700 }}>{n}</span>
      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{text}</span>
    </div>
  );
}
