// The STRIPE payment branch's checkout journey (Decisions 22-24) and the two idempotency
// cases that guard it, both through the real browser and the real gateway.
//
// CONTRACT: Needs the BACKEND, unlike the rest of `tests/web/` — `global-setup.ts` skips
// its health checks for a web-only run, so a down stack reads as a dead login form.
// See [[testing]]
//
// CONTRACT: Point `WEB_BASE_URL` at the CONTAINER (`http://localhost:3004`). Its nginx
// proxies `/v1/` to API_GATEWAY_URL, and it serves the build carrying the publishable
// key; `NG_APP_STRIPE_ENABLED` is inlined at BUILD time, so this file SKIPS against a
// plain-branch build rather than toggling it. See [[env-files]]

import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { getGatewayToken } from "../../support/auth";
import { gatewayClient } from "../../support/gateway-client";
import {
  awaitConfirmOutcome,
  clickBelowElement,
  confirmCard,
  enterTestCard,
  setupIntentConfirmable,
} from "../../support/payment-element";
import { pickProductWithStock } from "../../support/catalogue";
import {
  chargeAttemptsForOrder,
  customerIdForEmail,
  describeAttempts,
  missingStripeKeys,
} from "../../support/stripe-charges";
import {
  addFirstProductToCart,
  CART_WRITE_TIMEOUT_MS,
  signInAsNewUser,
  type WebTestUser,
} from "../../support/web-session";

/** Headroom for one `stripe.confirmSetup()`, which Stripe itself calls "several seconds". */
const CONFIRM_TIMEOUT_MS = 90_000;

/** Signs in a fresh buyer, seeds the cart, and lands on the Stripe branch. */
async function openStripeCheckout(page: Page, baseURL: string): Promise<WebTestUser> {
  const user = await signInAsNewUser(page, baseURL);
  // CONTRACT: Seed the cart. Both payment paths sit behind `@else if (cart.isEmpty())`,
  // so an empty cart renders NEITHER and the skip below fires — reading as a
  // plain-branch build rather than as an empty cart.
  await addFirstProductToCart(page);
  await page.goto("/checkout");

  await expect(page.getByRole("heading", { level: 1, name: /checkout/i })).toBeVisible();
  // The branch is chosen only once `cart.loading()` clears.
  await expect(page.locator("app-cart-line").first()).toBeVisible();

  const plainVisible = await page.getByTestId("checkout-plain").isVisible();
  test.skip(
    plainVisible,
    "this build serves the plain branch (NG_APP_STRIPE_ENABLED is not 'true') — the Payment " +
      "Element is not rendered, so there is no Stripe journey here to drive",
  );
  await expect(
    page.getByTestId("checkout-stripe"),
    "neither payment branch rendered. `stripeEnabled()` reads APP_CONFIG, which resolves the " +
      "build-time NG_APP_STRIPE_ENABLED — an absent value renders the plain branch, not nothing",
  ).toBeVisible();
  return user;
}

/**
 * Types the delivery address and saves it. `canPay` needs one on both branches, so a
 * card-only test would assert a Pay the address is holding down.
 *
 * CONTRACT: TYPE the fields; do NOT reach for `dev-fill`. It renders only under
 * `isDevMode()`, so it is absent from the container build this file targets.
 * See [[env-files]]
 */
async function fillAndSaveAddress(page: Page): Promise<void> {
  await expect(
    page.getByRole("heading", { level: 2, name: /add a delivery address/i }),
    "the checkout is not offering the address form — this buyer already has one on file, which " +
      "`registerWebUser` never creates",
  ).toBeVisible();

  // CONTRACT: Address these by ROLE AND EXACT NAME. Line 1 is a combobox whose open
  // suggestion list carries rows naming cities, so `getByLabel("City")` matches the
  // combobox as well and fails strict mode.
  await page
    .getByRole("combobox", { name: /Address Line 1/ })
    .fill("Av. Rómulo Betancourt 123");
  // Closes the suggestion popover the typing opened, so the fields below are addressable.
  await page.keyboard.press("Escape");
  await page.getByRole("textbox", { name: "City", exact: true }).fill("Santo Domingo");
  await page.getByRole("textbox", { name: "State", exact: true }).fill("Distrito Nacional");
  await page.getByRole("textbox", { name: "ZIP Code", exact: true }).fill("10604");
  await page.getByRole("textbox", { name: /Phone number/ }).fill("8090000000");

  const save = page.getByTestId("checkout-save-address");
  await expect(
    save,
    "Save is disabled with every address field filled — `canSaveAddress` reads the form's own " +
      "validity, so one of these values is failing its validator",
  ).toBeEnabled();
  await save.click();
  await expect(
    page.getByTestId("checkout-address"),
    "the address never saved — PATCH /v1/users/me either failed or the Save button is unwired",
  ).toBeVisible({ timeout: CART_WRITE_TIMEOUT_MS });
  await expect(
    page.getByTestId("checkout-address-required"),
    "the address saved but the `add a delivery address` banner is still up — `canPay` reads the " +
      "same `address()` signal, so Pay is being held disabled by a stale null",
  ).toHaveCount(0, { timeout: CART_WRITE_TIMEOUT_MS });
}

// Probed once per worker: a property of the sandbox's key, identical for every test here.
let sandboxReason: string | null = null;

test.beforeAll(async () => {
  sandboxReason = await setupIntentConfirmable();
});

test("a card added through the Payment Element appears in the selector, gets picked, and pays", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(240_000);
  test.skip(sandboxReason !== null, sandboxReason ?? "");
  const buyer = await openStripeCheckout(page, baseURL!);
  await fillAndSaveAddress(page);

  // With no card on file the selector renders the form directly — `showNewCardBlock()`
  // is true on an empty list, so there is no "Add card" to click first.
  await expect(
    page.getByTestId("new-card-block").first(),
    "a fresh buyer with no saved card should land straight on the New card form — the selector " +
      "renders it whenever the list comes back empty",
  ).toBeVisible({ timeout: 30_000 });

  await enterTestCard(page);

  // Decision 23: saving is OPT-IN here, and only a saved card can appear in the list.
  const saveCheckbox = page.getByTestId("save-card-checkbox");
  await expect(saveCheckbox).toHaveAttribute("aria-checked", "false");
  await clickBelowElement(saveCheckbox, "the save-card checkbox");
  await saveCheckbox.click();
  await expect(
    saveCheckbox,
    "clicking `Save this card for future purchases` did not check it, so the confirmed card is " +
      "used once and never attached — it cannot then appear in the selector",
  ).toHaveAttribute("aria-checked", "true");

  await confirmCard(page.getByTestId("save-card-button"));

  const outcome = await awaitConfirmOutcome(
    page,
    page.getByTestId("saved-cards-list"),
    CONFIRM_TIMEOUT_MS,
  );
  expect(
    outcome.error,
    `Stripe rejected the test Visa: "${outcome.error}". 4242 4242 4242 4242 with a future ` +
      "expiry and a 3-digit CVC is Stripe's own always-succeeds card, so a message here is the " +
      "request's shape and not the card",
  ).toBeNull();
  expect(
    outcome.done,
    "stripe.confirmSetup() neither completed nor reported an error within " +
      `${CONFIRM_TIMEOUT_MS / 1000}s. No request and no message means \`confirm()\` was never ` +
      "reached — see `confirmCard` in support/payment-element.ts for the layout race that " +
      "swallows the click",
  ).toBe(true);

  // The saved card is now in the list AND is what `pay()` will charge: the selector
  // re-reads after an attach and `resolveSelection` picks the live default.
  const row = page.getByTestId("saved-card-row");
  await expect(row, "the attached card is absent from the selector after the reload").toHaveCount(1);
  await expect(
    row.getByTestId("card-brand"),
    "the saved row does not read as the Visa that was entered — Users stores brand and last4 " +
      "from Stripe's own payment-method object",
  ).toContainText(/visa .* 4242/i);
  await expect(
    row.getByTestId("radio"),
    "the only live card is not selected. `resolveSelection` picks the default card and falls back " +
      "to the first live one, so an unselected single row means nothing was emitted to `pay()`",
  ).toHaveAttribute("aria-checked", "true");

  const created: { status: number; body: string }[] = [];
  page.on("response", async (response) => {
    if (response.request().method() !== "POST" || !response.url().endsWith("/v1/orders")) return;
    created.push({ status: response.status(), body: await response.text().catch(() => "") });
  });

  const pay = page.getByTestId("checkout-pay");
  await expect(
    pay,
    "Pay is disabled with an address saved and a live card selected — `canPay` is being held " +
      "false by something other than this branch's two inputs",
  ).toBeEnabled();
  await pay.click();

  await expect
    .poll(
      () => created.length,
      "clicking an enabled Pay issued no POST /v1/orders — the button is not wired to pay()",
    )
    .toBeGreaterThan(0);

  const { status, body } = created[0];
  expect(
    status,
    `POST /v1/orders answered ${status}: ${body.slice(0, 400)}. A 400 naming paymentMethodId means ` +
      "the selector emitted null; a 402 is Stripe declining the card it just saved; a 409 is stock " +
      "lost in the gap between reading the cart and charging it",
  ).toBe(201);

  await expect(page, "the order was created but the app never navigated to it").toHaveURL(
    /\/orders\/[^/]+$/,
    { timeout: CART_WRITE_TIMEOUT_MS },
  );

  // CONTRACT: Read the charge back from STRIPE, not from the 201. OrderDto carries no
  // payment fields, so a status-only assertion passes against a service that charged
  // nothing at all. See [[2026-09-19-stripe-payments-design]]
  const missing = missingStripeKeys();
  test.skip(missing !== null, missing ?? "");

  const orderId: string = JSON.parse(body).id;
  const attempts = await chargeAttemptsForOrder(buyer.email, orderId);
  expect(
    attempts.length,
    `Stripe holds ${attempts.length} PaymentIntent(s) for ${orderId}:\n${describeAttempts(attempts)}`,
  ).toBe(1);
  expect(attempts[0], describeAttempts(attempts)).toMatchObject({
    status: "succeeded",
    cardBrand: "visa",
    cardLast4: "4242",
  });
});

/**
 * The first of the two idempotency cases, through the REAL gateway rather than the
 * browser: the app mints its own key and has no affordance for omitting it.
 *
 * CONTRACT: Assert the SERVICE's 400, not the gateway's. A 404 carrying
 * `{"message":"Not Found"}` is the gateway's own body and means the request never
 * reached Orders; a 401 would mean the authorizer rejected the token. Either would pass
 * a "not 201" assertion while proving nothing about idempotency. See [[testing]]
 */
test("POST /v1/orders through the gateway rejects a missing Idempotency-Key while Stripe is on", async () => {
  const { token } = await getGatewayToken();
  const api = await gatewayClient(token);

  const products = await api.get("v1/products");
  expect(products.status(), `GET products failed: ${await products.text()}`).toBe(200);
  const productId = pickProductWithStock(await products.json(), { minStock: 1 }).id;

  const res = await api.post("v1/orders", {
    data: { lines: [{ productId, quantity: 1 }], paymentMethodId: "pm_card_visa" },
  });
  const body = await res.text();

  test.skip(
    res.status() === 201,
    `Orders accepted a create with no Idempotency-Key (201) — STRIPE_ENABLED is off there, so the ` +
      "header is optional and there is no 400 to assert. Set STRIPE_ENABLED=true on Orders.",
  );
  expect(
    res.status(),
    `expected 400 for a missing Idempotency-Key, got ${res.status()}: ${body.slice(0, 300)}`,
  ).toBe(400);
  expect(
    body,
    `the 400 does not name the missing header: ${body.slice(0, 300)}. Orders answers ` +
      "`idempotency_key_required` (step 9.10b), and a 400 about something else means this request " +
      "is malformed for a different reason",
  ).toMatch(/idempotency/i);
});

/**
 * The second case: the same `(user, key)` replayed yields the SAME order.
 *
 * CONTRACT: Verify by COUNTING the buyer's orders, not by comparing the two bodies. An
 * endpoint that charged twice and happened to return the first order's id would pass an
 * id comparison; only the history proves no second order exists.
 * See [[count-only-assertions-hide-cause]]
 */
test("replaying the same checkout request returns the same order and leaves one in the history", async () => {
  const { token, email } = await getGatewayToken();
  const api = await gatewayClient(token);

  const attached = await api.post("v1/users/me/payment-methods", {
    data: { paymentMethodId: "pm_card_visa" },
  });
  test.skip(
    attached.status() === 404,
    `Users has no payment-method routes mounted (404: ${(await attached.text()).slice(0, 160)}) — ` +
      "STRIPE_ENABLED is off there, so there is no card to replay a charge against.",
  );
  expect(attached.status(), `attach failed: ${await attached.text()}`).toBe(200);
  const { id: paymentMethodId } = await attached.json();

  const products = await api.get("v1/products");
  expect(products.status(), `GET products failed: ${await products.text()}`).toBe(200);
  const productId = pickProductWithStock(await products.json(), { minStock: 2 }).id;

  const idempotencyKey = randomUUID();
  const payload = {
    headers: { "Idempotency-Key": idempotencyKey },
    data: { lines: [{ productId, quantity: 1 }], paymentMethodId },
  };

  const first = await api.post("v1/orders", payload);
  expect(first.status(), `first create failed: ${await first.text()}`).toBe(201);
  const firstOrder = await first.json();

  const replay = await api.post("v1/orders", payload);
  const replayBody = await replay.text();
  // CONTRACT: A replay answers 200, not 201 — `CreateOrderEndpoint.cs` returns Created
  // only for an order it just made, and 200 with the stored response for a key it has
  // already seen. Accepting 201 here would pass a service that charged twice.
  expect(
    replay.status(),
    `the replay answered ${replay.status()}: ${replayBody.slice(0, 300)}. A 201 is a SECOND order ` +
      "for the same key; a 503 with Retry-After means the first request is still in flight",
  ).toBe(200);
  expect(
    JSON.parse(replayBody).id,
    `the replay returned a different order than the original (${firstOrder.id})`,
  ).toBe(firstOrder.id);

  const history = await api.get("v1/orders/my-orders");
  expect(history.status(), `GET my-orders failed: ${await history.text()}`).toBe(200);
  // A bare array, per OrderWithTrackingDto[] in services/orders/openapi.yaml.
  const orders: { id: string }[] = await history.json();
  const ids = orders.map((order) => order.id);
  expect(
    ids,
    `this buyer's order history holds ${ids.length} order(s) after ONE checkout replayed twice: ` +
      `${ids.join(", ")}. Two ids means the replay created a second order and charged the card again`,
  ).toEqual([firstOrder.id]);

  // CONTRACT: Count the PaymentIntents in STRIPE too. One order row with two intents is a
  // double charge the order history cannot show — the money moved twice while the ledger
  // reads once. See [[2026-09-19-stripe-payments-design]]
  const missing = missingStripeKeys();
  test.skip(missing !== null, missing ?? "");

  const customerId = await customerIdForEmail(email);
  expect(customerId, `no Stripe customer for ${email} — the attach never reached Stripe`).not.toBeNull();
  const attempts = await chargeAttemptsForOrder(email, firstOrder.id);
  expect(
    attempts.length,
    `Stripe holds ${attempts.length} PaymentIntent(s) for ${firstOrder.id} after the replay:\n` +
      describeAttempts(attempts),
  ).toBe(1);
  expect(attempts[0], describeAttempts(attempts)).toMatchObject({ status: "succeeded" });
});
