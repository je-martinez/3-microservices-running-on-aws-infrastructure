import type { DiagramLayout } from "./layout";
import { textWidth, wrap } from "./measure";
import type { AwsDiagramData } from "./schema";
import { stepPanelHeight } from "./timing";

export const CANVAS_PAD = 20;
export const TITLE_PX = 22;
export const TITLE_LINE_H = 28;
export const SUBTITLE_PX = 14;
export const CAPTION_PX = 15;
export const STEP_LIST_PX = 13;
/** Step-list badge plus its gap to the caption. */
export const STEP_LIST_BADGE = 18 + 8;
const MAX_TITLE_W = 1200;
// WHY: textWidth estimates regular Arimo; the bold title runs about 10% wider.
const BOLD = 1.1;

export type Canvas = {
  width: number;
  height: number;
  /** Offset of the laid-out diagram inside the canvas (centred horizontally, below a grown title band). */
  dx: number;
  dy: number;
  titleLines: string[];
};

/** Canvas wide enough for the diagram and every text drawn outside it: title, subtitle, caption bar, step list. */
export function canvasSize(data: Pick<AwsDiagramData, "title" | "subtitle" | "steps">, layout: Pick<DiagramLayout, "width" | "height">): Canvas {
  const text = (w: number) => w + 2 * CANVAS_PAD;
  const needs = [
    layout.width,
    Math.min(MAX_TITLE_W, text(textWidth(data.title, TITLE_PX) * BOLD)),
    data.subtitle ? text(textWidth(data.subtitle, SUBTITLE_PX)) : 0,
    ...data.steps.map((s, i) => text(textWidth(`${i + 1}. ${s.caption}`, CAPTION_PX))),
    ...data.steps.map((s) => text(STEP_LIST_BADGE + textWidth(s.caption, STEP_LIST_PX))),
  ];
  const width = Math.ceil(Math.max(...needs));
  const titleLines = wrap(data.title, TITLE_PX * BOLD, width - 2 * CANVAS_PAD, 2);
  const dy = (titleLines.length - 1) * TITLE_LINE_H;
  return {
    width,
    height: Math.ceil(layout.height + dy + stepPanelHeight(data.steps.length)),
    dx: Math.round((width - layout.width) / 2),
    dy,
    titleLines,
  };
}
