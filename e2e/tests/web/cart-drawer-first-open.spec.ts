// Phase-1 web verification: the cart drawer's FIRST open animates from its
// start pose instead of holding there and jumping.
//
// CONTRACT: Assert the largest step in `animation.currentTime` between two
// PRESENTED frames, never a per-frame opacity or transform sweep. Both of those
// read the animation's computed value, which interpolates correctly whether or
// not the frame reached the screen — a sweep sampled during the stall shows a
// smooth fade and passes against the bug. Only the gap between presented frames
// exposes a clock that ran while nothing was painted.
// See [[angular-component-authoring]]

import { chromium, expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { launchWebBrowser } from "../../support/web-browser";

const VIEWPORT = { width: 1440, height: 900 };

/**
 * CONTRACT: Keep this above one 60Hz frame (16.7ms) and below two (33.3ms) — it
 * must absorb ordinary jitter yet still fail on a genuinely skipped frame.
 * Measured 25-50ms with the bug present, a flat ~10ms once the animation waits
 * for its first presented frame. See [[2026-09-03-cart-drawer-first-open-flicker]]
 */
const MAX_FRAME_STEP_MS = 25;

interface OpenSamples {
  /** `animation.currentTime` at each frame that was presented to the screen. */
  readonly currentTimes: readonly number[];
  /** Largest advance of the animation clock between two consecutive frames. */
  readonly maxStep: number;
}

/**
 * Samples the host's enter animation once per presented frame. `rAF` fires only
 * for frames the compositor presents, so a missed frame leaves a hole here: the
 * clock jumps by however long the miss lasted.
 */
async function sampleOpen(page: Page, duration: number): Promise<OpenSamples> {
  return page.evaluate(
    (ms) =>
      new Promise<OpenSamples>((resolve) => {
        const currentTimes: number[] = [];
        const start = performance.now();
        const tick = () => {
          const host = document.querySelector("app-cart-drawer");
          const animation = host?.getAnimations()[0];
          if (animation) currentTimes.push(Number(animation.currentTime ?? 0));
          if (performance.now() - start < ms) requestAnimationFrame(tick);
          else {
            let maxStep = 0;
            for (let i = 1; i < currentTimes.length; i++) {
              maxStep = Math.max(maxStep, currentTimes[i] - currentTimes[i - 1]);
            }
            resolve({ currentTimes, maxStep });
          }
        };
        requestAnimationFrame(tick);
      }),
    duration,
  );
}

const cartButton = (page: Page): Locator =>
  page
    .locator("header button")
    .filter({ has: page.locator("svg.lucide-shopping-bag, svg.lucide-shopping-cart") })
    .first();

let browser: Browser;

test.beforeAll(async () => {
  // Headed on purpose, and placed on the user's chosen display.
  // See `support/web-browser.ts` for why headless cannot stand in.
  browser = await launchWebBrowser();
});

test.afterAll(async () => {
  await browser.close();
});

/**
 * CONTRACT: Use a FRESH page and open the drawer exactly once. The stall is the
 * one-time cost of rastering the panel's layers, so the second open in the same
 * page is always clean — a test that opens twice, or reuses a page another test
 * already opened, passes against the bug.
 */
test("the cart drawer's first open animates without skipping a frame", async ({ baseURL }) => {
  const page = await browser.newPage({ viewport: VIEWPORT, baseURL });

  try {
    await page.goto("/");
    // `goto` resolves before Angular renders; sampling an unrendered page never
    // sees the drawer at all and the assertion below passes on an empty series.
    await expect(page.getByRole("heading", { level: 1, name: /new arrivals/i })).toBeVisible();
    await page.waitForTimeout(500);

    const opening = sampleOpen(page, 500);
    await cartButton(page).click();
    const { currentTimes, maxStep } = await opening;

    expect(
      currentTimes.length,
      "no frame carried a running enter animation — the drawer appeared with no open " +
        "animation at all, so the frame-step assertion below would pass vacuously",
    ).toBeGreaterThan(4);

    expect(
      maxStep,
      `the drawer's enter animation advanced ${maxStep.toFixed(1)}ms between two presented ` +
        `frames (budget ${MAX_FRAME_STEP_MS}ms). The animation clock starts when the class ` +
        `lands, but the first frame containing the drawer misses its deadline while the ` +
        `compositor rasters the panel's new layers. The panel therefore holds at its start ` +
        `pose and then jumps ~20% into the motion — the flicker. Fix: hold the animation ` +
        `until the element's first frame has been presented. Clock samples: ` +
        `${currentTimes.slice(0, 6).map((value) => value.toFixed(1)).join(" -> ")}`,
    ).toBeLessThan(MAX_FRAME_STEP_MS);
  } finally {
    await page.close();
  }
});
