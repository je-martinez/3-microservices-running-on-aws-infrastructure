import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EmailCatalogUnavailableError,
  renderCatalog,
  type RenderedTemplate,
} from "../support/email-catalog-render.js";

// Screenshots every entry of the events-pipeline email catalog into
// e2e/screenshots/<catalog-key>.png, so a human can SEE what the rebranded
// transactional emails actually look like.
//
// ## This is a visual-artefact generator, not a pixel-diff suite
//
// There is deliberately NO `toHaveScreenshot()` / snapshot comparison here. A
// pixel baseline for eight emails full of dates ("Member Since August 5, 2026")
// would go red on every font update and every day the sample timestamps drift
// relative to `new Date()`, and it would answer a question nobody asked. The
// output of this spec is the PNGs; the assertions exist only to guarantee the
// PNGs are of a real, populated email rather than a blank page.
//
// ## Where the HTML comes from — and why not the preview server
//
// Not from `docker compose --profile preview up email-preview` (host 3003).
// The preview UI lists the four FILES under functions/events-pipeline/emails/,
// while the catalog registers EIGHT entries — tracking-status-changed.tsx alone
// is registered five times with different sampleProps. Driving the preview would
// produce four images, collapse the five tracking variants into one, and paint
// them with undefined props (the templates export no `PreviewProps`). The full
// reasoning lives in ../support/email-catalog-render.ts.
//
// Instead the catalog is rendered directly, through the events-pipeline
// package's own toolchain, with the same sampleProps its snapshot tests use.
// That covers every entry and needs no running service.

const screenshotsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "screenshots",
);

// 680x1024: the templates are built to a 600px body (the email industry's safe
// width), and the extra 80px leaves the page background visible on both sides so
// a screenshot shows the card the way a webmail client frames it rather than a
// flush-cut column. Height barely matters — every capture is fullPage — but a
// realistic one keeps any above-the-fold judgement honest.
const VIEWPORT = { width: 680, height: 1024 };

// Content each template must show, beyond the shared brand mark. These are the
// values that make the screenshot WORTH taking: the receipt's total, the
// timeline's tracking number, the one-time code. A blank or half-rendered page
// fails here instead of being silently saved as a useless PNG.
//
// ## Why the brand mark is matched as /3M\s*RAI/ and not "3MRAI"
//
// The wordmark is NOT a single text node. `Brand`/`EmailLayout` render it split
// so the two halves can be coloured differently, so the rendered HTML contains
// `3M` and `RAI` in separate elements and the browser's text content reads
// "3M RAI". Asserting the literal "3MRAI" against the visible text would fail on
// a perfectly correct email. The footer does carry a contiguous "3MRAI Company",
// which is why the check below tolerates the optional whitespace instead of
// pinning either spelling.
const BRAND_MARK = /3M\s*RAI/;

//: Per-key expectations, keyed by CATALOG key. Every catalog entry must appear
// here — the spec asserts that below, so adding a template without an
// expectation fails loudly rather than being screenshotted unchecked.
const EXPECTATIONS: Record<string, RegExp[]> = {
  "user-created": [
    /Welcome to 3MRAI/i,
    /Ada Lovelace/,
    /ada@example\.com/,
    //: The account id, which is the one field a welcome mail exists to hand over.
    /usr_sample1/,
  ],
  "order-created": [
    /Order Confirmed/i,
    /ord_sample1/,
    //: The line items and the four money figures. `$47.39` is the total from the
    // catalog's sampleProps (4739 cents) — if the receipt ever renders raw cents
    // or drops a row, this is what catches it.
    /Mechanical Keyboard/,
    /USB-C Cable/,
    /\$47\.39/,
    /1 Ada Way/,
  ],
  "tracking-status-changed-placed": [
    /Tracking Update/i,
    /Order placed/i,
    /3MRAI-7K2P-9WQX-4M8B/,
    /Order Placed/,
  ],
  "tracking-status-changed-processing": [
    /being prepared/i,
    /3MRAI-7K2P-9WQX-4M8B/,
    //: The previous status is shown, which is the whole point of a "changed"
    // email — a transition mail that only names the new status tells the
    // recipient nothing they did not already know.
    /PLACED/,
  ],
  "tracking-status-changed-shipped": [/has shipped/i, /3MRAI-7K2P-9WQX-4M8B/, /PROCESSING/],
  "tracking-status-changed-out-for-delivery": [
    /Out for delivery/i,
    /3MRAI-7K2P-9WQX-4M8B/,
    /SHIPPED/,
  ],
  "tracking-status-changed-delivered": [
    /Delivered/i,
    /3MRAI-7K2P-9WQX-4M8B/,
    /OUT_FOR_DELIVERY/,
  ],
  "auth-otp": [
    /Login Code/i,
    //: The code is split into per-digit boxes in the markup, so the contiguous
    // "042817" appears in the prose line ("Use this code…") while the boxes read
    // "0 4 2 8 1 7". Matching the contiguous form pins the prose; the digit boxes
    // are a visual detail the screenshot itself shows.
    /042817/,
    /expires in 5 minutes/i,
  ],
  "forgot-password": [
    /Reset Your Password/i,
    // Same split-digit arrangement as auth-otp above: the contiguous "720486"
    // lives in the prose line ("Use the code below…"), while the boxes render
    // "7 2 0 4 8 6". Matching the contiguous form is what pins the machine-
    // readable copy the gateway E2E scrapes — see [[email-templates]].
    /720486/,
    // The TTL is rendered from the prop, not the mockup: 10 minutes here, and
    // the `.pen` frame agrees. A drift to the old 30 would mean the sample props
    // and the template's expiry line stopped agreeing.
    /expires in 10 minutes/i,
  ],
};

// Rendered ONCE for the whole file, in a beforeAll: the render shells out to the
// events-pipeline package (see the helper) and doing that eight times would pay
// the tsx startup cost eight times over for identical output.
let rendered: RenderedTemplate[] = [];
let unavailableReason: string | null = null;

test.beforeAll(async () => {
  // Raised above Playwright's 30s hook default because the work here is a
  // subprocess that transpiles and renders the whole catalog, not an HTTP call.
  // Measured at ~1.3s on this machine, so 120s is pure headroom for a cold
  // esbuild cache or a loaded CI box — it is not an expected duration.
  test.setTimeout(120_000);

  fs.mkdirSync(screenshotsDir, { recursive: true });
  try {
    rendered = await renderCatalog();
  } catch (err) {
    // Only a MISSING dependency turns into a skip. A render that ran and threw
    // is a template defect and is rethrown, because a screenshot spec that goes
    // green when the templates are broken is worse than no spec.
    if (err instanceof EmailCatalogUnavailableError) {
      unavailableReason = err.message;
      return;
    }
    throw err;
  }
});

// Paints one rendered email and captures it full-page.
//
// `setContent` with `waitUntil: "load"` rather than the default "load"-on-
// navigation semantics of goto: the HTML is self-contained (react-email inlines
// every style, and `<Tailwind>` compiles its classes to inline `style`
// attributes at render time — nothing is fetched at paint time), so there is no
// network to wait on. The one exception is the @font-face declaration for Inter,
// which has no `src` and therefore resolves instantly to the Helvetica/Arial
// fallback — the same fallback most mail clients apply.
async function captureTemplate(page: Page, template: RenderedTemplate): Promise<string> {
  await page.setViewportSize(VIEWPORT);
  await page.setContent(template.html, { waitUntil: "load" });

  const file = path.join(screenshotsDir, `${template.key}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

test("every catalog entry has a content expectation declared", async () => {
  test.skip(unavailableReason !== null, unavailableReason ?? "");

  // Guards the table above from silently falling behind the catalog. Without
  // this, a ninth template would be screenshotted with no assertion at all and
  // the suite would still be green — exactly the "passes against a blank page"
  // failure this spec is supposed to be immune to.
  const keys = rendered.map((t) => t.key).sort();
  const declared = Object.keys(EXPECTATIONS).sort();
  expect(
    keys,
    "src/email/catalog.ts and the EXPECTATIONS table in this spec have drifted — " +
      "add the new template's distinguishing content here.",
  ).toEqual(declared);
});

// One test per catalog entry, generated from the table. Individual tests rather
// than a loop inside one test so a single broken template names itself in the
// report instead of aborting the run before the remaining screenshots are taken.
for (const key of Object.keys(EXPECTATIONS)) {
  test(`renders and screenshots ${key}`, async ({ page }) => {
    test.skip(unavailableReason !== null, unavailableReason ?? "");

    const template = rendered.find((t) => t.key === key);
    expect(template, `catalog has no entry "${key}"`).toBeDefined();

    const file = await captureTemplate(page, template!);

    // The visible text of the painted page, which is what a recipient reads.
    // Asserting on this rather than on the HTML string is the point: it only
    // contains what actually RENDERED, so a template whose body is hidden,
    // zero-height, or wrapped in a broken element fails here while a naive
    // `html.includes(...)` would pass.
    const text = await page.locator("body").innerText();

    expect(text, `${key} rendered without the brand mark`).toMatch(BRAND_MARK);
    for (const pattern of EXPECTATIONS[key]) {
      expect(text, `${key} is missing its distinguishing content: ${pattern}`).toMatch(pattern);
    }

    // A rendered email is a few hundred characters of prose at minimum. This
    // catches the degenerate "styles applied to an empty body" case that the
    // per-pattern checks above could in principle survive if the patterns were
    // ever loosened.
    expect(text.trim().length, `${key} rendered almost no text`).toBeGreaterThan(200);

    // And the artefact itself exists and is a real image. 5 KB is far below the
    // ~40-120 KB these captures actually weigh, so it only trips on a blank or
    // truncated PNG — it is not a size baseline.
    const { size } = fs.statSync(file);
    expect(size, `${file} is suspiciously small — did the page paint?`).toBeGreaterThan(5_000);
  });
}
