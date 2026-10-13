import { AWS } from "../theme/aws-style";
import type { AwsDiagramData } from "./schema";

export const AWS_FPS = 24;
export const AWS_INTRO = 12;
export const AWS_STEP = 36;
export const AWS_HOLD = 48;

const GIF_MAX_W = 1200;

/** Height of the step list drawn below the diagram; 0 for a step-less diagram. */
export function stepPanelHeight(steps: number): number {
  return steps === 0 ? 0 : 16 + steps * AWS.stepRowH;
}

/** Composition length; a step-less diagram is a single still frame. */
export function awsDuration(steps: number): number {
  return steps === 0 ? 1 : AWS_INTRO + steps * AWS_STEP + AWS_HOLD;
}

/** Index of the step lit at `frame`; undefined during the intro and the final hold. */
export function activeStep(frame: number, steps: number): number | undefined {
  if (frame < AWS_INTRO) return undefined;
  const i = Math.floor((frame - AWS_INTRO) / AWS_STEP);
  return i < steps ? i : undefined;
}

/** First frame of the hold, where every badge and the step list show. */
export function holdStart(steps: number): number {
  return AWS_INTRO + steps * AWS_STEP;
}

/**
 * Render scale that keeps a GIF at most 1200px wide and never upscales. The output width is rounded to a whole
 * pixel explicitly: a fractional frame size stops the GIF encoder from storing frames as deltas.
 */
export function gifScale(width: number): number {
  if (width <= GIF_MAX_W) return 1;
  const tenths = Math.floor((GIF_MAX_W / width) * 10) / 10;
  return Math.round(width * tenths) / width;
}

/** Only diagrams with steps render a GIF; the rest are PNG only. */
export function isAnimated(data: Pick<AwsDiagramData, "steps">): boolean {
  return data.steps.length > 0;
}
