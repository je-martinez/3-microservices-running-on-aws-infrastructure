// JE-245: the web app against the REAL gateway — sign in, stay signed in across
// a reload, and get evicted from a guarded route without a session.
//
// CONTRACT: These specs need the BACKEND, unlike every other file in this
// folder. `global-setup.ts` skips its health checks whenever every selected
// project is a web one, so a stack that is down surfaces here as a login form
// that does nothing rather than as a named prerequisite failure — which is why
// `signIn` below fails with the status and body the gateway actually returned.
// See [[testing]]

import { expect, request, test, type Browser, type Page } from "@playwright/test";
import { launchWebBrowser } from "../../support/web-browser";
import { makeUser } from "../../support/chance-factory";

const VIEWPORT = { width: 1440, height: 900 };

/** Every route behind `authGuard` in `apps/web/src/app/app.routes.ts`. */
const GUARDED_ROUTES = ["/", "/orders", "/profile", "/checkout"] as const;

interface TestUser {
  readonly email: string;
  readonly password: string;
}

/**
 * Registers a user through the web app's OWN origin, so the account is created
 * over exactly the path the browser will later authenticate on.
 *
 * CONTRACT: Send `X-E2E-Source` — it is what tags the row for `global-teardown`
 * to delete. Users honors it only under its own `E2E_TESTING_ENABLED`, so the
 * header cannot tag anything in a production runtime. Verified live: the
 * register response comes back with `tags: ["E2E Source"]`. See [[testing]]
 */
async function registerUser(baseURL: string): Promise<TestUser> {
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
async function signIn(page: Page, user: TestUser): Promise<void> {
  await page.goto("/login");
  await expect(page.getByRole("heading", { level: 1, name: /welcome back/i })).toBeVisible();

  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
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

test("signing in through the gateway lands the user in the app", async ({ baseURL }) => {
  const user = await registerUser(baseURL!);
  const page = await browser.newPage({ viewport: VIEWPORT, baseURL });

  try {
    await signIn(page, user);

    // The URL alone is satisfied by a blank shell, and home's <h1> alone is
    // satisfied by an unauthenticated render — assert both, plus a product,
    // because the catalogue is the first thing a real token has to buy.
    await expect(
      page,
      "the app did not leave /login. A 401 means the credentials never reached Users; " +
        "staying put with no error means the Sign in button is not wired to submit()",
    ).toHaveURL(/\/$/);

    await expect(page.getByRole("heading", { level: 1, name: /new arrivals/i })).toBeVisible();

    // `GET /v1/products` is authenticated at the gateway, so this only renders
    // when the stored token reached the interceptor and the gateway accepted it.
    await expect(
      page.locator("app-product-card").first(),
      "signed in but the catalogue is empty — GET /v1/products requires auth at the gateway, " +
        "so no cards means the request went out bare or the token was rejected",
    ).toBeVisible();

    await expect(
      page.getByText(/catalogue unavailable|could not load the catalogue/i),
      "the catalogue rendered its error state while signed in",
    ).toHaveCount(0);
  } finally {
    await page.close();
  }
});

/**
 * CONTRACT: RELOAD, never just navigate. The stored token is decrypted
 * asynchronously out of IndexedDB, so on a cold start the in-memory session is
 * empty when the first guard runs — the guard must await rehydration. In-app
 * navigation keeps the session in memory and passes against that bug, so only a
 * full document load reproduces it. See [[2026-09-04-web-gateway-integration-design]]
 */
test("the session survives a reload on a guarded route", async ({ baseURL }) => {
  const user = await registerUser(baseURL!);
  const page = await browser.newPage({ viewport: VIEWPORT, baseURL });

  try {
    await signIn(page, user);
    await expect(page).toHaveURL(/\/$/);

    // In-app navigation first, so the reload below starts from a URL the router
    // reached with a live session — the exact state the bug hides in. `/orders`
    // is reachable only through the account menu, which the header's user button
    // opens.
    await page.locator("header button").filter({ has: page.locator("svg.lucide-user") }).click();
    await page.getByRole("button", { name: /my orders/i }).click();
    await expect(page).toHaveURL(/\/orders$/);
    await expect(page.getByRole("heading", { level: 1, name: /my orders/i })).toBeVisible();

    await page.reload();

    // CONTRACT: Assert the RENDERED screen before the URL. `toHaveURL` retries
    // until it matches, so it passes on the frame before an eviction commits —
    // with the stored token deleted this read /orders and then rendered the
    // login form, and the URL check alone went green against it.
    await expect(
      page.getByRole("heading", { level: 1, name: /my orders/i }),
      "the reload evicted a signed-in user off /orders. authGuard decided before the encrypted " +
        "token finished decrypting from IndexedDB — it must await SessionRehydration.whenSettled(), " +
        "not read SessionStore.isAuthenticated() synchronously",
    ).toBeVisible();

    await expect(page).toHaveURL(/\/orders$/);
  } finally {
    await page.close();
  }
});

// A stored token is what makes the reload above meaningful: without persistence
// the guard would have nothing to rehydrate and the test would pass only because
// the session never left memory. Asserted through the same door the app uses.
test("signing in persists the session to the `auth` IndexedDB database", async ({ baseURL }) => {
  const user = await registerUser(baseURL!);
  const page = await browser.newPage({ viewport: VIEWPORT, baseURL });

  try {
    await signIn(page, user);
    await expect(page).toHaveURL(/\/$/);

    const databases = await page.evaluate(async () =>
      (await indexedDB.databases()).map((db) => db.name ?? ""),
    );

    expect(
      databases,
      `after sign-in the browser holds these IndexedDB databases: ${JSON.stringify(databases)}. ` +
        "Tokens are AES-GCM encrypted into a database named `auth`; nothing is written to " +
        "localStorage, so its absence means the write never happened and a reload signs the user out",
    ).toContain("auth");
  } finally {
    await page.close();
  }
});

for (const route of GUARDED_ROUTES) {
  test(`an anonymous visit to ${route} lands on /login`, async ({ baseURL }) => {
    // A fresh context per route: IndexedDB is per-origin-per-context, so reusing
    // one that a previous test signed into would make every assertion here pass
    // for the wrong reason.
    const page = await browser.newPage({ viewport: VIEWPORT, baseURL });

    try {
      await page.goto(route);

      // The rendered form first, for the same reason as the reload spec above:
      // a retrying URL assertion resolves on whichever frame happens to match.
      await expect(
        page.getByRole("heading", { level: 1, name: /welcome back/i }),
        `${route} did not evict an anonymous visitor. Every page under the app layout sits ` +
          "behind authGuard, and `/` is guarded too because GET /v1/products requires auth " +
          "at the gateway",
      ).toBeVisible();

      await expect(page).toHaveURL(/\/login$/);
    } finally {
      await page.close();
    }
  });
}

/**
 * The cart is server-backed as of JE-245: adding a product issues `PUT /v1/cart`
 * and the drawer renders what came BACK, not what was clicked.
 *
 * CONTRACT: Assert on a field only the server can supply — the price and the
 * item count computed from the response. A local-only cart renders the product's
 * name and a quantity of 1 just as convincingly, so a name-only assertion passes
 * against a drawer that never called the gateway.
 * See [[2026-09-04-web-gateway-integration-design]]
 */
test("adding a product replaces the server cart and the drawer renders the response", async ({
  baseURL,
}) => {
  const user = await registerUser(baseURL!);
  const page = await browser.newPage({ viewport: VIEWPORT, baseURL });

  // Recorded rather than stubbed: this asserts the app really issued the call,
  // and the response body is what the drawer's numbers are checked against.
  const cartWrites: { status: number; body: string }[] = [];
  page.on("response", async (response) => {
    if (response.request().method() !== "PUT" || !response.url().endsWith("/v1/cart")) return;
    cartWrites.push({ status: response.status(), body: await response.text().catch(() => "") });
  });

  try {
    await signIn(page, user);
    await expect(page.locator("app-product-card").first()).toBeVisible();

    const firstCard = page.locator("app-product-card").first();
    const productName = (await firstCard.getByRole("heading", { level: 3 }).innerText()).trim();
    const productPrice = (await firstCard.locator("span").first().innerText()).trim();

    await firstCard.getByRole("button", { name: /^add$/i }).click();

    await expect
      .poll(
        () => cartWrites.length,
        "adding a product issued no PUT /v1/cart — the drawer is still a client-only cart",
      )
      .toBeGreaterThan(0);

    expect(
      cartWrites[0].status,
      `PUT /v1/cart answered ${cartWrites[0].status}: ${cartWrites[0].body.slice(0, 300)}. ` +
        "An empty-bodied 500 is the one-active-cart race (JE-246); a 401 means the token never " +
        "reached the interceptor",
    ).toBe(200);

    // The header badge counts QUANTITIES from the server's response, so it only
    // reads 1 once that response was parsed and applied.
    const cartButton = page
      .locator("header button")
      .filter({ has: page.locator("svg.lucide-shopping-bag") });
    await expect(cartButton).toContainText("1");

    await cartButton.click();

    const drawer = page.locator("app-cart-drawer");
    await expect(drawer).toHaveCount(1);
    await expect(drawer.getByText(productName, { exact: false }).first()).toBeVisible();

    // The money is the server's: `unitPrice.formatted` came back on the PUT and
    // matches the catalogue card only because both are priced by Orders.
    await expect(
      drawer.getByText(productPrice, { exact: false }).first(),
      `the drawer does not show ${productPrice} for ${productName} — the line rendered without ` +
        "the server's priced subtotal",
    ).toBeVisible();

    await expect(
      drawer.getByText(/your cart is empty/i),
      "the drawer shows its empty state after a successful PUT /v1/cart — the response was not " +
        "applied to the store",
    ).toHaveCount(0);
  } finally {
    await page.close();
  }
});
