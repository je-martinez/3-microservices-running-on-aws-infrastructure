// A stored session the backend rejects: on the first load the app must sign the
// user out and land on /login, never on a home page that 401s.
//
// CONTRACT: These specs need the BACKEND, unlike most of this folder. A web-only
// run skips the health checks, so a down stack surfaces as a sign-in that never
// leaves /login, reported by `signIn` itself. See [[testing]]

import { expect, test, type Page, type Route } from "@playwright/test";
import { signInAsNewUser } from "../../support/web-session";

const CATALOGUE_ERROR = /could not load the catalogue/i;

/**
 * Answers every call that carries a token the way the backend does once the
 * session is dead.
 *
 * CONTRACT: Stub the dead session; do NOT try to produce one. The local stack
 * cannot revoke a refresh token or re-mint the pool deterministically mid-test.
 * The bodies mirror the real answers (probed live): the gateway authorizer's
 * `{"message":"Unauthorized"}` and Users' `{"error":"invalid_credentials"}` for a
 * rejected refresh. A different shape tests an error path the app never meets.
 * See [[2026-09-04-web-gateway-integration-design]]
 */
async function killSession(page: Page): Promise<{ refreshCalls: () => number }> {
  let refreshCalls = 0;

  await page.route("**/v1/users/refresh", async (route: Route) => {
    refreshCalls += 1;
    await route.fulfill({
      status: 401,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({ error: "invalid_credentials" }),
    });
  });

  await page.route("**/v1/**", async (route: Route) => {
    if (!route.request().headers()["authorization"]) return route.fallback();
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ message: "Unauthorized" }),
    });
  });

  return { refreshCalls: () => refreshCalls };
}

/**
 * WHY: "Never shown" cannot be read off the final frame, so a MutationObserver
 * installed before the app boots latches the first time the catalogue error
 * renders, however briefly.
 */
async function watchForCatalogueError(page: Page): Promise<void> {
  await page.addInitScript((source: string) => {
    const pattern = new RegExp(source, "i");
    const w = window as unknown as { __catalogueErrorSeen?: boolean };
    w.__catalogueErrorSeen = false;
    new MutationObserver(() => {
      if (!w.__catalogueErrorSeen && pattern.test(document.body?.innerText ?? "")) {
        w.__catalogueErrorSeen = true;
      }
    }).observe(document, { childList: true, subtree: true, characterData: true });
  }, CATALOGUE_ERROR.source);
}

test("a dead session on load signs the user out to /login in ONE reload", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);

  await signInAsNewUser(page, baseURL!);
  await expect(page.getByRole("heading", { level: 1, name: /new arrivals/i })).toBeVisible();

  const { refreshCalls } = await killSession(page);
  await watchForCatalogueError(page);

  await page.reload();

  // CONTRACT: Assert the RENDERED login form before the URL. `toHaveURL` retries,
  // so it can match a frame of /login that guestGuard then bounces back to `/`.
  await expect(
    page.getByRole("heading", { level: 1, name: /welcome back/i }),
    `a dead session did not reach the login form; the page is at ${page.url()}. ` +
      "Staying on `/` with the catalogue error is SignOut.discard() navigating to /login " +
      "while SessionRehydration still reports the boot-time session, so guestGuard " +
      "bounces back — discard() must call rehydration.markRestored(false) first",
  ).toBeVisible({ timeout: 20_000 });

  await expect(page).toHaveURL(/\/login$/);

  expect(
    refreshCalls(),
    "the app reached /login without attempting POST /v1/users/refresh — the 401 stub never " +
      "fired, so this run did not exercise the refresh-failure path it exists to cover",
  ).toBeGreaterThan(0);

  const errorSeen = await page.evaluate(
    () => (window as unknown as { __catalogueErrorSeen?: boolean }).__catalogueErrorSeen,
  );
  expect(
    errorSeen,
    "the home page rendered 'We could not load the catalogue.' before the redirect: a 401 the " +
      "refresh could not recover surfaced as a page error instead of a sign-out",
  ).toBe(false);

  await expect(page.getByText(CATALOGUE_ERROR)).toHaveCount(0);
});
