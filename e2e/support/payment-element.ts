import { expect, request, type FrameLocator, type Locator, type Page } from "@playwright/test";

// Drives the mounted Stripe Payment Element from a browser spec: reaches the fields
// inside Stripe's cross-origin iframe and types a card into them.
//
// CONTRACT: Reach the iframe through `frameLocator` and wait on its own content, never a
// fixed sleep. A missing CSP origin shows up ONLY as a console violation with an empty
// form. See [[2026-09-19-stripe-payments-design]]

/** Stripe's test PAN. The Element accepts a raw card; the raw-card API does not. */
export const TEST_VISA = "4242424242424242";

/** Card entry as the Element's three fields plus its billing pair. */
export interface ElementCard {
  readonly number: string;
  /** `MMYY`; the Element inserts the separator itself. */
  readonly expiry: string;
  readonly cvc: string;
  /** ISO-3166 alpha-2. The Element defaults to the browser locale's country. */
  readonly country: string;
  readonly postalCode: string;
}

/** A valid Visa whose expiry stays in the future as the year turns over. */
export function testVisa(): ElementCard {
  const year = (new Date().getFullYear() + 3) % 100;
  return {
    number: TEST_VISA,
    expiry: `12${String(year).padStart(2, "0")}`,
    cvc: "123",
    country: "US",
    postalCode: "10001",
  };
}

/**
 * The Element's iframe, with its card fields revealed.
 *
 * CONTRACT: Assert on the FIELDS, never on the accordion click. Stripe serves the
 * expanded and collapsed layouts interchangeably for one key, so a spec that always
 * clicks fails on an expanded run and one that never clicks fails on a collapsed one.
 * See [[2026-09-19-stripe-payments-design]]
 */
export async function cardFields(page: Page): Promise<FrameLocator> {
  const container = page.getByTestId("payment-element");
  await expect(
    container,
    "the Payment Element container never rendered — the add-card form is not open",
  ).toBeVisible();

  const element = container.frameLocator("iframe").first();
  const number = element.locator("#payment-numberInput");

  await expect(
    element.locator("body"),
    "Stripe's iframe mounted but rendered no payment methods. Check the browser console for a " +
      "Content-Security-Policy violation: the frame needs js.stripe.com and *.js.stripe.com in " +
      "`frame-src` and api.stripe.com in `connect-src`, and a missing origin leaves the form EMPTY " +
      "with no error on the page",
  ).toContainText("Card", { timeout: 60_000 });

  for (let attempt = 0; attempt < 6; attempt += 1) {
    if ((await number.count()) > 0) return element;
    await element
      .getByRole("button", { name: "Card", exact: true })
      .first()
      .click({ timeout: 8_000 })
      .catch(() => undefined);
    await expect(number)
      .toBeVisible({ timeout: 8_000 })
      .catch(() => undefined);
  }

  throw new Error(
    "the Payment Element never revealed its card fields. It rendered its method list " +
      `("${(await element.locator("body").innerText()).split("\n").slice(0, 6).join(" / ")}") but ` +
      "#payment-numberInput stayed absent through six attempts to expand the Card accordion",
  );
}

/**
 * CONTRACT: Real KEYSTROKES, never `fill()`. Stripe's inputs track their value from the
 * key events, so a filled field shows the digits and still confirms as "Your card number
 * is incomplete." See [[2026-09-19-stripe-payments-design]]
 */
export async function fillCardFields(element: FrameLocator, card: ElementCard): Promise<void> {
  await element.locator("#payment-numberInput").pressSequentially(card.number, { delay: 25 });
  await element.locator("#payment-expiryInput").pressSequentially(card.expiry, { delay: 25 });
  await element.locator("#payment-cvcInput").pressSequentially(card.cvc, { delay: 25 });

  // CONTRACT: Address the country select BY ID, never as `select` first(). An
  // "Additional Payment Methods" `<select>` sorts ahead of it whenever redirect methods
  // are eligible, and `selectOption("US")` against that one leaves the billing fields
  // empty. See [[2026-09-19-stripe-payments-design]]
  const country = element.locator("#payment-countryInput");
  if ((await country.count()) > 0) await country.selectOption(card.country);
  // Rendered per country: a US address needs a ZIP, many others collect none.
  const postalCode = element.locator("#payment-postalCodeInput");
  if ((await postalCode.count()) > 0) {
    await postalCode.pressSequentially(card.postalCode, { delay: 25 });
  }
}

/** Opens the add-card form, types a valid test Visa into it, and returns its frame. */
export async function enterTestCard(page: Page): Promise<FrameLocator> {
  const element = await cardFields(page);
  await fillCardFields(element, testVisa());
  return element;
}

/**
 * CONTRACT: WAIT FOR THE BOX TO STOP MOVING before clicking. The expanded Element grows
 * to ~1000px and pushes this button past the viewport; a click during that re-layout
 * never reaches `submit()`, and the spec sees no request, no error and an unchanged
 * label — indistinguishable from a Stripe-side hang.
 * See [[2026-09-19-stripe-payments-design]]
 */
export async function confirmCard(button: Locator): Promise<void> {
  await clickBelowElement(button, "the confirm button");
  await expect(button, "the confirm button is disabled — the Element never finished mounting").toBeEnabled();
  await button.click();
}

/**
 * CONTRACT: EVERY control under the Element needs this, not only the confirm button. The
 * save-card checkbox fails the same way, reporting `aria-checked="false"` after a click
 * Playwright considers delivered. See [[2026-09-19-stripe-payments-design]]
 */
export async function clickBelowElement(target: Locator, description: string): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const settled = JSON.stringify(await target.boundingBox());
  await expect
    .poll(async () => JSON.stringify(await target.boundingBox()), {
      timeout: 20_000,
      intervals: [500],
      message: `${description} never stopped moving — the Element iframe is still resizing`,
    })
    .toBe(settled);
}

/**
 * Waits for one of the three answers a confirm can produce, so a failure names which. A
 * rejected card renders into `card-error`; a success closes the form and reveals the
 * list. Both absent means the confirm never ran — see `confirmCard` above.
 */
export async function awaitConfirmOutcome(
  page: Page,
  settled: Locator,
  timeoutMs = 90_000,
): Promise<{ readonly done: boolean; readonly error: string | null }> {
  const cardError = page.getByTestId("card-error");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await settled.count()) > 0 && (await settled.first().isVisible())) {
      return { done: true, error: null };
    }
    const messages = await cardError.allTextContents();
    if (messages.length > 0) return { done: false, error: messages.join(" ").trim() };
    await page.waitForTimeout(500);
  }
  return { done: false, error: null };
}

/**
 * Whether this sandbox can mint a SetupIntent to confirm against, or the reason it cannot.
 *
 * CONTRACT: Probe the KEY and nothing else. `confirmSetup({ redirect: 'if_required' })`
 * settles fine against `allow_redirects: "always"` with no `return_url` — Stripe demands
 * one only when a REDIRECT method is chosen, and the card tab never is, so gating on that
 * setting skips a journey that works. See [[2026-09-19-stripe-payments-design]]
 */
export async function setupIntentConfirmable(): Promise<string | null> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    return (
      "STRIPE_SECRET_KEY is not set — it lives in the CUSTOM box of .env.local.users per " +
      "docs/infrastructure/runbooks/stripe-sandbox-setup.md, and playwright.config.ts loads it"
    );
  }

  const stripe = await request.newContext({ baseURL: "https://api.stripe.com/" });
  try {
    const created = await stripe.post("v1/setup_intents", {
      headers: { Authorization: `Bearer ${key}` },
      form: {},
    });
    if (created.status() !== 200) {
      return (
        `Stripe refused a probe SetupIntent: ${created.status()} ${await created.text()}. Users' ` +
        "restricted key needs SetupIntents write, so a 403 here is the key's policy, not the card."
      );
    }
    return null;
  } finally {
    await stripe.dispose();
  }
}
