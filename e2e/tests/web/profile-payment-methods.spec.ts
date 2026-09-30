// The profile's Payment methods tab (Task 12 / Decision 22): add a card through the
// mounted Payment Element, promote one to default, remove another, and watch the
// `SAVED CARDS` count follow each write. Desktop only — the mobile frames (`W6IFps`,
// `WQAq0`) are the reference if a viewport pass is added later.
//
// CONTRACT: Needs the BACKEND, unlike the rest of `tests/web/` — `global-setup.ts` skips
// its health checks for a web-only run, so a down stack reads as a dead login form.
// See [[testing]]
//
// CONTRACT: Point `WEB_BASE_URL` at the CONTAINER (`http://localhost:3004`). The tab
// renders only when that BUILD carries `NG_APP_STRIPE_ENABLED=true`, and its nginx
// proxies `/v1/` to the real gateway. See [[env-files]]

import { expect, test, type Page } from "@playwright/test";
import {
  awaitConfirmOutcome,
  confirmCard,
  enterTestCard,
  setupIntentConfirmable,
} from "../../support/payment-element";
import { registerWebUser, signIn, type WebTestUser } from "../../support/web-session";
import { gatewayClient } from "../../support/gateway-client";
import { getGatewayToken } from "../../support/auth";

const CONFIRM_TIMEOUT_MS = 90_000;
/** Headroom for one payment-method write plus the list re-read that follows it. */
const WRITE_TIMEOUT_MS = 30_000;

/** Signs in a fresh user and opens the profile's Payment methods tab. */
async function openPaymentMethodsTab(page: Page, user: WebTestUser): Promise<void> {
  await signIn(page, user);
  await page.goto("/profile");
  // CONTRACT: Wait for a stable anchor before COUNTING anything. `count()` does not
  // auto-wait, so probing the tabs straight after `goto` reads 0 on every run and the
  // skip below fires — reporting the flag off on a build that carries it on.
  await expect(page.getByRole("heading", { level: 1, name: /profile/i })).toBeVisible();

  const tabs = page.getByTestId("profile-tabs");
  test.skip(
    (await tabs.count()) === 0,
    "the profile renders no Tabs frame — this build has NG_APP_STRIPE_ENABLED off, so Decision " +
      "22's Payment methods tab does not exist and the profile keeps its single-view shape",
  );

  await page.getByTestId("tab-payment-methods").click();
  await expect(
    page.getByTestId("saved-cards-section"),
    "clicking the Payment methods tab did not swap the panel — `active()` still reads " +
      "'delivery-address', so the projected address form is still showing",
  ).toBeVisible();
}

/** The `N card(s)` label beside `SAVED CARDS`. */
function countLabel(page: Page) {
  return page.getByTestId("section-count");
}

/**
 * Attaches `pm` to this user's Stripe customer THROUGH THE GATEWAY, so a test needing a
 * second card does not pay for a second Payment Element confirm.
 *
 * CONTRACT: Only for the cards a test needs as BACKGROUND. The card the test is about
 * goes in through the Element — a spec that seeds every card proves the list renders and
 * nothing about the form the buyer uses. See [[testing]]
 */
async function seedSavedCard(email: string, password: string, pm: string): Promise<string> {
  const api = await gatewayClient((await loginToken(email, password)).token);
  const res = await api.post("v1/users/me/payment-methods", { data: { paymentMethodId: pm } });
  expect(res.status(), `seeding ${pm} failed: ${await res.text()}`).toBe(200);
  const { id } = await res.json();
  await api.dispose();
  return id;
}

/** A Bearer token for an EXISTING user, which `getGatewayToken` cannot give. */
async function loginToken(email: string, password: string): Promise<{ token: string }> {
  const api = await gatewayClient();
  const res = await api.post("v1/users/login", { data: { email, password } });
  expect(res.status(), `login via gateway failed: ${await res.text()}`).toBe(200);
  const body = await res.json();
  await api.dispose();
  return { token: body.accessToken ?? body.idToken };
}

let sandboxReason: string | null = null;
let routesMissingReason: string | null = null;

test.beforeAll(async () => {
  sandboxReason = await setupIntentConfirmable();

  // WHY: With STRIPE_ENABLED=false Users never mounts these routes and its framework
  // 404 answers. The gateway's own {"message":"Not Found"} is a missing ROUTE and must
  // fail the suite, so only a 404 that reached Users skips these specs.
  const { token } = await getGatewayToken();
  const api = await gatewayClient(token);
  const res = await api.get("v1/users/me/payment-methods");
  if (res.status() === 404) {
    const body = await res.json().catch(() => ({}));
    if (body.message !== "Not Found") {
      routesMissingReason =
        "STRIPE_ENABLED is off in Users — the payment-method routes are not mounted, so the " +
        "profile tab has nothing to read, write or remove.";
    }
  }
  await api.dispose();
});

test.beforeEach(() => {
  test.skip(routesMissingReason !== null, routesMissingReason ?? "");
});

test("adding a card through the Payment Element raises the SAVED CARDS count", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const user = await registerWebUser(baseURL!);
  await openPaymentMethodsTab(page, user);

  // With no card on file the form IS the surface — `showAddCard()` is true on an empty
  // list, so there is no "Add a card" to click first.
  await expect(countLabel(page), "a fresh user's wallet should read 0 cards").toHaveText(/^\s*0 cards\s*$/);
  await expect(
    page.getByTestId("profile-add-card"),
    "an empty wallet should render the add-card form directly — `showAddCard()` is true whenever " +
      "the list comes back empty",
  ).toBeVisible({ timeout: 30_000 });

  await enterTestCard(page);

  // Decision 22's profile branch: saving is IMPLICIT and the checkbox chooses only
  // whether the new card also becomes the default. It arrives checked.
  await expect(
    page.getByTestId("default-card-checkbox"),
    "the profile's `set as default` box should arrive CHECKED — a card added deliberately here is " +
      "usually the one to use, per the design frame",
  ).toHaveAttribute("aria-checked", "true");

  test.skip(sandboxReason !== null, sandboxReason ?? "");
  await confirmCard(page.getByTestId("add-card-button-submit"));

  const outcome = await awaitConfirmOutcome(page, page.getByTestId("cards-list"), CONFIRM_TIMEOUT_MS);
  expect(
    outcome.error,
    `Stripe rejected the test Visa: "${outcome.error}". 4242 4242 4242 4242 with a future expiry ` +
      "and a 3-digit CVC is Stripe's own always-succeeds card, so a message here is the request's " +
      "shape and not the card",
  ).toBeNull();
  expect(
    outcome.done,
    `stripe.confirmSetup() neither completed nor reported an error within ${CONFIRM_TIMEOUT_MS / 1000}s. ` +
      "No request and no message means `submit()` was never reached — see `confirmCard` in " +
      "support/payment-element.ts for the layout race that swallows the click",
  ).toBe(true);

  await expect(
    countLabel(page),
    "the card was attached but the count did not follow. `onCardAdded` re-reads the list, so a " +
      "stale label means the reload never ran or answered empty",
  ).toHaveText(/^\s*1 card\s*$/, { timeout: WRITE_TIMEOUT_MS });

  const row = page.getByTestId("saved-card-row");
  await expect(row).toHaveCount(1);
  await expect(
    row.getByTestId("card-brand"),
    "the new row does not read as the Visa that was entered",
  ).toContainText(/visa .* 4242/i);
  await expect(
    row.getByTestId("default-badge"),
    "the checkbox was checked but no Default badge rendered — `submit()` calls setDefault only " +
      "when it is, and the reload then reads `isDefault` back from Users",
  ).toBeVisible();

  // CONTRACT: The profile's rows carry NO radio. A choice here sends nowhere — the
  // checkout owns picking a card, this tab only manages them.
  await expect(
    row.getByTestId("radio"),
    "a radio rendered on a profile row — `selectable` must stay false here",
  ).toHaveCount(0);
});

test("promoting a card moves the Default badge and removing another drops the count", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const user = await registerWebUser(baseURL!);

  // Seeded through the gateway, not the Element: this test is about the two WRITES the
  // list offers, and two more Element confirms would only re-prove the add path.
  const visaId = await seedSavedCard(user.email, user.password, "pm_card_visa");
  const mastercardId = await seedSavedCard(user.email, user.password, "pm_card_mastercard");
  expect(visaId).not.toBe(mastercardId);

  await openPaymentMethodsTab(page, user);
  await expect(countLabel(page), "both seeded cards should be listed").toHaveText(/^\s*2 cards\s*$/, {
    timeout: WRITE_TIMEOUT_MS,
  });

  const rows = page.getByTestId("saved-card-row");
  await expect(rows).toHaveCount(2);

  // CONTRACT: BOTH rows arrive non-default, so pick one rather than deriving it from the
  // badge. `attach-payment-method.command.ts` writes `isDefault: false` unconditionally —
  // an attach never promotes, not even the first — so a spec that expects the first card
  // to be default finds two `Set as default` links and reads as a broken demote.
  await expect(
    page.getByTestId("default-badge"),
    "a card is flagged Default before any promotion. An attach writes `isDefault: false`, so a " +
      "badge here means something else set it",
  ).toHaveCount(0);

  const promoted = rows.first();
  const promotedBrand = (await promoted.getByTestId("card-brand").innerText()).trim();
  const demotedBrand = (await rows.nth(1).getByTestId("card-brand").innerText()).trim();
  expect(promotedBrand, "both rows render the same brand and last4").not.toBe(demotedBrand);

  await promoted.getByTestId("set-default-link").click();

  await expect(
    rows.filter({ has: page.getByTestId("default-badge") }).getByTestId("card-brand"),
    `the Default badge did not move to ${promotedBrand} after Set as default. \`mutate\` re-reads ` +
      "the list, so the badge comes from Users — a badge on the other row means PUT .../default " +
      "promoted the wrong card",
  ).toContainText(promotedBrand, { timeout: WRITE_TIMEOUT_MS });
  await expect(
    rows.filter({ has: page.getByTestId("default-badge") }),
    "two rows carry the Default badge — only one card can be the default",
  ).toHaveCount(1);
  await expect(countLabel(page), "promoting a card changed the count").toHaveText(/^\s*2 cards\s*$/);

  // Remove the card that is NOT the default, so the delete is unambiguous.
  const removable = rows.filter({ hasNot: page.getByTestId("default-badge") });
  await expect(removable).toHaveCount(1);
  const removedBrand = (await removable.getByTestId("card-brand").innerText()).trim();
  await removable.getByTestId("remove-button").click();

  await expect(
    countLabel(page),
    `removing ${removedBrand} did not drop the count. The row is deleted by a re-read after ` +
      "DELETE, so a stale `2 cards` means the detach failed or the reload did not run",
  ).toHaveText(/^\s*1 card\s*$/, { timeout: WRITE_TIMEOUT_MS });
  await expect(rows).toHaveCount(1);
  await expect(
    rows.getByTestId("card-brand"),
    `the wrong card survived the remove: expected ${promotedBrand} to remain`,
  ).toContainText(promotedBrand);
  await expect(
    page.getByTestId("cards-error"),
    "an error is rendered beside a list that updated correctly",
  ).toHaveCount(0);
});
