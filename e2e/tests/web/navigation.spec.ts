// Phase-1 web verification (spec D9): every route mounts and renders clean.
// This is the whole verification layer for phase 1 — no screen calls the
// gateway, and component unit tests arrive in phase 2 with the logic they test.
//
// CONTRACT: Assert on RENDERED CONTENT, never a status code — an Angular SPA
// serves `index.html` for every path, so a route deleted from `app.routes.ts`
// still returns 200 while the wildcard redirects it home. Attach the console
// listener BEFORE `goto`, or errors thrown during initial load go uncaught and
// this spec turns decorative. Print WHAT arrived on failure, not a count.
// Headings come from each component's real markup, not from the route name.
// See [[testing]]

import { expect, test, type Page } from "@playwright/test";

/**
 * Every route in `apps/web/src/app/app.routes.ts`, with the exact `<h1>` its
 * component renders. A route added there without an entry here is an
 * unverified screen.
 */
const ROUTES = [
  { path: "/", heading: /new arrivals/i },
  { path: "/login", heading: /welcome back/i },
  { path: "/login/passwordless", heading: /sign in without a password/i },
  { path: "/verify", heading: /check your inbox/i },
  { path: "/register", heading: /create your account/i },
  { path: "/register/passwordless", heading: /sign up with just your email/i },
  { path: "/password/new", heading: /set a new password/i },
  { path: "/checkout", heading: /checkout/i },
  { path: "/orders", heading: /my orders/i },
  // This id must exist in `orders.fixture.ts` — the heading IS the order id, and
  // an unknown one renders the not-found screen with no <h1> (own test below).
  { path: "/orders/ord_fB6rEjN4uK", heading: /ord_fB6rEjN4uK/i },
  { path: "/profile", heading: /profile/i },
] as const;

/**
 * KNOWN DEFECT: `logo-lockup.ts` requests this asset, which is absent from
 * `apps/web/public/`, so every screen emits one 404.
 *
 * CONTRACT: Keep the allowance scoped to this exact URL. A blanket "ignore 404s"
 * hides the next missing chunk, which is most of what this layer catches. The
 * test below asserts the asset is STILL missing, so the allowance fails loudly
 * instead of rotting once someone exports it. See [[testing]]
 */
const KNOWN_MISSING_ASSET = "/img/standalone-logo.png";

function isKnownMissingAsset(message: string): boolean {
  // Chromium puts a failed subresource's URL in `location`, not in the message
  // text, so this matches what collectPageErrors appends from there.
  return message.includes(KNOWN_MISSING_ASSET);
}

/**
 * Attaches the console/pageerror listeners and returns the collected messages.
 *
 * CONTRACT: Call this BEFORE `goto`, and keep `msg.location().url` in the
 * message. Chromium puts a resource-load failure's URL there, not in
 * `msg.text()`, so dropping it makes every such error an indistinguishable
 * "Failed to load resource". See [[testing]]
 */
function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const { url } = msg.location();
    errors.push(`console.error: ${msg.text()}${url ? ` [${url}]` : ""}`);
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

/** Errors this suite treats as real — the known asset 404 filtered out. */
function unexpectedErrors(errors: string[]): string[] {
  return errors.filter((message) => !isKnownMissingAsset(message));
}

for (const route of ROUTES) {
  test(`${route.path} mounts and renders clean`, async ({ page }) => {
    const errors = collectPageErrors(page);

    await page.goto(route.path);

    // By role+name, so an empty shell or a silent wildcard redirect fails here.
    await expect(
      page.getByRole("heading", { level: 1, name: route.heading }),
      `no <h1> matching ${route.heading} on ${route.path} — the route may be missing from ` +
        "app.routes.ts (the ** wildcard would redirect it home), or its screen is still a placeholder",
    ).toBeVisible();

    expect(
      unexpectedErrors(errors),
      `console errors on ${route.path}:\n${errors.join("\n") || "(none captured)"}`,
    ).toHaveLength(0);
  });
}

// The wildcard is the one route whose correct behaviour IS a redirect, so this
// asserts the URL *and* home's content — a redirect onto a blank page satisfies
// the URL alone.
test("an unknown route redirects home", async ({ page }) => {
  const errors = collectPageErrors(page);

  await page.goto("/no-such-page");

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1, name: /new arrivals/i })).toBeVisible();
  expect(
    unexpectedErrors(errors),
    `console errors on /no-such-page:\n${errors.join("\n") || "(none captured)"}`,
  ).toHaveLength(0);
});

// The branch a deep-linked stale URL hits: an explicit empty state, not a crash
// and not a redirect.
test("an unknown order id renders the not-found state", async ({ page }) => {
  const errors = collectPageErrors(page);

  await page.goto("/orders/ord_doesNotExist");

  await expect(page.getByText(/order not found/i)).toBeVisible();
  expect(
    unexpectedErrors(errors),
    `console errors on an unknown order:\n${errors.join("\n") || "(none captured)"}`,
  ).toHaveLength(0);
});

/**
 * CONTRACT: `NG_APP_STRIPE_ENABLED` is BUILD-TIME — `@ngx-env/builder` inlines
 * it, so one running build shows one path and there is nothing to toggle at
 * runtime. This proves the build under test is internally consistent, not that
 * both flag positions are good; covering both means rewriting `apps/web/.env`
 * and RESTARTING `pnpm web:dev` between two runs of this suite.
 * See [[env-files]]
 */
test("checkout renders exactly one payment path", async ({ page }) => {
  await page.goto("/checkout");

  // Wait for the screen first, so "neither visible" means the flag rendered
  // nothing rather than the page not having mounted.
  await expect(page.getByRole("heading", { level: 1, name: /checkout/i })).toBeVisible();

  const stripeVisible = await page.getByTestId("checkout-stripe").isVisible();
  const plainVisible = await page.getByTestId("checkout-plain").isVisible();

  // Exactly one — a flag position rendering NO payment path is the failure a
  // "renders without error" assertion sails straight past.
  expect(
    [stripeVisible, plainVisible].filter(Boolean).length,
    `expected exactly one payment path, got stripe=${stripeVisible} plain=${plainVisible} ` +
      "(both visible = the branch condition is inverted somewhere; neither = the flag " +
      "matched no branch, check NG_APP_STRIPE_ENABLED parsing in core/config/app-config.ts)",
  ).toBe(1);
});

/**
 * CONTRACT: Keeps KNOWN_MISSING_ASSET honest. An allowance outliving its defect
 * suppresses a real 404 on that URL forever, so this goes red the day the asset
 * lands, carrying the instruction to delete the allowance. See [[testing]]
 */
test("the known-missing logo asset is still missing (delete the allowance when it lands)", async ({
  request,
  baseURL,
}) => {
  const response = await request.get(`${baseURL}${KNOWN_MISSING_ASSET}`);

  expect(
    response.status(),
    `${KNOWN_MISSING_ASSET} now returns ${response.status()}. If it is 200 the asset has been ` +
      "added: remove KNOWN_MISSING_ASSET, isKnownMissingAsset, unexpectedErrors and this test, " +
      "and assert on the raw `errors` array again.",
  ).toBe(404);
});
