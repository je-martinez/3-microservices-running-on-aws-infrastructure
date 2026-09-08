// The page does not change width when a route gains or loses its scrollbar, and
// the strip `scrollbar-gutter: stable` reserves is painted rather than left bare.
//
// CONTRACT: This file launches its OWN HEADED browser instead of using the
// `page` fixture. Headless Chromium draws OVERLAY scrollbars, which occupy no
// layout space, so `/profile` and `/orders` measure identically there WITH and
// WITHOUT `scrollbar-gutter: stable` — a spec on the shared fixture passes
// either way and proves nothing. Verified by measurement: headless reports
// header=1440 on both routes unfixed and header=1425 on both routes fixed,
// while headed reports 1440 vs 1425 unfixed. Forcing a classic scrollbar with
// `::-webkit-scrollbar` does NOT restore the layout either — it paints one
// without reserving space. See [[testing]]

import { expect, test, type Browser, type Page } from "@playwright/test";
import { launchWebBrowser } from "../../support/web-browser";
import { signInAsNewUser } from "../../support/web-session";

/**
 * `/profile` fits 1440x900 exactly and has no scrollbar; every other route
 * overflows and gains one. That pair is what makes the shift observable, so
 * neither route may be swapped for one that scrolls the same way as the other.
 */
const SHORT_ROUTE = "/profile";
const TALL_ROUTE = "/orders";
const VIEWPORT = { width: 1440, height: 900 };

/**
 * The width the routed PAGE renders into — the scroll container's content box.
 * CONTRACT: Measure `.app-scroll`, not the header and not
 * `documentElement.clientWidth`. The header sits OUTSIDE the scroller and spans
 * the full viewport on every route by design, so measuring it reads 1440 on
 * both routes and the navigation test passes against any regression.
 * See [[angular-component-authoring]]
 */
async function contentWidth(page: Page): Promise<number> {
  return page.evaluate(() => {
    const scroller = document.querySelector(".app-scroll");
    if (!scroller) throw new Error("no .app-scroll container — cannot measure the content width");
    return scroller.clientWidth;
  });
}

/** The header's own box — full viewport width on every route (see the last test). */
async function headerWidth(page: Page): Promise<number> {
  return page.evaluate(() => {
    const header = document.querySelector("app-app-header header");
    if (!header) throw new Error("no app header rendered — cannot measure the header width");
    return header.getBoundingClientRect().width;
  });
}

/**
 * Waits for the layout to stop changing, then returns the scrollbar gutter.
 * CONTRACT: Do NOT measure without settling, and poll on a TIMER rather than
 * `requestAnimationFrame` — the value is briefly stable across frames while
 * still wrong. Unsettled, the panel reads right=1401 on `/profile` and 1416
 * once settled, so the test compares transients and passes against a broken
 * app. See [[testing]]
 */
async function settledLayout(page: Page): Promise<number> {
  const gutter = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        // The gutter belongs to the SCROLLER, which is `.app-scroll` and not the
        // document — `innerWidth - documentElement.clientWidth` is 0 on every
        // route now, which would skip this whole file as "overlay scrollbars".
        const read = () => {
          const scroller = document.querySelector<HTMLElement>(".app-scroll");
          return scroller ? scroller.offsetWidth - scroller.clientWidth : 0;
        };
        let previous = read();
        let stableRounds = 0;
        const interval = setInterval(() => {
          const current = read();
          stableRounds = current === previous ? stableRounds + 1 : 0;
          previous = current;
          // 4 rounds x 50ms = 200ms unchanged, comfortably past the ~1 frame the
          // scrollbar takes to appear or disappear after a route renders.
          if (stableRounds >= 4) {
            clearInterval(interval);
            resolve(current);
          }
        }, 50);
      }),
  );
  return gutter;
}

let browser: Browser;

test.beforeAll(async () => {
  browser = await launchWebBrowser();
});

test.afterAll(async () => {
  await browser.close();
});

/**
 * CONTRACT: Skips rather than fails when no classic scrollbar exists — on a box
 * with overlay scrollbars (macOS "show scroll bars: when scrolling") there is no
 * gutter to reserve and nothing to assert. A silent pass there would be the
 * vacuous result this whole file exists to avoid, so the condition is measured
 * and named. See [[testing]]
 */
async function gutterOrSkip(page: Page, baseURL: string): Promise<number> {
  // CONTRACT: Sign in before measuring anything. Both routes sit behind
  // authGuard, so an anonymous visit renders the login form — which fits the
  // viewport, reserves no gutter, and would make this guard skip the whole file
  // against a perfectly working app.
  await signInAsNewUser(page, baseURL);
  return settledGutterOnOrders(page);
}

/** Measures the reserved gutter on the one route that reliably overflows. */
async function settledGutterOnOrders(page: Page): Promise<number> {
  await page.goto(TALL_ROUTE);

  // CONTRACT: Wait for the route's CONTENT, not just `goto`. Angular has not
  // rendered the page when `goto` resolves at readyState 'complete' — the
  // document is still one empty viewport tall, has no scrollbar, and reports a
  // 0px gutter. Measuring there makes this guard skip the whole file against a
  // genuinely broken app, which is the false PASS it exists to prevent.
  await expect(page.getByRole("heading", { level: 1, name: /my orders/i })).toBeVisible();

  const gutter = await settledLayout(page);
  test.skip(
    gutter === 0,
    `${TALL_ROUTE} overflows but reserves a 0px gutter — this browser draws overlay ` +
      "scrollbars, so the width shift under test cannot occur here",
  );
  return gutter;
}

/**
 * The colours `.app-scroll` can paint, as the compositor writes them.
 * `--color-surface-white` and `--color-surface-body` in `apps/web/src/styles.css`.
 */
const WHITE = "255,255,255";
const GREY = "244,244,245";

/**
 * The colour actually PAINTED at `x` on the given row, read out of a screenshot.
 *
 * CONTRACT: Read a screenshot pixel; `getComputedStyle` cannot answer this.
 * `scrollbar-gutter: stable` reserves the strip OUTSIDE the content box —
 * `.app-scroll` measures 1440 wide with a 1425 content box — so no descendant
 * occupies it and no element's computed style describes what is drawn there.
 * Decoded in-page via `createImageBitmap` rather than a PNG library, so this
 * needs no dependency the suite does not already have.
 * See [[angular-component-authoring]]
 */
async function paintedColorAt(page: Page, x: number, y: number): Promise<string> {
  const png = await page.screenshot();
  return page.evaluate(
    async ([bytes, px, py]) => {
      const blob = new Blob([new Uint8Array(bytes as number[])], { type: "image/png" });
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("no 2d context — cannot read the screenshot");
      context.drawImage(bitmap, 0, 0);
      // The screenshot is in DEVICE pixels; CSS coordinates scale by the ratio.
      const scale = bitmap.width / window.innerWidth;
      const [r, g, b] = context.getImageData(
        Math.round((px as number) * scale),
        Math.round((py as number) * scale),
        1,
        1,
      ).data;
      return `${r},${g},${b}`;
    },
    [[...png], x, y] as [number[], number, number],
  );
}

/**
 * Filters home down to a catalogue short enough not to overflow, and returns
 * the number of products left.
 *
 * CONTRACT: The gutter is only visible where NO scrollbar fills it, so this test
 * needs a route that fits the viewport. Home filtered by the header search is
 * exactly the case the grey band was reported on, and it is the only short
 * variant of a WHITE page in the app — `/profile` and `/orders` are grey, where a
 * grey strip is correct and proves nothing. See [[angular-component-authoring]]
 */
async function shrinkHomeUntilItFits(page: Page): Promise<number> {
  await expect(page.getByRole("heading", { level: 1, name: /new arrivals/i })).toBeVisible();
  const firstName = (
    await page.locator("app-product-card h3").first().innerText()
  ).trim();

  // CONTRACT: By ROLE. `getByLabel("Search products")` is ambiguous — the mobile
  // magnifier button carries the same aria-label and Playwright fails strict mode.
  await page.getByRole("searchbox", { name: "Search products" }).fill(firstName);
  await expect(page.locator("app-product-card")).not.toHaveCount(0);
  await settledLayout(page);

  const remaining = await page.locator("app-product-card").count();
  const overflows = await page.evaluate(() => {
    const scroller = document.querySelector(".app-scroll");
    return scroller ? scroller.scrollHeight > scroller.clientHeight : true;
  });
  expect(
    overflows,
    `home still overflows with ${remaining} product(s) matching "${firstName}", so the strip ` +
      "down its right edge is a real scrollbar rather than the reserved gutter — this test " +
      "cannot tell the two apart. Narrow the search or raise the viewport.",
  ).toBe(false);

  return remaining;
}

/**
 * The regression `c6c2e6e` fixed: on a white page that does not overflow, the
 * reserved strip showed as a grey band down the right edge.
 */
test("the reserved gutter is painted the page's colour on a route that does not scroll", async ({
  baseURL,
}) => {
  const page = await browser.newPage({ viewport: VIEWPORT, baseURL });

  try {
    // `/orders` first, only to learn how wide this box's gutter is; the
    // assertion itself is on home, which sign-in already reached.
    await signInAsNewUser(page, baseURL!);
    const gutter = await settledGutterOnOrders(page);
    await page.goto("/");
    const remaining = await shrinkHomeUntilItFits(page);

    // Mid-strip, below the header: the gutter spans the scroller's right edge,
    // and the reserved width is `gutter` px wide ending at the viewport edge.
    const x = VIEWPORT.width - Math.ceil(gutter / 2);
    const y = Math.round(VIEWPORT.height / 2);

    const strip = await paintedColorAt(page, x, y);
    // The page's own body, well inside the content box, as the reference.
    const body = await paintedColorAt(page, Math.round(VIEWPORT.width / 2), y);

    expect(
      strip,
      `home shows ${remaining} product(s) and does not scroll, yet the ${gutter}px strip at ` +
        `x=${x} is painted rgb(${strip}) while the page beside it is rgb(${body}). ` +
        `White is ${WHITE} and the body grey is ${GREY}. \`scrollbar-gutter: stable\` reserves ` +
        "that strip OUTSIDE the content box, so only `.app-scroll` itself can paint it — it " +
        "needs `background-color: var(--page-bg, ...)` and the page needs `data-page-bg`",
    ).toBe(body);

    expect(
      strip,
      `home is a white page but its reserved gutter is painted rgb(${strip}) rather than ` +
        `rgb(${WHITE}) — \`--page-bg\` did not reach \`.app-scroll\`, so the \`data-page-bg="white"\` ` +
        "hook on the page or the `:has()` rule that carries it up is missing",
    ).toBe(WHITE);
  } finally {
    await page.close();
  }
});

test("the content width is identical across a /profile -> /orders navigation", async ({
  baseURL,
}) => {
  const page = await browser.newPage({ viewport: VIEWPORT, baseURL });

  try {
    const gutter = await gutterOrSkip(page, baseURL!);

    await page.goto(SHORT_ROUTE);
    await expect(page.getByRole("heading", { level: 1, name: /profile/i })).toBeVisible();
    await settledLayout(page);
    const short = await contentWidth(page);

    // Through the real router, not `goto` — a full document load re-lays the page
    // out from scratch and would hide a shift that only happens mid-navigation.
    await page.locator("header button").filter({ has: page.locator("svg.lucide-user") }).click();
    await page.getByText("My orders", { exact: true }).click();
    await page.waitForURL("**/orders");
    await expect(page.getByRole("heading", { level: 1, name: /my orders/i })).toBeVisible();
    await settledLayout(page);
    const tall = await contentWidth(page);

    expect(
      Math.abs(tall - short),
      `the page is ${short}px wide on ${SHORT_ROUTE} and ${tall}px on ${TALL_ROUTE}, a ` +
        `${Math.abs(tall - short)}px jump on navigation. ${SHORT_ROUTE} fits the viewport and ` +
        `${TALL_ROUTE} does not, so the ${gutter}px scrollbar appears and narrows the page — ` +
        "`scrollbar-gutter: stable` on `.app-scroll` in apps/web/src/styles.css reserves it on both",
    ).toBeLessThan(1);

    // Both equal is satisfied by both being 1440 — which is what a dropped
    // gutter looks like on a box with overlay scrollbars. Pin the value: the
    // content box is the viewport minus the reserved strip on BOTH routes.
    expect(
      short,
      `both routes agree at ${short}px, but a ${gutter}px gutter is reserved, so the content ` +
        `box must be ${VIEWPORT.width - gutter}px. Reading the full ${VIEWPORT.width}px means ` +
        "nothing is reserved and the two routes match only because neither has a scrollbar",
    ).toBe(VIEWPORT.width - gutter);
  } finally {
    await page.close();
  }
});

/**
 * The popovers are `position: fixed` and anchored to `right-6`, so they never
 * change the document's width — but they are laid out against the same content
 * box, and so inherit the shift. Measured before the fix: the panel's right edge
 * sat at 1416 on `/profile` and 1401 on `/orders`.
 */
test("a right-anchored popover lands in the same place on both routes", async ({ baseURL }) => {
  const page = await browser.newPage({ viewport: VIEWPORT, baseURL });

  try {
    await gutterOrSkip(page, baseURL!);

    const rightEdges: Record<string, number> = {};
    for (const { route, heading } of [
      { route: SHORT_ROUTE, heading: /profile/i },
      { route: TALL_ROUTE, heading: /my orders/i },
    ]) {
      await page.goto(route);
      // The route's own content first: `goto` resolves before Angular renders,
      // and an unrendered page has not yet grown its scrollbar — so the panel
      // would be measured against a content box that is about to narrow.
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
      await page.locator("header button").filter({ has: page.locator("svg.lucide-bell") }).click();

      const panel = page.locator("app-notifications-panel > div");
      await expect(panel).toBeVisible();
      await settledLayout(page);
      const box = await panel.boundingBox();
      rightEdges[route] = box!.x + box!.width;
    }

    expect(
      Math.abs(rightEdges[TALL_ROUTE] - rightEdges[SHORT_ROUTE]),
      `the notifications panel's right edge is at ${rightEdges[SHORT_ROUTE]} on ${SHORT_ROUTE} ` +
        `and ${rightEdges[TALL_ROUTE]} on ${TALL_ROUTE} — the panel is fixed, so this is the ` +
        "content box moving under it, not the panel itself",
    ).toBeLessThan(1);
  } finally {
    await page.close();
  }
});

/**
 * CONTRACT: Opening a popover must not change the page width. Each panel is
 * `position: fixed`, so it adds no document height and pops no scrollbar. This
 * is what a body scroll-lock on open would BREAK: locking with `overflow:
 * hidden` removes the scrollbar and shifts the page by the gutter — reintroducing
 * the very jump the gutter reserves against. See [[angular-component-authoring]]
 */
for (const [control, icon] of [
  ["the bell", "svg.lucide-bell"],
  ["the profile button", "svg.lucide-user"],
] as const) {
  test(`opening ${control} does not change the page width`, async ({ baseURL }) => {
    const page = await browser.newPage({ viewport: VIEWPORT, baseURL });

    try {
      await gutterOrSkip(page, baseURL!);

      // The route WITHOUT a scrollbar: if opening a panel were to lengthen the
      // document, this is where a new scrollbar would appear.
      await page.goto(SHORT_ROUTE);
      await expect(page.getByRole("heading", { level: 1, name: /profile/i })).toBeVisible();
      await settledLayout(page);
      const closed = await contentWidth(page);

      await page.locator("header button").filter({ has: page.locator(icon) }).click();
      await settledLayout(page);
      const open = await contentWidth(page);

      expect(
        Math.abs(open - closed),
        `the page is ${closed}px wide with the panel closed and ${open}px with it open — a ` +
          "panel is `fixed` and must add no scrollable height; a scroll-lock on open would " +
          "also produce this by removing the scrollbar",
      ).toBeLessThan(1);
    } finally {
      await page.close();
    }
  });
}

/**
 * CONTRACT: Where NO route overflows, the header spans the FULL viewport width.
 * `scrollbar-gutter: stable` on `html` passes the two tests above but fails
 * this one — it reserves 15px on every route, so at 1920 the header stops at
 * 1905 with no scrollbar on screen: an empty strip down the right edge.
 * See [[angular-component-authoring]]
 *
 * WARNING: Assert on the HEADER's box, not `documentElement.clientWidth` — that
 * reads 1920 whether or not `html` reserves a gutter, so the usual
 * `innerWidth - clientWidth` formula returns 0 against both the fixed and the
 * broken app.
 */
test("no reserved strip on a viewport where nothing scrolls", async ({ baseURL }) => {
  // 1920x1080: every app route fits, so a correct app shows no scrollbar and no
  // gutter on any of them. At 1440x900 `/orders` genuinely overflows, so the
  // strip there is a real scrollbar and this assertion would not distinguish it.
  const viewport = { width: 1920, height: 1080 };
  const page = await browser.newPage({ viewport, baseURL });

  try {
    // Both routes sit behind authGuard; the login form is not what this measures.
    await signInAsNewUser(page, baseURL!);

    for (const { route, heading } of [
      { route: SHORT_ROUTE, heading: /profile/i },
      { route: TALL_ROUTE, heading: /my orders/i },
    ]) {
      await page.goto(route);
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
      await settledLayout(page);

      // Guards against a vacuous pass: if the route DOES overflow here, the
      // 15px is an honest scrollbar and proves nothing about a reserved strip.
      // Reads whichever element actually scrolls, so the guard stays meaningful
      // whether the app scrolls the document or an inner container.
      const routeScrolls = await page.evaluate(() => {
        const scroller = document.querySelector(".app-scroll") ?? document.documentElement;
        return scroller.scrollHeight > scroller.clientHeight;
      });
      expect(
        routeScrolls,
        `${route} overflows at ${viewport.width}x${viewport.height}, so any missing width is a ` +
          "real scrollbar rather than a reserved strip — this test can no longer tell the two " +
          "apart. Pick a taller viewport or a shorter route.",
      ).toBe(false);

      const width = await headerWidth(page);
      expect(
        width,
        `the header is ${width}px wide on ${route} at a ${viewport.width}px viewport where ` +
          `nothing scrolls — the missing ${viewport.width - width}px is a scrollbar gutter ` +
          "reserved on `html` that no scrollbar ever fills, and it reads as an empty strip down " +
          "the right edge",
      ).toBe(viewport.width);
    }
  } finally {
    await page.close();
  }
});
