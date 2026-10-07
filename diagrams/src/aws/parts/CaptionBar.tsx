import { AWS } from "../../theme/aws-style";

// CONTRACT: at most stepPanelHeight(1), so the bar fits the band reserved below the diagram.
const BAR_H = 34;

/** Dark caption bar in the band below the diagram, where the step list appears on the hold. */
export function CaptionBar({ n, caption, top, width }: { n: number; caption: string; top: number; width: number }) {
  return (
    <div style={{ position: "absolute", left: 0, top, width, height: BAR_H, background: "rgba(22,25,31,0.88)",
      color: "#FFFFFF", fontFamily: AWS.font, fontSize: 15, display: "flex", alignItems: "center", padding: "0 20px",
      boxSizing: "border-box", whiteSpace: "nowrap", overflow: "hidden" }}>
      {`${n}. ${caption}`}
    </div>
  );
}
