import { expect, request, type Page } from "@playwright/test";
import { makeUser } from "./chance-factory.js";

/**
 * Sign-in for the web specs. Every page under the app layout sits behind
 * `authGuard`, so a spec navigating without a session asserts against the login
 * form instead.
 *
 * CONTRACT: Sign in through the UI; there is no session to inject. Tokens are
 * AES-GCM encrypted into IndexedDB under a non-extractable CryptoKey, so
 * `storageState` carries nothing. See [[2026-09-04-web-gateway-integration-design]]
 */

/**
 * Headroom for one `PUT /v1/cart`.
 *
 * CONTRACT: HEADROOM around an unexplained cost, never an accepted latency. The
 * write measures ~5s against Floci (4.96/4.98/4.97s) — a consistency that points at
 * a timeout or retry inside Orders. See [[2026-09-08-put-cart-takes-five-seconds]]
 */
export const CART_WRITE_TIMEOUT_MS = 20_000;

export interface WebTestUser {
  readonly email: string;
  readonly password: string;
}

/**
 * Registers a user through the web app's OWN origin, so the account is created
 * over exactly the path the browser will later authenticate on.
 *
 * CONTRACT: Send `X-E2E-Source` — it is what tags the row for `global-teardown`
 * to delete. Users honors it only under its own `E2E_TESTING_ENABLED`, so the
 * header cannot tag anything in a production runtime. See [[testing]]
 */
export async function registerWebUser(baseURL: string): Promise<WebTestUser> {
  const user = makeUser();
  const ctx = await request.newContext({
    baseURL,
    extraHTTPHeaders: {
      "X-E2E-Source": "true",
      "x-e2e-run-id": process.env.E2E_RUN_ID ?? "",
    },
  });
  try {
    const res = await ctx.post("/v1/users/register", {
      data: { email: user.email, password: user.password, fullName: user.fullName },
    });
    expect(
      res.status(),
      `register through the web app's own origin failed: ${res.status()} ${await res.text()}. ` +
        "The nginx `/v1` proxy in front of the app is what makes this same-origin — a 404 here " +
        "means the request never reached the gateway.",
    ).toBe(201);
  } finally {
    await ctx.dispose();
  }
  return { email: user.email, password: user.password };
}

/**
 * Fills and submits the sign-in form, then waits for the app to land home.
 *
 * CONTRACT: Click by ROLE AND NAME. The shared `ButtonPrimary` renders
 * `type="button"`, so neither `form button` nor `button[type=submit]` finds it —
 * `form button` matches the password field's show/hide toggle instead and the
 * form silently never submits. See [[angular-component-authoring]]
 */
export async function signIn(page: Page, user: WebTestUser): Promise<void> {
  await page.goto("/login");
  await expect(page.getByRole("heading", { level: 1, name: /welcome back/i })).toBeVisible();

  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: /^sign in$/i }).click();

  await expect(
    page,
    "the app did not leave /login after submitting valid credentials. A 401 means the " +
      "credentials never reached Users; staying put with no error means the Sign in button " +
      "is not wired to submit()",
  ).toHaveURL(/\/$/);
}

/** Registers a fresh user and signs the given page in as them. */
export async function signInAsNewUser(page: Page, baseURL: string): Promise<WebTestUser> {
  const user = await registerWebUser(baseURL);
  await signIn(page, user);
  return user;
}

/**
 * Adds the first catalogue product to the signed-in user's cart, from `/`.
 *
 * CONTRACT: Seed before visiting `/checkout`. A fresh user's cart is EMPTY, so
 * checkout renders its empty branch and the test fails reporting
 * `stripe=false plain=false` — which reads as a broken feature flag.
 *
 * CONTRACT: Wait for the BADGE, with headroom. It counts the server's response, so
 * it confirms the PUT landed; returning early races the one-active-cart 500.
 * See [[2026-09-04-web-gateway-integration-design]]
 */
export async function addFirstProductToCart(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: /new arrivals/i })).toBeVisible();

  const addButton = page.locator("app-product-card").first().getByRole("button", { name: /^add$/i });
  await expect(addButton, "no catalogue product offers an Add button").toBeVisible();
  await addButton.click();

  const cartButton = page
    .locator("header button")
    .filter({ has: page.locator("svg.lucide-shopping-bag") });
  await expect(cartButton, "the add never reached the cart").toContainText("1", {
    timeout: CART_WRITE_TIMEOUT_MS,
  });
}
