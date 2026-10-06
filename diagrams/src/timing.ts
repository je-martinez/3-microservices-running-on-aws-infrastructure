export const WIDTH = 1200;
export const HEIGHT = 675;
export const FPS = 24;
/** Frames before the first edge/step lights up. */
export const INTRO = 18;
/** Frames each edge/step owns. */
export const STEP = 36;
/** Frames the finished diagram stays on screen (the PNG is its last frame). */
export const HOLD = 48;

export function durationFor(units: number): number {
  return INTRO + units * STEP + HOLD;
}

/** 0→1 progress of unit `i` at `frame`. */
export function unitProgress(frame: number, i: number): number {
  const start = INTRO + i * STEP;
  return Math.min(1, Math.max(0, (frame - start) / (STEP * 0.6)));
}
