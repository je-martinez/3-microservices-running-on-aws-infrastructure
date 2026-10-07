import { loadFont } from "@remotion/google-fonts/Arimo";
import type { GroupKind } from "../aws/schema";

const { fontFamily } = loadFont("normal", { weights: ["400"], subsets: ["latin"] });

export const AWS = {
  font: fontFamily,
  canvasBg: "#FFFFFF",
  ink: "#16191F",
  muted: "#545B64",
  edge: "#16191F",
  accent: "#147EB4",
  badge: "#147EB4",
  iconSize: 48,
  taskW: 150,
  taskH: 54,
  groupPad: 20,
  groupHeader: 34,
  labelFont: 13,
  edgeLabelFont: 12,
  titleH: 64,
  stepRowH: 22,
} as const;

export type GroupIcon = "aws-cloud" | "region" | "vpc" | "public-subnet" | "private-subnet" | "account" | "corporate" | "server";

// CONTRACT: Colours follow the AWS Architecture Icons group guidelines; renderers read them from here only.
export const GROUP_STYLE: Record<GroupKind, { stroke: string; fill: string; dashed: boolean; icon?: GroupIcon }> = {
  "aws-cloud": { stroke: "#242F3E", fill: "none", dashed: false, icon: "aws-cloud" },
  region: { stroke: "#00A4A6", fill: "none", dashed: true, icon: "region" },
  az: { stroke: "#00A4A6", fill: "none", dashed: true },
  vpc: { stroke: "#8C4FFF", fill: "none", dashed: false, icon: "vpc" },
  "public-subnet": { stroke: "#7AA116", fill: "#F2F6E8", dashed: false, icon: "public-subnet" },
  "private-subnet": { stroke: "#00A4A6", fill: "#E6F6F7", dashed: false, icon: "private-subnet" },
  account: { stroke: "#E7157B", fill: "none", dashed: false, icon: "account" },
  generic: { stroke: "#7D8998", fill: "none", dashed: true },
  corporate: { stroke: "#7D8998", fill: "none", dashed: false, icon: "corporate" },
  "local-floci": { stroke: "#7D8998", fill: "none", dashed: false, icon: "server" },
  phase: { stroke: "#7D8998", fill: "#FAFAFA", dashed: true },
};
