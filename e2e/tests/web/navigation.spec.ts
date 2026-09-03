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
      errors,
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
    errors,
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
    errors,
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

// CONTRACT: These strings are HARDCODED, never computed from `format-date.ts`.
// An expectation derived from the code under test reimplements the bug it exists
// to catch — a helper regressed to viewer-local rendering would produce a
// matching expectation and pass. See [[testing]]

// CONTRACT: This file runs under TWO non-UTC timezones (`web-projects.ts`) and
// the same literal must hold in both. Local-time rendering read `10:24 am` at
// UTC and `4:24 am` at UTC-6, and this suite passed throughout. See [[testing]]

/**
 * The year asymmetry below is the DESIGN, verified against the Pencil exports:
 * the order timeline carries it (`Aug 15, 2026 · 6:22 pm`), notifications do not
 * (`Aug 12 · 2:30 pm`). "Fixing" one to match the other breaks a frame.
 */
const DATE_SURFACES = [
  {
    name: "orders list — order card",
    path: "/orders",
    // `ord_3kLpQx8vRn`, createdAt 2026-08-15T18:22:41Z, one line.
    text: "Placed Aug 15, 2026 · 1 item",
  },
  {
    name: "order detail — tracking timeline",
    // Its tracking history has the single PLACED step, at the same instant.
    path: "/orders/ord_3kLpQx8vRn",
    text: "Aug 15, 2026 · 6:22 pm",
  },
  {
    name: "profile — member since",
    path: "/profile",
    // CURRENT_USER.createdAt 2026-02-11T15:04:22Z. Month granularity: verified
    // to survive a local-time regression in BOTH zones, so this row asserts the
    // label's shape, not the normalisation. The other three carry that.
    text: "Member since Feb 2026",
  },
] as const;

for (const surface of DATE_SURFACES) {
  test(`${surface.name} renders its date in UTC`, async ({ page }) => {
    await page.goto(surface.path);

    await expect(
      page.getByText(surface.text, { exact: true }).first(),
      `"${surface.text}" not rendered on ${surface.path}. If the text is present but the ` +
        "time differs, formatting has regressed to the viewer's local zone — check that " +
        "apps/web/src/app/shared/date/format-date.ts still normalises to UTC. If the DATE " +
        "differs, a fixture instant changed and this literal needs updating with it.",
    ).toBeVisible();
  });
}

/**
 * The notifications panel is an OVERLAY over `/`, not a route: its frames wrap a
 * Page plus the panel, so it has no URL to `goto`. It is opened here through the
 * real header control the app binds `notificationsClicked` to — asserting
 * against a panel forced open another way would not prove it is reachable.
 */
test("notifications panel renders its date in UTC", async ({ page }) => {
  await page.goto("/");

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
  // 2026-08-12T14:30:05Z. No year, unlike the order timeline above.
  await expect(
    page.getByText("Aug 12 · 2:30 pm", { exact: true }),
    'the panel is open but "Aug 12 · 2:30 pm" is not in it — a differing TIME means ' +
      "formatShortDateTime has regressed to the viewer's local zone",
  ).toBeVisible();
});

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
  test(`the app header spans the viewport on ${route}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
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
test("the bell toggles the notifications panel", async ({ page }) => {
  await page.goto("/");

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

test("the profile button toggles the account menu", async ({ page }) => {
  await page.goto("/");

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
test("opening one panel over another switches between them", async ({ page }) => {
  await page.goto("/");

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
test("a rapid double-click leaves the panel closed, not stranded", async ({ page }) => {
  await page.goto("/");

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
const ROUTES_WITH_HEADER = ["/", "/checkout", "/orders", "/orders/ord_fB6rEjN4uK", "/profile"] as const;

for (const route of ROUTES_WITH_HEADER) {
  test(`the header's controls work on ${route}`, async ({ page }) => {
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
test("the cart button opens the drawer on / and navigates home elsewhere", async ({ page }) => {
  await page.goto("/");

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
test("each named view-transition element is unique per document", async ({ page }) => {
  for (const route of ["/", "/checkout", "/orders", "/profile"] as const) {
    await page.goto(route);
    await expect(page.locator("app-app-header"), `duplicate header on ${route}`).toHaveCount(1);
    await expect(page.locator("app-brand-panel"), `brand panel leaked onto ${route}`).toHaveCount(0);
  }

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
test("the account menu highlights the route it is on", async ({ page }) => {
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
  test(`no horizontal overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 736 });

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
