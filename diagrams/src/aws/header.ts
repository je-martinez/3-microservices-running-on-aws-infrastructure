import { GROUP_STYLE } from "../theme/aws-style";
import type { Rect } from "./layout";
import { textWidth } from "./measure";
import type { GroupKind } from "./schema";

export const GROUP_ICON = 32;
export const GROUP_LABEL_PX = 14;

/**
 * Geometry of a group's header (corner icon plus label). Layout, label placement and the renderer all read
 * it from here, so the band a route or label must avoid is exactly the one drawn.
 */
export function groupHeader(kind: GroupKind, label: string): { iconSize: number; textLeft: number; width: number; height: number } {
  const iconSize = GROUP_STYLE[kind].icon ? GROUP_ICON : 0;
  const textLeft = iconSize ? GROUP_ICON + 8 : 10;
  return { iconSize, textLeft, width: textLeft + textWidth(label, GROUP_LABEL_PX) + 4, height: GROUP_ICON };
}

/** The header band in canvas coordinates for a group frame `g`. */
export function groupHeaderRect(g: Rect, kind: GroupKind, label: string): Rect {
  return { x: g.x, y: g.y, w: groupHeader(kind, label).width, h: GROUP_ICON };
}
