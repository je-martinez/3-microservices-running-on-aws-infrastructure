// Phase-1 web verification: opening or closing a popover never changes the
// document's HEIGHT.
//
// CONTRACT: Sample EVERY animation frame, not before-and-after. The growth this
// file guards against lasts only for the enter/leave animation and snaps back on
// its final frame, so a settled before/after comparison reads 1085 and 1085 and
// passes against the exact bug. Measured unfixed on `/`: 1085 -> 1558 -> 1085.
// See [[angular-component-authoring]]

import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { launchWebBrowser } from "../../support/web-browser";

const VIEWPORT = { width: 1440, height: 900 };

/** Every route the header renders on — the growth is proportional to how far
 * down the page the overlay host sits, so a short route hides less of it. */
const ROUTES = [
  { path: "/", heading: /new arrivals/i },
  { path: "/orders", heading: /my orders/i },
  { path: "/profile", heading: /profile/i },
] as const;

const PANELS = [
  { name: "the notifications panel", icon: "svg.lucide-bell" },
  { name: "the account menu", icon: "svg.lucide-user" },
] as const;

/**
 * Records `documentElement.scrollHeight` on each animation frame for `duration`.
 * Sampling starts BEFORE the caller's click resolves, so the first frames are
 * the closed baseline and the animation is captured from its very first frame.
 */
async function sampleHeightPerFrame(page: Page, duration: number): Promise<number[]> {
  return page.evaluate(
    (ms) =>
      new Promise<number[]>((resolve) => {
        const heights: number[] = [];
        const start = performance.now();
        const tick = () => {
          heights.push(document.documentElement.scrollHeight);
          if (performance.now() - start < ms) requestAnimationFrame(tick);
          else resolve(heights);
        };
        requestAnimationFrame(tick);
      }),
    duration,
  );
}

let browser: Browser;

test.beforeAll(async () => {
  // Headed on purpose, and placed on the user's chosen display.
  // See `support/web-browser.ts` for why headless cannot stand in.
  browser = await launchWebBrowser();
});

test.afterAll(async () => {
  await browser.close();
});

for (const route of ROUTES) {
  for (const panel of PANELS) {
    test(`opening ${panel.name} on ${route.path} does not change the document height`, async ({
      baseURL,
    }) => {
      const page = await browser.newPage({ viewport: VIEWPORT, baseURL });

      try {
        await page.goto(route.path);
        // The route's own content first: `goto` resolves before Angular renders,
        // and an unrendered page is one empty viewport tall — a baseline taken
        // there is not the height the panel would have to disturb.
        await expect(page.getByRole("heading", { level: 1, name: route.heading })).toBeVisible();
        await page.waitForTimeout(500);

        const baseline = await page.evaluate(() => document.documentElement.scrollHeight);
        const control = page
          .locator("header button")
          .filter({ has: page.locator(panel.icon) });

        // Both controls toggle, so the same click opens and then closes.
        const opening = sampleHeightPerFrame(page, 500);
        await control.click();
        const openFrames = await opening;

        await page.waitForTimeout(300);
        const closing = sampleHeightPerFrame(page, 500);
        await control.click();
        const closeFrames = await closing;

        const frames = [...openFrames, ...closeFrames];
        const tallest = Math.max(...frames);

        expect(
          tallest - baseline,
          `the document is ${baseline}px tall with ${panel.name} closed and reaches ` +
            `${tallest}px mid-animation on ${route.path} — the scrollbar thumb resizes for the ` +
            "duration of every open and close. A popover panel is `position: fixed` and must add " +
            "no document height; a `transform` on its component host makes that host the " +
            "containing block and re-anchors the panel into the flow. Frames: " +
            frames.join(","),
        ).toBe(0);
      } finally {
        await page.close();
      }
    });
  }
}
