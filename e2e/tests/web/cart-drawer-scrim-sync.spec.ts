// Phase-1 web verification: the scrim and the drawer reveal TOGETHER. The
// backdrop must not darken ahead of the white panel that covers it.
//
// CONTRACT: Sample both `animation.currentTime` clocks in ONE
// `requestAnimationFrame` callback and compare them to each other, never each
// against wall-clock time. Two clocks read a frame apart differ by a frame
// interval for that reason alone, which is the same size as the defect. Only a
// same-callback pair isolates the drift.
// See [[2026-09-03-animation-clock-sampling-beats-style-and-class-probes]]

import { chromium, expect, test, type Browser, type Locator, type Page } from "@playwright/test";

const VIEWPORT = { width: 1440, height: 900 };

/**
 * CONTRACT: Keep this under one 60Hz frame (16.7ms). The defect held a steady
 * ~16.7ms lead for the whole animation, so a budget at or above a frame passes
 * against it. Measured 33.3ms peak with the bug present and under 2ms once both
 * elements honour the same pause.
 * See [[2026-09-03-cart-drawer-first-open-flicker]]
 */
const MAX_CLOCK_GAP_MS = 8;

interface Pair {
  /** The scrim's enter-animation clock on a frame that was presented. */
  readonly scrim: number;
  /** The drawer's, read in the SAME callback — see the file header. */
  readonly drawer: number;
}

/**
 * Records the two enter clocks once per presented frame, keeping only frames on
 * which both elements are animating — a frame where one has finished and the
 * other has not is a legitimate end-of-animation difference, not drift.
 */
async function sampleBothClocks(page: Page, duration: number): Promise<Pair[]> {
  return page.evaluate(
    (ms) =>
      new Promise<Pair[]>((resolve) => {
        const pairs: Pair[] = [];
        const start = performance.now();
        const clock = (selector: string): number | null => {
          const animation = document.querySelector(selector)?.getAnimations()[0];
          return animation ? Number(animation.currentTime ?? 0) : null;
        };
        const tick = () => {
          const scrim = clock("app-scrim");
          const drawer = clock("app-cart-drawer");
          if (scrim !== null && drawer !== null) pairs.push({ scrim, drawer });
          if (performance.now() - start < ms) requestAnimationFrame(tick);
          else resolve(pairs);
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
  // Headed, matching the sibling drawer specs: headless Chromium composites
  // differently enough that the first-mount frame miss does not reproduce.
  browser = await chromium.launch({ headless: false });
});

test.afterAll(async () => {
  await browser.close();
});

/**
 * CONTRACT: Use a FRESH page and open the drawer exactly once. Both elements
 * are deferred only on their first mount of a page load, so a second open in
 * the same page starts them together whatever the stylesheet says and passes
 * against the bug.
 * See [[2026-09-03-animation-clock-sampling-beats-style-and-class-probes]]
 */
test("the scrim and the cart drawer reveal in step", async ({ baseURL }) => {
  const page = await browser.newPage({ viewport: VIEWPORT, baseURL });

  try {
    await page.goto("/");
    // `goto` resolves before Angular renders; sampling an unrendered page never
    // sees either element and the assertion below would pass on an empty series.
    await expect(page.getByRole("heading", { level: 1, name: /new arrivals/i })).toBeVisible();
    await page.waitForTimeout(500);

    const opening = sampleBothClocks(page, 500);
    await cartButton(page).click();
    const pairs = await opening;

    expect(
      pairs.length,
      "no frame carried both enter animations at once — the drawer and scrim never " +
        "animated together, so the gap assertion below would pass vacuously",
    ).toBeGreaterThan(4);

    const gaps = pairs.map((pair) => Math.abs(pair.scrim - pair.drawer));
    const worst = Math.max(...gaps);

    expect(
      worst,
      `the scrim's enter animation ran ${worst.toFixed(1)}ms ahead of the drawer's ` +
        `(budget ${MAX_CLOCK_GAP_MS}ms), so the backdrop darkens before the white panel ` +
        `arrives to cover it — the flicker. Both are held by \`[data-deferred-enter]\`, but ` +
        `the \`animation\` shorthand RESETS \`animation-play-state\`, so an enter class ` +
        `declared after that rule un-pauses itself and starts a frame early. Clock pairs ` +
        `(scrim/drawer): ` +
        pairs
          .slice(0, 6)
          .map((pair) => `${pair.scrim.toFixed(1)}/${pair.drawer.toFixed(1)}`)
          .join(" -> "),
    ).toBeLessThan(MAX_CLOCK_GAP_MS);
  } finally {
    await page.close();
  }
});
