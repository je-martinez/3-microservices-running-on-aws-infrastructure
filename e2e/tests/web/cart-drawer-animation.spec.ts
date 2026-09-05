// Phase-1 web verification: the cart drawer animates open and closed without
// re-anchoring its own panel, and its line prices share one right edge.
//
// CONTRACT: Assert the HOST's computed `transform`, not the document height. A
// transformed host becomes the containing block for its `fixed` panel, but the
// drawer cannot show that as growth — its host is 0px tall and `html, body` are
// `overflow: hidden`, so the re-anchored panel is clipped rather than adding
// scroll. Verified by reintroducing the bug: every scroll dimension held
// constant while the panel ran 9px past the viewport, so a height-only test
// passes against it. See [[angular-component-authoring]]

import { chromium, expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { launchWebBrowser } from "../../support/web-browser";

const VIEWPORT = { width: 1440, height: 900 };

/**
 * Per-frame samples taken while the drawer opens or closes.
 * `hostTransform` is `"none"` for a correct implementation on every frame.
 */
interface Frame {
  readonly documentHeight: number;
  readonly scrollerHeight: number;
  readonly hostTransform: string | null;
  readonly hostPresent: boolean;
  readonly hostClass: string | null;
}

/**
 * Records one sample per animation frame for `duration` ms.
 * Sampling starts BEFORE the caller's click resolves, so the first frames are
 * the pre-click baseline and the animation is captured from its first frame.
 */
async function sampleFrames(page: Page, duration: number): Promise<Frame[]> {
  return page.evaluate(
    (ms) =>
      new Promise<Frame[]>((resolve) => {
        const frames: Frame[] = [];
        const scroller = document.querySelector(".app-scroll");
        const start = performance.now();
        const tick = () => {
          const host = document.querySelector("app-cart-drawer");
          frames.push({
            documentHeight: document.documentElement.scrollHeight,
            scrollerHeight: scroller?.scrollHeight ?? 0,
            hostTransform: host ? getComputedStyle(host).transform : null,
            hostPresent: host !== null,
            hostClass: host?.getAttribute("class") ?? null,
          });
          if (performance.now() - start < ms) requestAnimationFrame(tick);
          else resolve(frames);
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

const closeButton = (page: Page): Locator =>
  page.locator("app-cart-drawer button").filter({ has: page.locator("svg.lucide-x") }).first();

let browser: Browser;

test.beforeAll(async () => {
  // Headed on purpose, and placed on the user's chosen display.
  // See `support/web-browser.ts` for why headless cannot stand in.
  browser = await launchWebBrowser();
});

test.afterAll(async () => {
  await browser.close();
});

test("the cart drawer animates open and closed without transforming its host", async ({
  baseURL,
}) => {
  const page = await browser.newPage({ viewport: VIEWPORT, baseURL });

  try {
    await page.goto("/");
    // The route's own content first: `goto` resolves before Angular renders, and
    // a baseline taken on an unrendered page is one empty viewport tall.
    await expect(page.getByRole("heading", { level: 1, name: /new arrivals/i })).toBeVisible();
    await page.waitForTimeout(500);

    const baseline = await page.evaluate(() => ({
      documentHeight: document.documentElement.scrollHeight,
      scrollerHeight: document.querySelector(".app-scroll")?.scrollHeight ?? 0,
    }));

    const opening = sampleFrames(page, 600);
    await cartButton(page).click();
    const openFrames = await opening;

    await expect(page.locator("app-cart-drawer aside")).toBeVisible();
    await page.waitForTimeout(300);

    const closing = sampleFrames(page, 600);
    await closeButton(page).click();
    const closeFrames = await closing;

    const frames = [...openFrames, ...closeFrames];

    // CONTRACT: Count frames carrying the enter/leave CLASS, never frames where
    // the host merely exists. Sampling starts before the click resolves, so an
    // unanimated drawer still shows ~4 mounted frames of pre-click baseline —
    // a bare presence count sits under that noise floor and passes with no
    // animation at all. Measured exactly that before this was tightened.
    const enteringFrames = openFrames.filter((frame) =>
      frame.hostClass?.includes("drawer-enter"),
    ).length;
    expect(
      enteringFrames,
      "the drawer never carried `drawer-enter` — it appeared with no open animation",
    ).toBeGreaterThan(1);

    const leavingFrames = closeFrames.filter((frame) =>
      frame.hostClass?.includes("drawer-leave"),
    ).length;
    expect(
      leavingFrames,
      "the drawer never carried `drawer-leave` — it left the DOM immediately on close " +
        "instead of animating out. `animate.leave` on the HOST is what keeps it mounted; " +
        "a binding on the inner panel is a different template and silently never fires",
    ).toBeGreaterThan(1);

    // The assertion that actually discriminates (see the file header).
    const transformed = frames
      .map((frame) => frame.hostTransform)
      .filter((value) => value !== null && value !== "none");
    expect(
      transformed,
      "the `app-cart-drawer` host carried a transform mid-animation. A transformed " +
        "element becomes the containing block for its `fixed` descendants, so the panel " +
        "stops resolving against the viewport and re-anchors into the flow. The slide " +
        "belongs on the panel via `.drawer-enter > *`, never on the host. Saw: " +
        [...new Set(transformed)].join(" | "),
    ).toEqual([]);

    // Cheap invariant alongside it: a `fixed` panel adds no scrollable extent.
    const tallestDocument = Math.max(...frames.map((frame) => frame.documentHeight));
    const tallestScroller = Math.max(...frames.map((frame) => frame.scrollerHeight));
    expect(
      tallestDocument - baseline.documentHeight,
      `the document is ${baseline.documentHeight}px tall with the cart closed and reaches ` +
        `${tallestDocument}px mid-animation`,
    ).toBe(0);
    expect(
      tallestScroller - baseline.scrollerHeight,
      `the scroll container is ${baseline.scrollerHeight}px tall with the cart closed and ` +
        `reaches ${tallestScroller}px mid-animation`,
    ).toBe(0);
  } finally {
    await page.close();
  }
});

/**
 * CONTRACT: This test is only meaningful with prices of DIFFERENT character
 * widths on screen. The drawer shows the first three catalogue fixtures —
 * $89.00, $149.00 and $24.00 — so a six- and a seven-character price are both
 * present; the design's own `Cart Drawer` frame renders three six-character
 * prices, which line up by coincidence and hide this. The test asserts the
 * mixed widths are still there before asserting alignment, so a fixture reorder
 * makes it fail loudly rather than pass vacuously. See [[testing]]
 */
for (const surface of [
  { name: "cart drawer", path: "/", open: true },
  { name: "checkout order summary", path: "/checkout", open: false },
] as const) {
  test(`line prices share one right edge in the ${surface.name}`, async ({ baseURL }) => {
    const page = await browser.newPage({ viewport: VIEWPORT, baseURL });

    try {
      await page.goto(surface.path);
      if (surface.open) {
        await expect(page.getByRole("heading", { level: 1, name: /new arrivals/i })).toBeVisible();
        await cartButton(page).click();
      }
      await expect(page.locator("app-cart-line").first()).toBeVisible();
      await page.waitForTimeout(400);

      const prices = await page.locator("app-cart-line").evaluateAll((lines) =>
        lines.map((line) => {
          const price = line.querySelector("span.text-body-lg");
          const row = line.parentElement;
          // The row's CONTENT box: `clientWidth` includes its padding, and the
          // line only ever fills what is inside it.
          const rowStyle = row ? getComputedStyle(row) : null;
          const padding = rowStyle
            ? parseFloat(rowStyle.paddingLeft) + parseFloat(rowStyle.paddingRight)
            : 0;
          return {
            text: price?.textContent?.trim() ?? "",
            right: price?.getBoundingClientRect().right ?? 0,
            hostWidth: line.getBoundingClientRect().width,
            availableWidth: (row?.clientWidth ?? 0) - padding,
          };
        }),
      );

      expect(prices.length, "no cart lines rendered").toBeGreaterThan(1);

      const widths = new Set(prices.map((price) => price.text.length));
      expect(
        widths.size,
        `every price on screen is ${[...widths].join("/")} characters wide, so they would ` +
          "line up whatever the alignment — this test cannot detect the bug it exists for. " +
          `Prices: ${prices.map((price) => price.text).join(", ")}`,
      ).toBeGreaterThan(1);

      // The root cause: an unstyled custom element is display:inline and shrinks
      // to its content as a flex item, so the template's `w-full` resolves
      // against the shrunken host and each line ends up a different width.
      for (const price of prices) {
        expect(
          Math.round(price.availableWidth - price.hostWidth),
          `the cart line holding ${price.text} is ${price.hostWidth}px wide inside a ` +
            `${price.availableWidth}px row — the host is shrink-wrapping to its own content ` +
            "instead of filling. `app-cart-line` needs `block w-full` on its host.",
        ).toBe(0);
      }

      const edges = [...new Set(prices.map((price) => Math.round(price.right)))];
      expect(
        edges,
        `the ${prices.length} line prices end at ${edges.join(", ")} — they must share one ` +
          `right edge to read as a column. Prices: ${prices.map((price) => price.text).join(", ")}`,
      ).toHaveLength(1);
    } finally {
      await page.close();
    }
  });
}

/**
 * CONTRACT: `app-field` carries the same host defect as `app-cart-line` —
 * profile's Address field measured 304px inside a 760px card. Its two siblings
 * escape only because the template wraps them in a sizing div, so the fix
 * belongs on the component, not the call site. See [[angular-component-authoring]]
 */
test("profile fields fill their row rather than shrink-wrapping", async ({ baseURL }) => {
  const page = await browser.newPage({ viewport: VIEWPORT, baseURL });

  try {
    await page.goto("/profile");
    await expect(page.locator("app-field").first()).toBeVisible();
    await page.waitForTimeout(400);

    const fields = await page.locator("app-field").evaluateAll((hosts) =>
      hosts.map((host) => {
        const row = host.parentElement;
        const rowStyle = row ? getComputedStyle(row) : null;
        const padding = rowStyle
          ? parseFloat(rowStyle.paddingLeft) + parseFloat(rowStyle.paddingRight)
          : 0;
        return {
          label: host.querySelector("span")?.textContent?.trim() ?? "",
          width: host.getBoundingClientRect().width,
          available: (row?.clientWidth ?? 0) - padding,
        };
      }),
    );

    expect(fields.length, "no fields rendered on /profile").toBeGreaterThan(0);

    for (const field of fields) {
      expect(
        Math.round(field.available - field.width),
        `the "${field.label}" field is ${field.width}px wide inside a ${field.available}px ` +
          "row — a bare custom element is display:inline and shrinks to its content as a " +
          "flex item, so the template's `w-full` resolves against the shrunken host. " +
          "`app-field` needs `block w-full` on its host.",
      ).toBe(0);
    }
  } finally {
    await page.close();
  }
});
