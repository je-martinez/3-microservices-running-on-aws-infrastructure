import { describe, expect, it } from "vitest";
import { activeStep, awsDuration, AWS_HOLD, AWS_INTRO, AWS_STEP, gifScale, stepPanelHeight } from "../src/aws/timing";

describe("aws timing", () => {
  it("is one frame for a step-less diagram", () => {
    expect(awsDuration(0)).toBe(1);
    expect(stepPanelHeight(0)).toBe(0);
  });
  it("lights steps in order and clears the highlight on the hold", () => {
    expect(activeStep(0, 3)).toBeUndefined();
    expect(activeStep(AWS_INTRO, 3)).toBe(0);
    expect(activeStep(AWS_INTRO + AWS_STEP, 3)).toBe(1);
    expect(activeStep(awsDuration(3) - 1, 3)).toBeUndefined();
    expect(awsDuration(3)).toBe(AWS_INTRO + 3 * AWS_STEP + AWS_HOLD);
  });
  it("scales wide GIFs down to 1200px and never up", () => {
    expect(gifScale(2400)).toBe(0.5);
    expect(gifScale(900)).toBe(1);
  });
});
