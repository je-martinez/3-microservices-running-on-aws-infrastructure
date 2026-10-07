import { loadFont } from "@remotion/google-fonts/Inter";
import type { NodeKind } from "../schema";

const { fontFamily } = loadFont("normal", { weights: ["400", "600", "700"], subsets: ["latin"] });

export const tokens = {
  font: fontFamily,
  bg: "#F8FAFC",
  ink: "#0F172A",
  muted: "#64748B",
  accent: "#E8590C",
  zoneFill: "#EEF2F7",
  zoneStroke: "#CBD5E1",
  kind: {
    compute: { fill: "#FFE8CC", stroke: "#E8590C", text: "#5C2400" },
    data: { fill: "#D3F9D8", stroke: "#2F9E44", text: "#0B3D17" },
    messaging: { fill: "#F3D9FA", stroke: "#AE3EC9", text: "#3D0B4A" },
    edge: { fill: "#D0EBFF", stroke: "#1C7ED6", text: "#0B2E57" },
    external: { fill: "#E9ECEF", stroke: "#495057", text: "#212529" },
  } satisfies Record<NodeKind, { fill: string; stroke: string; text: string }>,
} as const;
