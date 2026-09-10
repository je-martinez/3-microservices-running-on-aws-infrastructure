// Every route mounts and renders clean, and the chrome around them works.
//
// CONTRACT: Assert on RENDERED CONTENT, never a status code — an SPA serves
// `index.html` for every path, so a deleted route still returns 200. Attach the
// console listener BEFORE `goto`, or load-time errors go uncaught and this spec
// turns decorative. See [[testing]]
//
// CONTRACT: The two route groups are split by their GUARD. `authGuard` covers the
// app layout and `guestGuard` the auth layout, so no single session state can visit
// both — a file-wide `beforeEach` is wrong in one direction or the other.
// See [[2026-09-04-web-gateway-integration-design]]

import { expect, test, type Page } from "@playwright/test";
import {
  addFirstProductToCart,
  CART_WRITE_TIMEOUT_MS,
  signInAsNewUser,
} from "../../support/web-session";

/**
 * The routes behind `authGuard`, with the exact `<h1>` each component renders.
 * A route added to the app layout without an entry here is an unverified screen.
 *
 * CONTRACT: No `/orders/:orderId` row — its heading is an order id minted at
 * checkout, so a fresh user has none to visit. A stale id renders the not-found
 * screen, which has no `<h1>`. That branch has its own test. See [[testing]]
 */
const APP_ROUTES = [
  { path: "/", heading: /new arrivals/i },
  { path: "/checkout", heading: /checkout/i },
  { path: "/orders", heading: /my orders/i },
  { path: "/profile", heading: /profile/i },
] as const;

/** The routes behind `guestGuard` — visited signed OUT, or they redirect to `/`. */
const AUTH_ROUTES = [
  { path: "/login", heading: /welcome back/i },
  { path: "/login/passwordless", heading: /sign in without a password/i },
  { path: "/verify", heading: /check your inbox/i },
  { path: "/register", heading: /create your account/i },
  { path: "/register/passwordless", heading: /sign up with just your email/i },
  { path: "/password/reset", heading: /reset your password/i },
  { path: "/password/new", heading: /set a new password/i },
] as const;

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

for (const route of AUTH_ROUTES) {
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
      errors,
      `console errors on ${route.path}:\n${errors.join("\n") || "(none captured)"}`,
    ).toHaveLength(0);
  });
}

for (const route of APP_ROUTES) {
  test(`${route.path} mounts and renders clean`, async ({ page, baseURL }) => {
    const errors = collectPageErrors(page);

    // CONTRACT: Collect errors from the sign-in navigation too, not just from
    // `route.path`. Listeners attached after signing in would miss anything the
    // login screen and the post-sign-in landing throw, which is most of the
    // session plumbing this suite exercises.
    await signInAsNewUser(page, baseURL!);
    await page.goto(route.path);

    await expect(
      page.getByRole("heading", { level: 1, name: route.heading }),
      `no <h1> matching ${route.heading} on ${route.path} — the route may be missing from ` +
        "app.routes.ts (the ** wildcard would redirect it home), or its screen is still a placeholder",
    ).toBeVisible();

    expect(
      errors,
      `console errors on ${route.path}:\n${errors.join("\n") || "(none captured)"}`,
    ).toHaveLength(0);
  });
}

// The wildcard is the one route whose correct behaviour IS a redirect. Asserts
// the URL *and* home's content — a redirect onto a blank page satisfies the URL
// alone. Signed in, so the landing is home rather than authGuard's /login.
test("an unknown route redirects home", async ({ page, baseURL }) => {
  const errors = collectPageErrors(page);

  await signInAsNewUser(page, baseURL!);
  await page.goto("/no-such-page");

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1, name: /new arrivals/i })).toBeVisible();
  expect(
    errors,
    `console errors on /no-such-page:\n${errors.join("\n") || "(none captured)"}`,
  ).toHaveLength(0);
});

/**
 * CONTRACT: An anonymous visitor is SENT TO /login, not shown the screen. This is
 * the guard itself, and nothing else in this file can fail when it breaks — every
 * other app-route test signs in first, so a deleted `canActivate` leaves them all
 * green. See [[2026-09-04-web-gateway-integration-design]]
 */
for (const route of APP_ROUTES) {
  test(`${route.path} bounces an anonymous visitor to /login`, async ({ page }) => {
    await page.goto(route.path);

    await expect(
      page,
      `${route.path} rendered for a signed-out visitor — authGuard is missing from the app ` +
        "layout in app.routes.ts, or it resolved before session rehydration settled",
    ).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { level: 1, name: /welcome back/i })).toBeVisible();
  });
}

/**
 * The mirror of the rule above, and the reason this file splits its routes:
 * `guestGuard` sends a signed-in visitor away from the auth screens.
 */
test("a signed-in visitor is bounced off /login", async ({ page, baseURL }) => {
  await signInAsNewUser(page, baseURL!);

  await page.goto("/login");

  await expect(
    page,
    "the login form rendered for a signed-in user — guestGuard is missing from the auth layout",
  ).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1, name: /new arrivals/i })).toBeVisible();
});

/**
 * CONTRACT: Click the real link; do NOT `goto` the reset route. The route
 * mounting and the link REACHING it are independent — this control was an
 * `href="#"` while `/password/reset` rendered perfectly, and every mount test
 * above passed against it. An `href="#"` also leaves the URL on `/login` with
 * only a `#` appended, so the URL assertion is what fails first; the heading
 * assertion then rules out a route that resolves to a blank screen.
 * See [[testing]]
 */
test("the forgot-password link on /login reaches the reset screen", async ({ page }) => {
  const errors = collectPageErrors(page);

  await page.goto("/login");
  await expect(page.getByRole("heading", { level: 1, name: /welcome back/i })).toBeVisible();

  await page.getByRole("link", { name: /forgot password/i }).click();

  await expect(
    page,
    "clicking 'Forgot password?' did not navigate — the control is probably still an " +
      "`href=\"#\"` placeholder, or its routerLink points at a path missing from app.routes.ts",
  ).toHaveURL(/\/password\/reset$/);

  await expect(
    page.getByRole("heading", { level: 1, name: /reset your password/i }),
    "the URL is /password/reset but its <h1> did not render — the route resolves to a blank screen",
  ).toBeVisible();

  expect(
    errors,
    `console errors reaching /password/reset:\n${errors.join("\n") || "(none captured)"}`,
  ).toHaveLength(0);
});

// The branch a deep-linked stale URL hits: an explicit empty state, not a crash
// and not a redirect. Signed in, so the 404 comes from Orders rather than from
// authGuard turning this into a trip to /login.
test("an unknown order id renders the not-found state", async ({ page, baseURL }) => {
  const errors = collectPageErrors(page);

  await signInAsNewUser(page, baseURL!);
  await page.goto("/orders/ord_doesNotExist");

  // CONTRACT: Use the cart write's headroom, not the default 5s. This screen waits
  // on `GET /v1/orders/{id}` over the same slow gateway path, so the default sits
  // right on the response time — it passed alone and failed in BOTH projects under
  // a parallel run, looking like a missing empty state. See [[testing]]
  await expect(page.getByText(/order not found/i)).toBeVisible({
    timeout: CART_WRITE_TIMEOUT_MS,
  });

  // CONTRACT: Filter out the 404 this test DELIBERATELY provokes, and nothing else.
  // Chromium logs every failed request as a console error. Dropping the assertion
  // entirely would hide a real crash in the not-found branch. See [[testing]]
  const unexpected = errors.filter((message) => !/ord_doesNotExist/.test(message));
  expect(
    unexpected,
    `console errors on an unknown order, beyond the expected 404:\n${
      unexpected.join("\n") || "(none captured)"
    }`,
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
test("checkout renders exactly one payment path", async ({ page, baseURL }) => {
  await signInAsNewUser(page, baseURL!);
  // CONTRACT: Seed the cart. Both payment paths sit behind `@else if
  // (cart.isEmpty())` in checkout-payment.html, so an empty cart renders neither
  // and this test fails reporting `stripe=false plain=false` — which reads as a
  // broken NG_APP_STRIPE_ENABLED rather than as an empty cart.
  await addFirstProductToCart(page);
  await page.goto("/checkout");

  // Wait for the screen first, so "neither visible" means the flag rendered
  // nothing rather than the page not having mounted.
  await expect(page.getByRole("heading", { level: 1, name: /checkout/i })).toBeVisible();
  // And for the cart to have loaded: the payment branch is chosen only after
  // `cart.loading()` clears, so sampling earlier reads neither path.
  await expect(page.locator("app-cart-line").first()).toBeVisible();

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

// CONTRACT: These strings are HARDCODED, never computed from `format-date.ts`.
// An expectation derived from the code under test reimplements the bug it exists
// to catch — a helper regressed to viewer-local rendering would produce a
// matching expectation and pass. See [[testing]]

// CONTRACT: This file runs under TWO non-UTC timezones (`web-projects.ts`) and
// the same literal must hold in both. Local-time rendering read `10:24 am` at
// UTC and `4:24 am` at UTC-6, and this suite passed throughout. See [[testing]]

/**
 * CONTRACT: Only the notifications panel is asserted against a literal here — it is
 * the one surface whose instant is still a fixture. The order and profile surfaces
 * are server-backed since JE-245, so their instants are minted during the run and
 * there is nothing to hardcode. See [[2026-09-04-web-gateway-integration-design]]
 *
 * The year asymmetry is the DESIGN, per the Pencil exports: the order timeline
 * carries the year, notifications do not.
 */

/**
 * The notifications panel is an OVERLAY over `/`, not a route: its frames wrap a
 * Page plus the panel, so it has no URL to `goto`. It is opened here through the
 * real header control the app binds `notificationsClicked` to — asserting
 * against a panel forced open another way would not prove it is reachable.
 */
test("notifications panel renders its date in UTC", async ({ page, baseURL }) => {
  await signInAsNewUser(page, baseURL!);

  const panel = page.getByRole("heading", { level: 2, name: /notifications/i });
  await expect(panel, "the panel is visible before anything opened it").toBeHidden();

  // The bell: the header's buttons carry no accessible name, so it is located by
  // the lucide icon it renders rather than by role+name.
  await page.locator("header button").filter({ has: page.locator("svg.lucide-bell") }).click();

  await expect(
    panel,
    "the notifications panel did not open — AppHeader's bell emits notificationsClicked, " +
      "bound in home.ts, and Shell renders the panel on overlay.active() === 'notifications'",
  ).toBeVisible();

  // Unread is the default tab; this is `ntf_9kDpXmR3vL`, createdAt
  // 2026-08-12T14:30:05Z. No year, unlike the order timeline.
  await expect(
    page.getByText("Aug 12 · 2:30 pm", { exact: true }),
    'the panel is open but "Aug 12 · 2:30 pm" is not in it — a differing TIME means ' +
      "formatShortDateTime has regressed to the viewer's local zone",
  ).toBeVisible();
});

/**
 * CONTRACT: The notifications test above is the ONLY end-to-end guard on the UTC
 * contract. Do not delete it as "just a fixture assertion" — its instant is fixed
 * and its format shows a TIME OF DAY, which is what makes a local-zone regression
 * visible. Verified by mutation on 2026-09-08.
 *
 * The per-formatter cases live in `apps/web/src/app/shared/date/format-date.spec.ts`,
 * which drives fixed instants under a pinned TZ — cheaper and more exhaustive than a
 * browser. An equality-across-zones check on `Member since` is NOT a substitute: it
 * is month-granularity and passes against that same mutation. See [[testing]]
 */


/**
 * CONTRACT: The brand panel spans the FULL page height, not the viewport's.
 * Its container is `min-h-screen` and grows with the form, so pinning the panel
 * to `h-screen` leaves a strip of page background below it whenever the content
 * overflows — visible on the tallest auth screens at a short viewport, and
 * invisible at a tall one. The viewport here is deliberately short enough to
 * make the longest form overflow. See [[angular-component-authoring]]
 */
const AUTH_ROUTES_WITH_PANEL = [
  "/login",
  "/login/passwordless",
  "/verify",
  "/register",
  "/register/passwordless",
  "/password/new",
] as const;

for (const route of AUTH_ROUTES_WITH_PANEL) {
  test(`the brand panel reaches the bottom of ${route}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 800 });
    await page.goto(route);

    const panel = await page.locator("app-brand-panel").boundingBox();
    const main = await page.locator("main").boundingBox();

    expect(panel, `no brand panel rendered on ${route}`).not.toBeNull();
    expect(
      main!.height - panel!.height,
      `the panel is ${(main!.height - panel!.height).toFixed(1)}px shorter than the page, ` +
        "leaving a background strip under it — the panel is height-pinned instead of stretching",
    ).toBeLessThan(2);
  });
}

/**
 * CONTRACT: A router navigation animates; a direct URL load does not.
 * Every other test here uses `page.goto()`, a full document load the router
 * never sees — so without this one the suite cannot tell a working transition
 * from a missing one. `skipInitialTransition` is what keeps a cold load from
 * fading in on first paint, which reads as slowness.
 * See [[angular-component-authoring]]
 */
test("a router navigation transitions, a direct load does not", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __vt: number }).__vt = 0;
    const doc = document as unknown as { startViewTransition?: (...a: unknown[]) => unknown };
    const original = doc.startViewTransition;
    if (original) {
      doc.startViewTransition = function (this: unknown, ...args: unknown[]) {
        (window as unknown as { __vt: number }).__vt++;
        return original.apply(this, args);
      };
    }
  });

  await page.goto("/register/passwordless");
  const count = () => page.evaluate(() => (window as unknown as { __vt: number }).__vt);

  expect(await count(), "a cold load animated — skipInitialTransition is not taking effect").toBe(0);

  await page.getByRole("link", { name: /back to sign up/i }).click();
  await page.waitForURL("**/register");

  expect(
    await count(),
    "navigating did not start a view transition — withViewTransitions is not wired, " +
      "or the browser lacks the API (Angular then degrades to an instant swap)",
  ).toBeGreaterThan(0);
});

/**
 * CONTRACT: The app header spans the full CONTENT width, measured against
 * `body` — never a hardcoded 1440. `scrollbar-gutter: stable` makes the content
 * box the viewport minus the reserved gutter (1425 of 1440 with classic
 * scrollbars, 1440 with overlay ones), so a literal fails against a correct
 * header. A collapsed host renders a 667px bar.
 * See [[angular-component-authoring]]
 */
for (const route of ["/", "/orders", "/profile", "/checkout"] as const) {
  test(`the app header spans the viewport on ${route}`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInAsNewUser(page, baseURL!);
    await page.goto(route);

    const header = await page.locator("app-app-header header").boundingBox();
    expect(header, `no app header rendered on ${route}`).not.toBeNull();

    const contentWidth = await page.evaluate(() => document.body.getBoundingClientRect().width);
    expect(
      Math.abs(contentWidth - header!.width),
      `the header is ${header!.width.toFixed(0)}px wide inside a ${contentWidth.toFixed(0)}px ` +
        "content box — the host has collapsed to its content instead of filling the page",
    ).toBeLessThan(2);
  });
}

/**
 * The header's own controls, located the same way as the bell above: these
 * buttons carry no accessible name, so role+name cannot reach them.
 */
const bell = (page: Page) =>
  page.locator("header button").filter({ has: page.locator("svg.lucide-bell") });
const profileButton = (page: Page) =>
  page.locator("header button").filter({ has: page.locator("svg.lucide-user") });

/**
 * CONTRACT: Assert visibility on CONTENT INSIDE each panel, never on the
 * `app-notifications-panel` / `app-account-menu` host. Every child of those
 * hosts is `position: fixed`, so the host collapses to a zero-size box and
 * Playwright calls it hidden even while the panel is plainly on screen — the
 * open assertions then fail against perfectly working code. The host element is
 * still the right locator for counting NODES (see the double-click test).
 * See [[testing]]
 */
const notificationsPanel = (page: Page) =>
  page.getByRole("heading", { level: 2, name: /notifications/i });
const accountMenu = (page: Page) => page.getByText("Sign out", { exact: true });

/**
 * CONTRACT: The bell and the profile button TOGGLE their panel. Each panel
 * covers the control that opened it, so without this a second click is a dead
 * click and the only way out is a menu item or the mobile scrim.
 * Both panels animate out over 120ms (`popover-leave`), so assert on HIDDEN
 * rather than detached — `toBeHidden` passes for a removed node too, while a
 * `count()` of 0 races the leave animation and flakes. See [[testing]]
 */
test("the bell toggles the notifications panel", async ({ page, baseURL }) => {
  await signInAsNewUser(page, baseURL!);

  await expect(notificationsPanel(page), "the panel is up before anything opened it").toBeHidden();

  await bell(page).click();
  await expect(
    notificationsPanel(page),
    "the first click did not open the panel — AppHeader's bell emits notificationsClicked, " +
      "bound to overlay.toggleNotifications() in home.html",
  ).toBeVisible();

  await bell(page).click();
  await expect(
    notificationsPanel(page),
    "the panel stayed open on a second click — toggleNotifications must clear `active` when " +
      "it already holds 'notifications', not re-assign it",
  ).toBeHidden();
});

test("the profile button toggles the account menu", async ({ page, baseURL }) => {
  await signInAsNewUser(page, baseURL!);

  await expect(accountMenu(page), "the menu is up before anything opened it").toBeHidden();

  await profileButton(page).click();
  await expect(
    accountMenu(page),
    "the first click did not open the menu — AppHeader's profile button emits profileClicked, " +
      "bound to overlay.toggleAccountMenu() in home.html",
  ).toBeVisible();

  await profileButton(page).click();
  await expect(
    accountMenu(page),
    "the menu stayed open on a second click — toggleAccountMenu must clear `active` when " +
      "it already holds 'account-menu', not re-assign it",
  ).toBeHidden();
});

/**
 * CONTRACT: Opening a panel while a DIFFERENT one is up SWITCHES; it does not
 * close everything. `active` is one discriminated value, so a toggle that
 * negated a boolean per panel would both regress this and make two panels
 * coexistable. This is the case the two tests above cannot catch.
 * See [[angular-component-authoring]]
 */
test("opening one panel over another switches between them", async ({ page, baseURL }) => {
  await signInAsNewUser(page, baseURL!);

  await bell(page).click();
  await expect(notificationsPanel(page)).toBeVisible();

  await profileButton(page).click();
  await expect(
    accountMenu(page),
    "bell → profile did not open the account menu — a toggle comparing anything other than " +
      "the kind treats a foreign `active` as 'open' and closes instead of switching",
  ).toBeVisible();
  await expect(
    notificationsPanel(page),
    "both panels are up at once — `active` holds ONE kind, so this means the toggle stopped " +
      "assigning it",
  ).toBeHidden();

  // And back the other way: the switch must not be one-directional.
  await bell(page).click();
  await expect(notificationsPanel(page)).toBeVisible();
  await expect(accountMenu(page)).toBeHidden();
});

/**
 * CONTRACT: A double-click must not strand a panel. `Shell` removes the host
 * with `@if` while `popover-leave` still runs, so the leaving node lingers for
 * 120ms; re-opening inside that window must still settle with the DOM agreeing
 * with `active`. The waits here are deliberately absent — clicking twice with
 * no delay is the whole point. See [[angular-component-authoring]]
 */
test("a rapid double-click leaves the panel closed, not stranded", async ({ page, baseURL }) => {
  await signInAsNewUser(page, baseURL!);

  await bell(page).dblclick();

  // The HOST here, not the content locator: this asserts the leaving node is
  // gone from the DOM, well past the 120ms that keeps it alive.
  await expect(
    page.locator("app-notifications-panel"),
    "the panel is still in the DOM after a double-click — the leave animation stranded a node, " +
      "leaving the DOM disagreeing with overlay.active()",
  ).toHaveCount(0, { timeout: 2000 });

  // The control still works afterwards: a stranded node would block the re-open.
  await bell(page).click();
  await expect(
    notificationsPanel(page),
    "the bell stopped working after a double-click — state and DOM have diverged",
  ).toBeVisible();
  await expect(
    page.locator("app-notifications-panel"),
    "more than one panel node is mounted — a leaving node survived alongside the new one",
  ).toHaveCount(1);
});

/**
 * CONTRACT: The header's controls work on EVERY route that renders it, not just
 * `/`. The header and its handlers come from `AppLayout`, so a page cannot mount
 * the bar and forget to wire it — which is exactly what `/checkout` did while
 * every other route worked, invisible because each template was self-consistent.
 * Mounting the header without handlers is the regression this guards.
 * See [[angular-component-authoring]]
 */
// CONTRACT: `/orders/:orderId` is absent for the same reason it left APP_ROUTES —
// its id came from the deleted `orders.fixture.ts`. The order-detail route still
// renders the header (it is an AppLayout child), but reaching it needs an order
// this user placed, which is checkout's job and not this file's.
const ROUTES_WITH_HEADER = ["/", "/checkout", "/orders", "/profile"] as const;

for (const route of ROUTES_WITH_HEADER) {
  test(`the header's controls work on ${route}`, async ({ page, baseURL }) => {
    await signInAsNewUser(page, baseURL!);
    await page.goto(route);

    // Exactly one: two layouts nesting, or a page that kept its own copy after
    // the header moved up, both render a duplicate bar that looks almost right.
    await expect(
      page.locator("app-app-header"),
      `expected exactly one header on ${route} — zero means the route sits outside AppLayout, ` +
        "more than one means a page still mounts its own copy alongside the layout's",
    ).toHaveCount(1);

    await bell(page).click();
    await expect(
      notificationsPanel(page),
      `the bell is dead on ${route} — the header renders but nothing is bound to ` +
        "notificationsClicked, which is what AppLayout exists to prevent",
    ).toBeVisible();
    await bell(page).click();
    await expect(notificationsPanel(page)).toBeHidden();

    await profileButton(page).click();
    await expect(
      accountMenu(page),
      `the profile button is dead on ${route} — nothing is bound to profileClicked`,
    ).toBeVisible();
  });
}

/**
 * CONTRACT: The cart button opens the drawer in place on `/` and navigates home
 * from anywhere else. `CartDrawer` mounts in `HomePage` alone, so opening the
 * overlay from another route sets `active` to a panel nothing renders — a dead
 * button and no scrim. `AppLayout.openCart()` is what keeps the two behaviours
 * apart now that one handler serves five routes.
 * See [[angular-component-authoring]]
 */
test("the cart button opens the drawer on / and navigates home elsewhere", async ({ page, baseURL }) => {
  await signInAsNewUser(page, baseURL!);

  const cartButton = page.locator("header button").filter({ has: page.locator("svg.lucide-shopping-bag") });
  await cartButton.click();
  await expect(
    page.locator("app-cart-drawer"),
    "the cart drawer did not open on / — AppLayout.openCart() must call overlay.openCart() " +
      "when already home, not navigate",
  ).toHaveCount(1);
  await expect(page).toHaveURL(/\/$/);

  await page.goto("/orders");
  await cartButton.click();
  await page.waitForURL(/\/$/);
  await expect(
    page.getByRole("heading", { level: 1, name: /new arrivals/i }),
    "the cart button on /orders did not land on home — navigating there is what makes the " +
      "drawer reachable at all, since it mounts only in HomePage",
  ).toBeVisible();
});

/**
 * CONTRACT: The layouts render their chrome ONCE per document. `styles.css`
 * gives `app-app-header`, `app-brand-panel` and `app-mobile-brand-header` a
 * `view-transition-name`, and a duplicate name in one snapshot makes the browser
 * skip the transition entirely rather than fail loudly. See [[angular-component-authoring]]
 */
test("the app layout's named elements are unique per document", async ({ page, baseURL }) => {
  await signInAsNewUser(page, baseURL!);

  for (const route of ["/", "/checkout", "/orders", "/profile"] as const) {
    await page.goto(route);
    await expect(page.locator("app-app-header"), `duplicate header on ${route}`).toHaveCount(1);
    await expect(page.locator("app-brand-panel"), `brand panel leaked onto ${route}`).toHaveCount(0);
  }
});

/**
 * The auth half of the rule above, split off because it must run SIGNED OUT:
 * `guestGuard` redirects a signed-in visitor from `/login` to `/`, where the
 * brand panel legitimately does not exist — so a single signed-in test reads
 * "0 brand panels" and fails against a perfectly correct layout.
 */
test("the auth layout's named elements are unique per document", async ({ page }) => {
  for (const route of ["/login", "/register", "/verify"] as const) {
    await page.goto(route);
    await expect(page.locator("app-brand-panel"), `duplicate brand panel on ${route}`).toHaveCount(1);
    await expect(
      page.locator("app-mobile-brand-header"),
      `duplicate mobile brand header on ${route}`,
    ).toHaveCount(1);
    await expect(page.locator("app-app-header"), `app header leaked onto ${route}`).toHaveCount(0);
  }
});

/**
 * CONTRACT: The account menu's highlight follows the ROUTE, never a static
 * class. The design frame ships `Profile` pre-highlighted; copying that class
 * into the template leaves it lit on `/orders` too, which is what shipped.
 * See [[angular-component-authoring]]
 */
test("the account menu highlights the route it is on", async ({ page, baseURL }) => {
  await signInAsNewUser(page, baseURL!);
  const ACTIVE = /bg-surface-subtle/;
  const item = (name: string) => page.locator("app-account-menu button", { hasText: name });

  const openMenu = async () => {
    await page.locator("app-app-header button").filter({ has: page.locator("svg.lucide-user") }).click();
    await expect(item("Profile")).toBeVisible();
  };

  await page.goto("/profile");
  await openMenu();
  await expect(item("Profile")).toHaveClass(ACTIVE);
  await expect(item("My orders")).not.toHaveClass(ACTIVE);

  // Navigating from inside the menu is the case a static class never survives.
  await item("My orders").click();
  await expect(page).toHaveURL(/\/orders$/);
  await openMenu();
  await expect(item("My orders")).toHaveClass(ACTIVE);
  await expect(item("Profile")).not.toHaveClass(ACTIVE);
});

/**
 * CONTRACT: No route scrolls horizontally at a phone width. `/profile`'s identity
 * card is a row on desktop and a COLUMN on mobile (frame `Mobile — Profile`);
 * shipping only the row put the "Member since" badge — `whitespace-nowrap`, 170px
 * — past the edge, giving a 504px scrollWidth in a 399px viewport.
 * See [[angular-component-authoring]]
 */
for (const width of [414, 390, 375] as const) {
  test(`no horizontal overflow at ${width}px`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 736 });
    await signInAsNewUser(page, baseURL!);

    for (const route of ["/profile", "/orders", "/"] as const) {
      await page.goto(route);
      // CONTRACT: Wait for real content before measuring. `goto` resolves before
      // Angular paints, and an unrendered page's widest element is <html> at
      // exactly the viewport width — so the assertion passes against any layout
      // bug whatsoever. See [[testing]]
      await expect(page.locator("app-app-header header")).toBeVisible();

      // Measure the widest element, not a container's scrollWidth: the overflow
      // is clipped before it reaches `.app-scroll`, so that reads clean while
      // content visibly runs past the edge.
      const worst = await page.evaluate(() => {
        let right = 0;
        let tag = "";
        document.querySelectorAll("*").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.right > right) {
            right = r.right;
            tag = el.tagName.toLowerCase();
          }
        });
        return { right: Math.round(right), viewport: window.innerWidth, tag };
      });
      expect(
        worst.right,
        `${route} overflows at ${width}px: <${worst.tag}> reaches ${worst.right}px in a ${worst.viewport}px viewport`,
      ).toBeLessThanOrEqual(worst.viewport + 1);
    }
  });
}

/**
 * CONTRACT: A product with no image gets a LABELLED placeholder, not a bare
 * surface — an unlabelled box reads as a failed load beside cards that do have
 * artwork.
 *
 * CONTRACT: A SKIP, not a deletion. Every product in `ProductSeed.cs` carries
 * artwork, so this branch is unreachable from the web app; rewriting the assertion
 * to pass would leave a green test proving nothing, and deleting it would lose the
 * record that `product-card.html`'s `@else` is untested end to end. Orders covers
 * the branch in `ProductReadServiceTests`. Give one seed product a null image and
 * the skip comes off. See [[angular-component-authoring]]
 */
test("a product without artwork says so", async ({ page, baseURL }) => {
  await signInAsNewUser(page, baseURL!);

  const cards = page.locator("app-product-card");
  await expect(cards.first()).toBeVisible();

  const withoutArtwork = cards.filter({ hasText: "No image" });
  const count = await withoutArtwork.count();
  test.skip(
    count === 0,
    "no seeded product lacks artwork — every row in ProductSeed.cs carries a ProductImage, " +
      "so the placeholder branch in product-card.html cannot be reached from the web app",
  );

  const card = withoutArtwork.first();
  await expect(card.locator("img"), "a card labelled 'No image' still rendered an <img>").toHaveCount(0);
});

/**
 * CONTRACT: These two numbers are the Users service's, not copy. `reset-code.ts`
 * sets RESET_CODE_TTL_SECONDS=600 and RESET_CODE_LENGTH=6; the 202 from
 * POST /v1/users/password/forgot carries neither, so nothing checks them at
 * runtime and a backend change would leave this screen quietly lying.
 * See [[openapi-specs]]
 */
test("the reset screen states the backend's real code length and expiry", async ({ page }) => {
  await page.goto("/password/reset");

  await expect(
    page.getByText(/6-digit code/i),
    "the code length here must match RESET_CODE_LENGTH in services/users/src/shared/auth/reset-code.ts",
  ).toBeVisible();

  await expect(
    page.getByText(/expires 10 minutes after it is sent/i),
    "the expiry here must match RESET_CODE_TTL_SECONDS (600s) in the same file",
  ).toBeVisible();
});

/**
 * CONTRACT: In-app links use `routerLink`, never `href`. An `href` does a full
 * browser navigation: the SPA reboots and the view transition never runs, which
 * is what "Back to cart" did. The probe survives only a router navigation — a
 * reload wipes it, so `undefined` IS the failure.
 * See [[angular-component-authoring]]
 */
test("in-app links navigate through the router, not by reloading", async ({ page, baseURL }) => {
  await signInAsNewUser(page, baseURL!);
  await page.goto("/checkout");
  await expect(page.getByText(/back to cart/i)).toBeVisible();

  await page.evaluate(() => {
    (window as unknown as { __routed?: boolean }).__routed = true;
  });

  await page.getByText(/back to cart/i).click();
  await expect(page).toHaveURL(/\/$/);

  const survived = await page.evaluate(
    () => (window as unknown as { __routed?: boolean }).__routed,
  );
  expect(
    survived,
    "'Back to cart' reloaded the page instead of routing — it is probably an `href` " +
      "rather than a `routerLink`, so the view transition never runs",
  ).toBe(true);
});

/**
 * CONTRACT: Keeps the rule above enforceable across the whole app, not just the
 * one link that regressed. A new `href="/…"` is the same defect wherever it lands.
 * See [[angular-component-authoring]]
 */
test("no template ships an internal href", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");

  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      return statSync(full).isDirectory() ? walk(full) : full.endsWith(".html") ? [full] : [];
    });

  const offenders = walk(join(process.cwd(), "..", "apps", "web", "src", "app"))
    .filter((file) => /href="(?:\/|#)/.test(readFileSync(file, "utf8")))
    .map((file) => file.replace(/.*apps\/web\//, "apps/web/"));

  expect(
    offenders,
    "these templates use href for in-app navigation; use routerLink so the router " +
      "handles it and the view transition runs",
  ).toEqual([]);
});

/**
 * CONTRACT: The overlay layer paints nothing but must stay clickable. It is the
 * only way to close the cart other than the X, and it carries no background now
 * that the dimming is gone — so a "tidy-up" that deletes the seemingly-empty
 * div takes outside-click dismissal with it.
 * See [[angular-component-authoring]]
 */
test("clicking outside the cart closes it, and nothing dims the page", async ({ page, baseURL }) => {
  await signInAsNewUser(page, baseURL!);
  await page
    .locator("app-app-header button")
    .filter({ has: page.locator("svg.lucide-shopping-bag") })
    .click();
  await expect(page.locator("app-cart-drawer")).toHaveCount(1);

  const painted = await page.evaluate(() => {
    const layer = document.querySelector("app-scrim div");
    if (!layer) throw new Error("no overlay layer rendered — outside-click dismissal is gone");
    return getComputedStyle(layer).backgroundColor;
  });
  expect(painted, "the overlay layer is painting a background; the dimming was removed").toMatch(
    /rgba\(0, 0, 0, 0\)|transparent/,
  );

  await page.locator("app-scrim div").click({ position: { x: 40, y: 300 } });
  await expect(page.locator("app-cart-drawer")).toHaveCount(0);
});
