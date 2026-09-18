// The notification surface in the browser: the bell badge, the panel's two tabs,
// the All screen's three pills, mark-on-enter with the arrival highlight, and the
// live toast an order produces over the WebSocket.

// CONTRACT: The toast specs need `NG_APP_WS_URL` in `apps/web/.env`, mirroring
// WS_URL from `.env.local.web`. Without it the app opens no socket at all and no
// toast can ever appear, which reads as a broken push. See [[env-files]]

// CONTRACT: These specs need the BACKEND, unlike most of this folder. A web-only
// run skips the health checks, so a down stack surfaces as a login form that does
// nothing — hence every helper here reports the gateway's own status and body.
// See [[testing]]

// CONTRACT: Do NOT assert a fresh user has an EMPTY inbox. Registration publishes
// USER_CREATED in-process and the WELCOME row lands in ~2s, so emptiness is a race
// on consumer latency rather than a behaviour.
// See [[2026-09-10-in-app-notifications-design]]
import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
import { pickProductWithStock } from "../../support/catalogue";
import { registerWebUser, signIn, type WebTestUser } from "../../support/web-session";

/** How long a seeded event may take to travel topic → queue → consumer → row. */
const NOTIFICATION_TIMEOUT_MS = 45_000;

/** Mirrors `TOAST_DISMISS_MS` in `apps/web/src/app/core/notifications/toast-queue.ts`. */
const TOAST_DISMISS_MS = 7_000;

/** Registration's own row, which every signed-in user here starts with. */
const WELCOME_TITLE = "Welcome to 3MRAI!";

/** ORDER_CREATED's title. `PLACED` is never a tracking event — see [[testing]]. */
const PLACED_TITLE = "Order placed";

interface NotificationWire {
  id: string;
  type: string;
  title: string;
  read_at: string | null;
}

/**
 * An API context on the WEB APP's OWN ORIGIN, whose nginx proxies `/v1` to the
 * gateway. Same door the browser uses, so a row seeded here is one the page can
 * legitimately see.
 */
async function webApi(baseURL: string, user: WebTestUser): Promise<APIRequestContext> {
  const login = await request.newContext({ baseURL });
  const res = await login.post("/v1/users/login", {
    data: { email: user.email, password: user.password },
  });
  expect(res.status(), `login through the web origin failed: ${res.status()} ${await res.text()}`).toBe(200);
  const body = await res.json();
  await login.dispose();

  const token: string | undefined = body.accessToken ?? body.idToken;
  expect(token, `login returned no token: ${JSON.stringify(body)}`).toBeTruthy();

  return request.newContext({
    baseURL,
    extraHTTPHeaders: {
      Authorization: `Bearer ${token}`,
      "X-E2E-Source": "true",
      "x-e2e-run-id": process.env.E2E_RUN_ID ?? "",
    },
  });
}

/**
 * Polls the inbox until every expected title is stored.
 *
 * CONTRACT: Print the titles that ARRIVED on timeout, never only how many. "got 1
 * of 2" reads the same whether the consumer dropped an event or the expectation is
 * wrong. See [[count-only-assertions-hide-cause]]
 */
async function waitForTitles(api: APIRequestContext, expected: string[]): Promise<NotificationWire[]> {
  const deadline = Date.now() + NOTIFICATION_TIMEOUT_MS;
  let items: NotificationWire[] = [];

  while (Date.now() < deadline) {
    const res = await api.get("/v1/notifications");
    expect(res.status(), `GET /v1/notifications failed: ${await res.text()}`).toBe(200);
    items = (await res.json()).items as NotificationWire[];
    const titles = items.map((item) => item.title);
    if (expected.every((title) => titles.includes(title))) return items;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `timed out after ${NOTIFICATION_TIMEOUT_MS}ms waiting for [${expected.join(", ")}]; ` +
      `arrived: ${JSON.stringify(items.map((i) => ({ title: i.title, read_at: i.read_at })))}`,
  );
}

/**
 * Places a single-line order, whose ORDER_CREATED produces the PLACED row.
 *
 * CONTRACT: No `x-test-mode`. Its four-step cascade keeps pushing rows for ~40s,
 * so every exact assertion on the badge, the dots or the showing toast would be
 * racing an arrival. See [[testing]]
 */
async function placeOrder(api: APIRequestContext): Promise<void> {
  const products = await api.get("/v1/products");
  expect(products.status(), `GET /v1/products failed: ${await products.text()}`).toBe(200);
  const product = pickProductWithStock(await products.json());

  const created = await api.post("/v1/orders", {
    data: { lines: [{ productId: product.id, quantity: 1 }] },
  });
  expect(created.status(), `order creation failed: ${await created.text()}`).toBe(201);
}

/** The header's bell, whose orange dot is the unread badge. */
function bellButton(page: Page) {
  return page.locator("header button").filter({ has: page.locator("svg.lucide-bell") });
}

/** The badge itself — the `bg-brand-orange` dot the bell renders only when unread. */
function bellBadge(page: Page) {
  return bellButton(page).locator("span.bg-brand-orange");
}

/** Every rendered row's title, for a failure message that names what is on screen. */
async function renderedTitles(page: Page): Promise<string[]> {
  return page.locator('[data-testid="notification-row"] .text-body-lg').allInnerTexts();
}

/** The rows currently carrying the unread dot, by title. */
async function dottedTitles(page: Page): Promise<string[]> {
  const rows = page.locator('[data-testid="notification-row"]').filter({
    has: page.locator('[data-testid="unread-dot"]'),
  });
  return rows.locator(".text-body-lg").allInnerTexts();
}

/** Registers, signs in, and waits for the WELCOME row to be stored and readable. */
async function signedInWithWelcome(
  page: Page,
  baseURL: string,
): Promise<{ user: WebTestUser; api: APIRequestContext }> {
  const user = await registerWebUser(baseURL);
  const api = await webApi(baseURL, user);
  await waitForTitles(api, [WELCOME_TITLE]);
  await signIn(page, user);
  return { user, api };
}

test.describe("the notification surface", () => {
  test("the bell badges, the panel lists real rows and its tabs split them", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const { api } = await signedInWithWelcome(page, baseURL!);

    try {
      await expect(
        bellBadge(page),
        "the bell shows no unread dot although the WELCOME row is stored and unread — the " +
          "header reads NotificationsStore.hasUnread(), so nothing here means the initial " +
          "GET /v1/notifications never landed or its unreadCount was dropped",
      ).toBeVisible();

      await bellButton(page).click();
      const panel = page.locator("app-notifications-panel");
      await expect(panel).toHaveCount(1);

      // The Unread tab is the panel's default, and the row must be the REAL one:
      // a title only the service writes proves the list came from the gateway
      // rather than from a local fixture.
      await expect(
        panel.getByText(WELCOME_TITLE),
        `the panel does not show "${WELCOME_TITLE}" under Unread. Rendered: ` +
          `${JSON.stringify(await renderedTitles(page))}`,
      ).toBeVisible();

      // Read is empty until something is marked, and the panel says so in words.
      await panel.getByRole("button", { name: /^read$/i }).click();
      await expect(
        panel.getByText(/no read notifications yet/i),
        `the Read tab is not empty for a user who has read nothing. Rendered: ` +
          `${JSON.stringify(await renderedTitles(page))}`,
      ).toBeVisible();

      // Mark-all moves the same row across the split, which is the assertion that
      // separates a working tab from one rendering `items()` unfiltered.
      await panel.getByRole("button", { name: /mark all as read/i }).click();
      await expect(
        panel.getByText(WELCOME_TITLE),
        `"${WELCOME_TITLE}" did not appear under Read after Mark all as read. Rendered: ` +
          `${JSON.stringify(await renderedTitles(page))}`,
      ).toBeVisible();

      await panel.getByRole("button", { name: /^unread$/i }).click();
      await expect(
        panel.getByText(/you're all caught up/i),
        `the Unread tab still lists rows after Mark all as read. Rendered: ` +
          `${JSON.stringify(await renderedTitles(page))}`,
      ).toBeVisible();

      await expect(
        bellBadge(page),
        "the bell still badges after every row was marked read — the badge must follow the " +
          "server's unreadCount from the PATCH response",
      ).toHaveCount(0);
    } finally {
      await api.dispose();
    }
  });

  test('"View all notifications" lands on /notifications and the three pills filter', async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(150_000);
    const { api } = await signedInWithWelcome(page, baseURL!);

    try {
      // A second row, so "All" has something the single-filter views can drop.
      await placeOrder(api);
      await waitForTitles(api, [WELCOME_TITLE, PLACED_TITLE]);

      await bellButton(page).click();
      await page.locator("app-notifications-panel").getByRole("button", { name: /view all notifications/i }).click();

      await expect(page.getByRole("heading", { level: 1, name: /^notifications$/i })).toBeVisible();
      await expect(page).toHaveURL(/\/notifications$/);

      // All is the default pill here, unlike the panel's Unread-first tabs.
      await expect(page.getByTestId("pill-all")).toHaveAttribute("aria-pressed", "true");
      await expect
        .poll(renderedTitles.bind(null, page), {
          message: "the All pill does not list both stored rows",
          timeout: 15_000,
        })
        .toEqual(expect.arrayContaining([WELCOME_TITLE, PLACED_TITLE]));

      // Entering marked these two read, so Unread must no longer carry them.
      //
      // CONTRACT: Assert their ABSENCE, never that Unread is empty. Any row
      // arriving over the socket mid-test lands here legitimately, so an
      // emptiness check races every later arrival.
      await page.getByTestId("pill-unread").click();
      await expect(page.getByTestId("pill-unread")).toHaveAttribute("aria-pressed", "true");
      await expect
        .poll(renderedTitles.bind(null, page), {
          message: "the Unread pill still lists rows mark-on-enter read",
          timeout: 15_000,
        })
        .not.toEqual(expect.arrayContaining([WELCOME_TITLE, PLACED_TITLE]));

      await page.getByTestId("pill-read").click();
      await expect(page.getByTestId("pill-read")).toHaveAttribute("aria-pressed", "true");
      await expect
        .poll(renderedTitles.bind(null, page), {
          message: "the Read pill does not list the rows mark-on-enter just read",
          timeout: 15_000,
        })
        .toEqual(expect.arrayContaining([WELCOME_TITLE, PLACED_TITLE]));

      // The date grouping is derived from `createdAt`, so rows minted seconds ago
      // must land under TODAY — a server-sent bucket would be the alternative.
      await expect(page.getByTestId("group-label").first()).toHaveText("TODAY");
    } finally {
      await api.dispose();
    }
  });

  /**
   * The approved arrival-highlight behaviour, and the reason it looks contradictory:
   * entering the All screen PATCHes every unread row read — the badge clears — while
   * those same rows keep their dot for the rest of the visit, which is what reconciles
   * the frame's unread rows with its "Mark all as read" button.
   *
   * CONTRACT: Assert BOTH halves in one test. Each alone passes against the wrong
   * build — dots-only passes when the PATCH never fires, badge-only passes when the
   * highlight is dropped. See [[2026-09-10-in-app-notifications-design]]
   */
  test("entering /notifications clears the badge while the dots survive the visit", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(150_000);
    const { api } = await signedInWithWelcome(page, baseURL!);

    try {
      // One more row, and a quiescent inbox — see `placeOrder` for why the three
      // exact assertions below need the cascade to stay switched off.
      await placeOrder(api);
      await waitForTitles(api, [WELCOME_TITLE, PLACED_TITLE]);

      await page.goto("/notifications");
      await expect(page.getByRole("heading", { level: 1, name: /^notifications$/i })).toBeVisible();

      await expect
        .poll(renderedTitles.bind(null, page), {
          message: "the All screen rendered no rows for a user with two stored notifications",
          timeout: 15_000,
        })
        .toEqual(expect.arrayContaining([WELCOME_TITLE, PLACED_TITLE]));

      // Half one: the server was told, so the header badge goes.
      await expect(
        bellBadge(page),
        `the bell still badges on /notifications — mark-on-enter did not send its PATCH. ` +
          `Rows on screen: ${JSON.stringify(await renderedTitles(page))}`,
      ).toHaveCount(0);

      // Half two: the rows the visit found unread keep their dot regardless.
      expect(
        await dottedTitles(page),
        `the arrival dots vanished on entering /notifications. Every row rendered: ` +
          `${JSON.stringify(await renderedTitles(page))}. The store holds the ids that were ` +
          "unread on entry in `highlighted`, and NotificationItem must keep the dot for them " +
          "even once `readAt` is stamped",
      ).toEqual(expect.arrayContaining([WELCOME_TITLE, PLACED_TITLE]));

      // The subtitle is the server's own arithmetic, so it corroborates the PATCH
      // from a second source rather than from the same signal as the badge.
      await expect(page.getByTestId("page-sub")).toHaveText(/0 unread ·/);

      // A reload ends the visit: `highlighted` is client-only, so these render read.
      await page.reload();
      await expect(page.getByRole("heading", { level: 1, name: /^notifications$/i })).toBeVisible();
      await expect
        .poll(renderedTitles.bind(null, page), {
          message: "the All screen rendered no rows after a reload",
          timeout: 15_000,
        })
        .toEqual(expect.arrayContaining([WELCOME_TITLE, PLACED_TITLE]));

      expect(
        await dottedTitles(page),
        `rows still carry the arrival dot after a reload. On screen: ` +
          `${JSON.stringify(await renderedTitles(page))}. The highlight is cleared on leave, so a ` +
          "fresh load must render every one of these as read",
      ).toEqual([]);
    } finally {
      await api.dispose();
    }
  });

  /**
   * The live path: SNS → the queue → the consumer → the WebSocket → `ToastQueue`.
   * Nothing polls — the toast appears only because a frame arrived.
   *
   * CONTRACT: Hold the hover past the dismiss window and assert the toast is STILL
   * THERE, never time its disappearance. The pause is what is under test, and a
   * precise-timing assertion on a 7s timer only generates flakes. See [[testing]]
   */
  test("placing an order raises a toast, and hovering it outlives the dismiss window", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(180_000);
    const { api } = await signedInWithWelcome(page, baseURL!);

    try {
      // Home, so the page is settled and the socket is open before the event fires.
      await expect(page.getByRole("heading", { level: 1, name: /new arrivals/i })).toBeVisible();

      await placeOrder(api);

      const toast = page.locator('[data-testid="toast"]');
      await expect(
        toast,
        "no toast appeared within 45s of placing an order. NG_APP_WS_URL must be set in " +
          "apps/web/.env or the app opens no socket at all; the socket itself connects in " +
          "AppLayout behind authGuard, so nothing here means either the frame never arrived " +
          "or NotificationsSocket dropped it as unrecognised",
      ).toBeVisible({ timeout: NOTIFICATION_TIMEOUT_MS });

      // The title is the one the service writes for ORDER_CREATED, and the eyebrow
      // proves the type came through — a WELCOME toast would read "WELCOME".
      await expect(toast.getByTestId("toast-eyebrow")).toHaveText("ORDER UPDATE");
      await expect(
        toast.getByText(PLACED_TITLE),
        `the toast does not read "${PLACED_TITLE}". On screen: ` +
          `${JSON.stringify((await toast.allInnerTexts()).join(" | "))}`,
      ).toBeVisible();

      // Hover before the window elapses, then hold well past it. The title check
      // below is what distinguishes a held toast from a successor that took the
      // slot — a bare visibility check cannot tell those apart.
      await toast.hover();
      await expect(toast.getByTestId("toast-progress")).toHaveAttribute("data-paused", "true");

      await page.waitForTimeout(TOAST_DISMISS_MS + 3_000);

      const heldTitles = await toast.locator(".text-body-lg").allInnerTexts();
      expect(
        heldTitles,
        `after ${TOAST_DISMISS_MS + 3_000}ms of unbroken hover the toast on screen reads ` +
          `${JSON.stringify(heldTitles)} instead of ["${PLACED_TITLE}"]. An empty array means the ` +
          "hover never paused ToastQueue's timer; a different title means the held toast was " +
          "dismissed and a queued one took the slot",
      ).toEqual([PLACED_TITLE]);

      // Releasing the hover restarts the BANKED remainder, so the same toast goes.
      await page.mouse.move(0, 0);
      await expect(
        toast.getByText(PLACED_TITLE),
        `"${PLACED_TITLE}" is still on screen long after the hover ended — resume() never ` +
          "re-armed the timer, so a toast that is hovered once never closes again",
      ).toHaveCount(0, { timeout: TOAST_DISMISS_MS + 10_000 });
    } finally {
      await api.dispose();
    }
  });
});
