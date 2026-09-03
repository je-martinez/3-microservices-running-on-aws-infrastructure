// Phase-1 web verification: `/profile` and the app header survive every width
// from a 320px phone to a 1440px desktop, with no overflow, no clipped text and
// no two elements painted on top of each other.
//
// CONTRACT: Sweep the WIDTH LIST below, not two or three sample widths. All
// three bugs this file covers live at a breakpoint edge — the badge overlap
// exists at 768 and nowhere else, and the header overflow exists at 320 and
// nowhere else. A test that samples 375/768/1440 sees the overlap only by
// luck and misses the overflow entirely. See [[testing]]

import { expect, test, type Page } from "@playwright/test";

/**
 * CONTRACT: 320 and 768 are load-bearing and may not be dropped. 320 is the
 * narrowest phone still in use (iPhone SE 1st gen / iPhone 4) and the only
 * width where the header overflows; 768 is an iPad portrait and exactly the
 * `md:` breakpoint, so it is the narrowest width at which the identity card
 * returns to a row — the worst case for that row fitting. See [[testing]]
 */
const WIDTHS = [320, 360, 375, 390, 414, 640, 768, 834, 1024, 1280, 1440] as const;

const HEIGHT = 900;

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * CONTRACT: Wait for the HEADER, not just `goto`. Angular has not painted when
 * `goto` resolves, and an unrendered document's widest element is `<html>` at
 * exactly the viewport width — so every assertion below passes against any
 * layout bug at all. This is the false PASS that let the badge overlap and the
 * header overflow both ship. See [[testing]]
 */
async function gotoProfile(page: Page): Promise<void> {
  await page.goto("/profile");
  await expect(page.locator("app-app-header header")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: /profile/i })).toBeVisible();
}

/** The email line — the leaf span, so `scrollWidth` is the text's own overflow. */
function emailLine(page: Page) {
  return page.locator("app-profile span", { hasText: /sign-in email, can't be changed/ }).last();
}

/** The member-since pill. */
function memberBadge(page: Page) {
  return page.locator("app-profile span", { hasText: /^Member since/ }).last();
}

async function boxOf(page: Page, locator: ReturnType<typeof emailLine>): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("element is not rendered — cannot measure it");
  return { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height };
}

/** Horizontal overlap of two boxes, 0 when they are disjoint on either axis. */
function overlapWidth(a: Box, b: Box): number {
  const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return x > 0 && y > 0 ? x : 0;
}

/**
 * The reset-password screen's own sweep. Its widths are a superset of the
 * `lg:` boundary either side (the auth layout swaps the brand rail for the
 * mobile header at 1024), plus the three phone widths where its longest
 * unbroken strings — the subtitle and the field help line — are tightest.
 */
const RESET_WIDTHS = [320, 375, 390, 768, 1440] as const;

for (const width of RESET_WIDTHS) {
  /**
   * CONTRACT: Measure each TEXT LEAF's own `scrollWidth - clientWidth`, not an
   * ancestor's. A clipped leaf does not grow any container's `scrollWidth`, so
   * the document-level overflow check below reads clean against a line that is
   * cut off inside its own box. See [[testing]]
   */
  test(`the reset screen clips no text at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: HEIGHT });
    await page.goto("/password/reset");
    await expect(
      page.getByRole("heading", { level: 1, name: /reset your password/i }),
    ).toBeVisible();

    const clipped = await page
      .locator("app-reset-password-request h1, app-reset-password-request p, " +
        "app-reset-password-request span, app-reset-password-request label")
      .evaluateAll((els) =>
        els
          .map((el) => ({
            text: (el.textContent ?? "").trim().slice(0, 40),
            overflow: el.scrollWidth - el.clientWidth,
          }))
          .filter((entry) => entry.overflow > 1),
      );

    expect(
      clipped,
      `at ${width}px these lines are wider than the box they are painted in: ` +
        `${clipped.map((c) => `"${c.text}" (+${c.overflow}px)`).join(", ")}`,
    ).toEqual([]);
  });

  test(`nothing on the reset screen overflows the viewport at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: HEIGHT });
    await page.goto("/password/reset");
    await expect(
      page.getByRole("heading", { level: 1, name: /reset your password/i }),
    ).toBeVisible();

    const widest = await page.evaluate(() => {
      let worst = { right: 0, description: "nothing" };
      for (const el of document.querySelectorAll("*")) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        if (rect.right > worst.right) {
          const classes = [...el.classList].slice(0, 3).join(".");
          worst = {
            right: rect.right,
            description: `${el.tagName.toLowerCase()}${classes ? "." + classes : ""}`,
          };
        }
      }
      return worst;
    });

    expect(
      widest.right,
      `at ${width}px the widest element (${widest.description}) reaches ` +
        `${Math.round(widest.right)}px, ${Math.round(widest.right - width)}px past the right edge`,
    ).toBeLessThanOrEqual(width + 1);
  });
}

for (const width of WIDTHS) {
  /**
   * CONTRACT: Compare the two bounding boxes; do NOT infer collision from a
   * width or overflow check. The badge and the email both sit entirely inside
   * the viewport while the badge paints over the email — `scrollWidth` is
   * clean at 768px against the broken layout, so only a geometric
   * intersection detects it. See [[testing]]
   */
  test(`the member badge does not overlap the email at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: HEIGHT });
    await gotoProfile(page);

    const email = await boxOf(page, emailLine(page));
    const badge = await boxOf(page, memberBadge(page));
    const overlap = overlapWidth(email, badge);

    expect(
      overlap,
      `at ${width}px the email spans ${Math.round(email.left)}..${Math.round(email.right)} and ` +
        `the member badge spans ${Math.round(badge.left)}..${Math.round(badge.right)}, so the ` +
        `badge paints over ${Math.round(overlap)}px of "can't be changed". The identity card is ` +
        "a row from `md:` up; the email must keep `min-w-0 flex-1` there so it shrinks instead " +
        "of pushing into the `shrink-0` badge",
    ).toBe(0);
  });

  /**
   * CONTRACT: Measure the EMAIL's own `scrollWidth - clientWidth`, not an
   * ancestor's. The address is a single unbreakable token: at 320px it
   * overflows its own box by 37px while the box, the card and every ancestor
   * stay inside the viewport, and the card clips it. No container's
   * `scrollWidth` grows, so a document- or scroller-level overflow check reads
   * clean against the bug. See [[testing]]
   */
  test(`the email text is not clipped at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: HEIGHT });
    await gotoProfile(page);

    const clipped = await emailLine(page).evaluate((el) => el.scrollWidth - el.clientWidth);

    expect(
      clipped,
      `at ${width}px the email's text is ${clipped}px wider than the box it is painted in, so ` +
        "it is cut off. The address contains no spaces, so it needs `break-words` to wrap at all",
    ).toBeLessThanOrEqual(1);
  });

  /**
   * CONTRACT: Find the widest element in the document and compare its right
   * edge to the viewport; do not read `.app-scroll`'s `scrollWidth`. The
   * header sits OUTSIDE that scroller, so the overflow it is responsible for
   * never reaches the container that check measures. See [[testing]]
   */
  test(`nothing overflows the viewport at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: HEIGHT });
    await gotoProfile(page);

    const widest = await page.evaluate(() => {
      let worst = { right: 0, description: "nothing" };
      for (const el of document.querySelectorAll("*")) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        if (rect.right > worst.right) {
          const classes = [...el.classList].slice(0, 3).join(".");
          worst = {
            right: rect.right,
            description: `${el.tagName.toLowerCase()}${classes ? "." + classes : ""}`,
          };
        }
      }
      return worst;
    });

    expect(
      widest.right,
      `at ${width}px the widest element (${widest.description}) reaches ` +
        `${Math.round(widest.right)}px, ${Math.round(widest.right - width)}px past the right ` +
        "edge, so it is clipped. The header's logo group and its four controls need 366px at " +
        "their natural size — below 360px the wordmark has to drop",
    ).toBeLessThanOrEqual(width + 1);
  });
}
