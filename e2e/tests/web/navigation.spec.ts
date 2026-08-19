// Phase-1 web verification (spec D9): every route mounts and renders clean.
//
// ## Why this is the whole verification layer for phase 1
//
// The repo's three-layer rule ([[testing]]) is written for HTTP endpoints, and
// phase 1 ships none — no screen calls the gateway, every screen renders from
// `src/app/fixtures/`. Component unit tests are a deliberate phase-2 decision
// (spec D9), arriving with the logic they would test. So this file is it.
//
// ## The trap this spec exists to avoid
//
// An Angular SPA serves `index.html` for EVERY path, so a 200 proves nothing —
// a route deleted from `app.routes.ts` still "loads", and the wildcard quietly
// redirects it home. Every assertion below is therefore on RENDERED CONTENT
// (the page's own `<h1>`), never on a status code.
//
// ## Two things that make a green run here meaningful
//
//   1. The console listener is attached BEFORE `goto`. Errors thrown during
//      initial load — a failed lazy chunk, an injector error — are missed
//      entirely by a listener attached afterwards, which is the quiet way this
//      spec would become decorative.
//   2. Failures print WHAT arrived, not a count. "expected 0 received 3" cannot
//      distinguish a broken app from a wrong expectation, so every message
//      below carries the actual text.
//
// Headings are asserted against the REAL markup in each component, not guessed
// from the route name: `/` is "New arrivals" (not "Products"), `/checkout` is
// "Checkout" (not "Payment"), `/login` is "Welcome back". A regex invented from
// the URL fails against a perfectly good screen and reads as a broken route.

import { expect, test, type Page } from "@playwright/test";

/**
 * Every route in `apps/web/src/app/app.routes.ts`, with the exact `<h1>` its
 * component renders. Keep in sync with that file — a route added there without
 * an entry here is an unverified screen.
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
  // `/orders/:orderId` renders the ORDER ID as its heading, so this must be an
  // id that exists in `orders.fixture.ts` — an unknown id renders "Order not
  // found." with no <h1> at all, which is a different screen and is covered by
  // its own test below. `ord_fB6rEjN4uK` is the fixture whose tracking reaches
  // all five statuses, so it also exercises the fullest timeline.
  { path: "/orders/ord_fB6rEjN4uK", heading: /ord_fB6rEjN4uK/i },
  { path: "/profile", heading: /profile/i },
] as const;

/**
 * KNOWN DEFECT, deliberately allowed so it masks nothing else.
 *
 * `shared/ui/logo-lockup.ts` renders `url('/img/standalone-logo.png')`, but that
 * asset was never copied out of the Pencil design into `apps/web/public/` —
 * there is no `img/` directory in the app at all. `LogoLockup` sits in the app
 * header, so EVERY screen emits one 404. This spec found it; fixing it means
 * exporting the asset (a web-app change, not a test change), so it is recorded
 * here rather than silently tolerated by a weaker assertion.
 *
 * Scoped to this exact URL on purpose: a blanket "ignore 404s" would also hide
 * the next missing chunk or asset, which is most of what this layer is for.
 * **Delete this once the asset lands** — `expectedFailure` is asserted to still
 * be missing below, so a stale entry fails the run instead of rotting.
 */
const KNOWN_MISSING_ASSET = "/img/standalone-logo.png";

function isKnownMissingAsset(message: string): boolean {
  // Chromium reports a failed subresource as a bare "Failed to load resource:
  // ... 404" with the URL only in the `location`, not in the text — so match on
  // the location the listener records alongside it (see collectPageErrors).
  return message.includes(KNOWN_MISSING_ASSET);
}

/**
 * Attaches the console/pageerror listeners and returns the collected messages.
 *
 * Must be called BEFORE `goto` — see the header note. Returning the live array
 * (rather than a getter) keeps the call sites honest about that ordering: there
 * is nothing to read until after navigation.
 *
 * The message carries `msg.location().url` because Chromium's resource-load
 * errors put the failing URL THERE and not in `msg.text()` — without it every
 * such failure reads as an indistinguishable "Failed to load resource", which
 * is the count-without-cause failure mode this suite is meant to avoid.
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

    // The page's own <h1>. Asserted by role+name so a screen that mounts an
    // empty shell (or that the wildcard silently redirected home) fails here
    // rather than passing on a 200.
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

// The wildcard is a real route entry (`{ path: '**', redirectTo: '' }`) and the
// only one whose correct behaviour is a redirect, so it is asserted on the
// resulting URL *and* on home's content — a redirect that lands on a blank page
// would satisfy the URL alone.
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

// An order id that is not in the fixtures renders the explicit empty state, not
// a crash and not a redirect. Worth its own test because it is the branch a
// deep-linked stale URL actually hits.
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
 * `NG_APP_STRIPE_ENABLED` is BUILD-TIME — `@ngx-env/builder` inlines it into
 * the bundle (apps/web/CLAUDE.md §2b), so ONE RUNNING BUILD CAN ONLY EVER SHOW
 * ONE PATH. This asserts the build under test is internally consistent; it
 * cannot prove both positions are good.
 *
 * Proving both means running this suite twice, REBUILDING AND RESTARTING THE
 * DEV SERVER between runs, because a running server keeps serving the value
 * that was compiled in:
 *
 *   cd apps/web && echo 'NG_APP_STRIPE_ENABLED=false' > .env  # then restart `pnpm web:dev`
 *   pnpm e2e:web
 *   cd apps/web && echo 'NG_APP_STRIPE_ENABLED=true'  > .env  # restart again
 *   pnpm e2e:web
 *
 * Do not try to toggle it at runtime — there is nothing to toggle.
 */
test("checkout renders exactly one payment path", async ({ page }) => {
  await page.goto("/checkout");

  // Wait for the screen itself before probing the branches, so "neither is
  // visible" means the flag showed nothing rather than the page not having
  // mounted yet.
  await expect(page.getByRole("heading", { level: 1, name: /checkout/i })).toBeVisible();

  const stripeVisible = await page.getByTestId("checkout-stripe").isVisible();
  const plainVisible = await page.getByTestId("checkout-plain").isVisible();

  // Exactly one — never both, never neither. A flag position that renders NO
  // payment path at all is precisely the failure a "renders without error"
  // assertion sails straight past.
  expect(
    [stripeVisible, plainVisible].filter(Boolean).length,
    `expected exactly one payment path, got stripe=${stripeVisible} plain=${plainVisible} ` +
      "(both visible = the branch condition is inverted somewhere; neither = the flag " +
      "matched no branch, check NG_APP_STRIPE_ENABLED parsing in core/config/app-config.ts)",
  ).toBe(1);
});

/**
 * Keeps KNOWN_MISSING_ASSET honest.
 *
 * An allowance that outlives the defect is worse than no allowance: it quietly
 * suppresses a real 404 on that URL forever. This asserts the asset is STILL
 * missing, so the day someone exports it this test goes red with an instruction
 * to delete the allowance — rather than the suppression surviving unnoticed.
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
