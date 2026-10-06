import { tokens } from "../../theme/tokens";

export function Title({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div style={{ position: "absolute", left: 24, top: 18, fontFamily: tokens.font, color: tokens.ink }}>
      <div style={{ fontSize: 30, fontWeight: 700 }}>{title}</div>
      {subtitle ? <div style={{ fontSize: 17, color: tokens.muted, marginTop: 4 }}>{subtitle}</div> : null}
    </div>
  );
}
