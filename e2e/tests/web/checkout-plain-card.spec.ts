// The PLAIN payment branch's card validation (Decision 21), driven through the
// real browser and the real gateway.
//
// CONTRACT: This file needs the BACKEND, like `gateway-session.spec.ts` and
// unlike the rest of `tests/web/`. `global-setup.ts` skips its health checks for
// a web-only run, so a down stack surfaces as a login form that does nothing —
// which is why `registerWebUser` reports the gateway's own status and body.
// See [[testing]]
//
// CONTRACT: `NG_APP_STRIPE_ENABLED` is inlined at BUILD time, so a test cannot
// toggle the branch — this file SKIPS when the build under test serves the Stripe
// branch. Covering both means two runs against two builds. See [[env-files]]

import { expect, test, type Page } from "@playwright/test";
import {
  addFirstProductToCart,
  CART_WRITE_TIMEOUT_MS,
  signInAsNewUser,
} from "../../support/web-session";

/**
 * A deliberate Luhn failure: Visa's 16 digits with the last one transposed.
 * `isValidCardNumber` accepts the length and the checksum rejects it, which is
 * the exact pair `card-validation.ts` documents.
 */
const LUHN_FAILING_VISA = "4242424242424241";
const VALID_VISA = "4242424242424242";

/** Amex: 15 digits, grouped 4-6-5, and a FOUR-digit code. */
const VALID_AMEX = "378282246310005";

/**
 * Two years out, so this literal keeps holding — a hardcoded year expires the
 * test itself, and reading the rule out of `card-validation.ts` would
 * reimplement the code under test.
 */
function futureExpiry(): string {
  const now = new Date();
  const year = (now.getFullYear() + 2) % 100;
  return `${String(now.getMonth() + 1).padStart(2, "0")}${String(year).padStart(2, "0")}`;
}

/** Signs in a fresh buyer, seeds the cart, and lands on the plain branch. */
async function openPlainCheckout(page: Page, baseURL: string): Promise<void> {
  await signInAsNewUser(page, baseURL);
  // CONTRACT: Seed the cart. Both payment paths sit behind `@else if
  // (cart.isEmpty())`, so an empty cart renders NEITHER and the skip below
  // fires — reading as a Stripe-enabled build rather than as an empty cart.
  await addFirstProductToCart(page);
  await page.goto("/checkout");

  await expect(page.getByRole("heading", { level: 1, name: /checkout/i })).toBeVisible();
  // The branch is chosen only once `cart.loading()` clears.
  await expect(page.locator("app-cart-line").first()).toBeVisible();

  const stripeVisible = await page.getByTestId("checkout-stripe").isVisible();
  test.skip(
    stripeVisible,
    "this build serves the Stripe branch (NG_APP_STRIPE_ENABLED=true) — the plain " +
      "card form is not rendered, so there is nothing here to validate",
  );
  await expect(page.getByTestId("checkout-plain")).toBeVisible();
}

/**
 * Fills the address through the dev-fill affordance and saves it.
 *
 * CONTRACT: `canPay` requires an address on BOTH branches, so a card-only test
 * would assert a disabled button that the address — not the card — is holding
 * down. Dev-fill also writes the card fields, so every card assertion below
 * retypes them. See [[2026-09-07-dev-form-autofill]]
 */
async function fillAndSaveAddress(page: Page): Promise<void> {
  const plain = page.getByTestId("checkout-plain");
  await expect(
    plain.getByTestId("dev-fill"),
    "the dev-fill button is absent — it renders only under `isDevMode()`, so this run is " +
      "against a production build where the address must be typed instead",
  ).toBeVisible();
  await plain.getByTestId("dev-fill").click();

  await page.getByTestId("checkout-save-address").click();
  // The saved-address card replaces the form once PATCH /v1/users/me answers.
  await expect(
    page.getByTestId("checkout-address"),
    "the address never saved — PATCH /v1/users/me either failed or the Save button is unwired",
  ).toBeVisible({ timeout: CART_WRITE_TIMEOUT_MS });
  // CONTRACT: Give this the SAME headroom as the card above. Both key off
  // `address()`, so the banner clears in the same tick — but with Playwright's
  // 5s default it is the assertion that trips first on a slow PATCH, and the
  // failure then reads as an address that never saved.
  await expect(
    page.getByTestId("checkout-address-required"),
    "the address saved but the `add a delivery address` banner is still up — `canPay` reads " +
      "the same `address()` signal, so Pay is being held disabled by a stale null",
  ).toHaveCount(0, { timeout: CART_WRITE_TIMEOUT_MS });
}

/** Retypes one card field through real keystrokes, so the formatter runs. */
async function typeCardField(page: Page, testid: string, value: string): Promise<void> {
  const field = page.getByTestId(testid);
  await field.fill("");
  await field.pressSequentially(value);
}

async function fillCard(
  page: Page,
  card: { number: string; expiry: string; cvc: string; holder: string },
): Promise<void> {
  await typeCardField(page, "card-number", card.number);
  await typeCardField(page, "card-expiry", card.expiry);
  await typeCardField(page, "card-cvc", card.cvc);
  await typeCardField(page, "card-holder", card.holder);
}

test("a Luhn-failing card number keeps Pay disabled; correcting it enables Pay", async ({
  page,
  baseURL,
}) => {
  await openPlainCheckout(page, baseURL!);
  await fillAndSaveAddress(page);

  const pay = page.getByTestId("checkout-pay");
  const expiry = futureExpiry();

  await fillCard(page, {
    number: LUHN_FAILING_VISA,
    expiry,
    cvc: "123",
    holder: "Morgan Reyes",
  });

  // The number is the ONLY invalid field, so a disabled Pay here is the
  // checksum's doing and nothing else's.
  await expect(
    pay,
    `Pay is enabled with ${LUHN_FAILING_VISA} typed. It carries Visa's 16 digits and fails ` +
      "Luhn, so `isValidCardNumber` must reject it and `canPay` must stay false — a length-only " +
      "check passes this number",
  ).toBeDisabled();
  await expect(
    page.getByTestId("card-number-error"),
    "no message under the card number — the field is invalid but reports nothing, so the " +
      "buyer sees a dead Pay button with no reason",
  ).toBeVisible();

  await typeCardField(page, "card-number", VALID_VISA);

  await expect(
    pay,
    `Pay is still disabled with ${VALID_VISA}, expiry ${expiry} and a 3-digit CVC — every ` +
      "field is valid, so `canPay` is being held false by something other than the card form",
  ).toBeEnabled();
  await expect(page.getByTestId("card-number-error")).toHaveCount(0);
});

/**
 * The other half of Decision 21's plain branch: a corrected card actually buys
 * something. Split from the validation test above because it needs BOTH flags in
 * the same position, which the test cannot arrange.
 *
 * CONTRACT: Skip, never fail, when Orders runs with STRIPE_ENABLED=true against
 * a plain-branch build. Orders then demands a `paymentMethodId` the plain branch
 * has no way to produce (`pay()` sends card METADATA only), so the 400 is the two
 * flags disagreeing — a real deployment sets one value for both. The card
 * validation above is unaffected and stays a hard assertion.
 * See [[env-files]]
 */
test("a valid card on the plain branch places the order", async ({ page, baseURL }) => {
  await openPlainCheckout(page, baseURL!);
  await fillAndSaveAddress(page);

  await fillCard(page, {
    number: VALID_VISA,
    expiry: futureExpiry(),
    cvc: "123",
    holder: "Morgan Reyes",
  });

  // Recorded rather than stubbed: the status and body are what the skip below
  // reads, and a stub would prove nothing about the branch's own request shape.
  const created: { status: number; body: string }[] = [];
  page.on("response", async (response) => {
    if (response.request().method() !== "POST" || !response.url().endsWith("/v1/orders")) return;
    created.push({ status: response.status(), body: await response.text().catch(() => "") });
  });

  const pay = page.getByTestId("checkout-pay");
  await expect(pay).toBeEnabled();
  await pay.click();

  await expect
    .poll(
      () => created.length,
      "clicking an enabled Pay issued no POST /v1/orders — the button is not wired to pay()",
    )
    .toBeGreaterThan(0);

  const { status, body } = created[0];
  test.skip(
    status === 400 && body.includes("paymentMethodId"),
    "Orders runs with STRIPE_ENABLED=true while this web build renders the plain branch: " +
      "POST /v1/orders demands a paymentMethodId the plain branch never sends. Set both to " +
      "the same value (services' STRIPE_ENABLED and the build's NG_APP_STRIPE_ENABLED) to " +
      "exercise this.",
  );

  expect(
    status,
    `POST /v1/orders answered ${status}: ${body.slice(0, 300)}. A 400 naming \`card\` means the ` +
      "brand/last4/expiry metadata this branch sends fails Orders' own re-validation " +
      "(CardMetadataValidator); a 409 is stock lost in the gap between reading the cart and " +
      "charging it",
  ).toBe(201);

  await expect(page).toHaveURL(/\/orders\/[^/]+$/, { timeout: CART_WRITE_TIMEOUT_MS });
});

/**
 * The brand-aware half of the rule: the same three digits that satisfy a Visa
 * leave an Amex invalid, because `requiredCvcLength` follows the DETECTED brand.
 */
test("an Amex takes a 4-digit code: three digits keep Pay disabled, the fourth enables it", async ({
  page,
  baseURL,
}) => {
  await openPlainCheckout(page, baseURL!);
  await fillAndSaveAddress(page);

  const pay = page.getByTestId("checkout-pay");

  await fillCard(page, {
    number: VALID_AMEX,
    expiry: futureExpiry(),
    cvc: "123",
    holder: "Morgan Reyes",
  });

  // The number itself is valid — only the code's LENGTH is wrong for this brand.
  await expect(
    page.getByTestId("card-number-error"),
    `${VALID_AMEX} reports a number error. It is Amex's 15 digits and passes Luhn, so ` +
      "`detectCardBrand` is not recognising the 37 prefix or the length table rejects 15",
  ).toHaveCount(0);
  await expect(
    pay,
    "Pay is enabled with a 3-digit code on an Amex — `requiredCvcLength` must return 4 for " +
      "this brand, so `canPay` cannot be true yet",
  ).toBeDisabled();

  await typeCardField(page, "card-cvc", "1234");

  await expect(
    pay,
    "Pay is still disabled with a 4-digit Amex code — every field is now valid",
  ).toBeEnabled();

  // The grouping is the visible half of brand awareness: 4-6-5, not 4-4-4-4.
  await expect(
    page.getByTestId("card-number"),
    "the Amex number is not grouped 4-6-5 — `groupCardDigits` fell back to the 4-4-4-4 pattern",
  ).toHaveValue("3782 822463 10005");
});

/** An expiry already past is rejected even with a perfectly valid number. */
test("a past expiry keeps Pay disabled on an otherwise valid card", async ({ page, baseURL }) => {
  await openPlainCheckout(page, baseURL!);
  await fillAndSaveAddress(page);

  await fillCard(page, {
    number: VALID_VISA,
    expiry: "0120",
    cvc: "123",
    holder: "Morgan Reyes",
  });

  await expect(
    page.getByTestId("checkout-pay"),
    "Pay is enabled with an expiry of 01/2020 — `isValidExpiry` must compare against the last " +
      "day of the expiry month and reject a month already past",
  ).toBeDisabled();
  await expect(page.getByTestId("card-expiry-error")).toBeVisible();
});

/**
 * CONTRACT: A holder of SPACES is invalid, not merely empty-checked — the same
 * `\S` trap the address fields guard against. A `required`-only validator
 * accepts "   " and the order carries a blank name.
 */
test("a cardholder name of only spaces keeps Pay disabled", async ({ page, baseURL }) => {
  await openPlainCheckout(page, baseURL!);
  await fillAndSaveAddress(page);

  await fillCard(page, {
    number: VALID_VISA,
    expiry: futureExpiry(),
    cvc: "123",
    holder: "   ",
  });

  await expect(
    page.getByTestId("checkout-pay"),
    "Pay is enabled with a cardholder name of three spaces — the validator is `required` only, " +
      "which a whitespace value satisfies",
  ).toBeDisabled();
  await expect(page.getByTestId("card-holder-error")).toBeVisible();
});
