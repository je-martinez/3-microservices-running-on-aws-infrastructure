// A failed profile save on /profile: the Save Error Banner shows, the edits stay in
// the form, and "Try again" re-sends THOSE edits.
//
// CONTRACT: Needs the BACKEND, unlike most of this folder. A web-only run skips the
// health checks, so a down stack surfaces as a sign-in that never leaves /login,
// reported by `signIn` itself. Point `WEB_BASE_URL` at the container
// (`http://localhost:3004`), whose nginx proxies `/v1/` to the real gateway.
// See [[testing]]

import { expect, test, type Page, type Route } from "@playwright/test";
import { signInAsNewUser } from "../../support/web-session";

/** Headroom for one real `PATCH /v1/users/me` through the gateway. */
const SAVE_TIMEOUT_MS = 20_000;

/**
 * CONTRACT: Stub a 5xx; do NOT try to provoke one. Users cannot be made to fail
 * on demand. It registers no error handler, so an unhandled throw answers with
 * Fastify's default envelope — `{statusCode, message}` was probed live on a 400
 * from this route, `error` is the status label Fastify adds on a 500. A shape
 * `ApiClient` does not parse tests an error path the app never meets.
 * See [[2026-09-04-web-gateway-integration-design]]
 */
const USERS_500_BODY = {
  statusCode: 500,
  error: "Internal Server Error",
  message: "Internal Server Error",
};

/**
 * Fails the next `PATCH /v1/users/me` with a 500 and lets every other call through.
 *
 * WARNING: The glob also matches `GET /v1/users/me`, which the page needs to load —
 * the method filter is what keeps the profile from rendering its load error.
 */
async function failNextSave(
  page: Page,
): Promise<{ hits: () => number; sentFullName: () => unknown }> {
  let hits = 0;
  let sentFullName: unknown;
  await page.route("**/v1/users/me", async (route: Route) => {
    if (route.request().method() !== "PATCH" || hits > 0) return route.fallback();
    hits += 1;
    sentFullName = route.request().postDataJSON()?.fullName;
    await route.fulfill({
      status: 500,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(USERS_500_BODY),
    });
  });
  return { hits: () => hits, sentFullName: () => sentFullName };
}

/** Signs in a fresh user and opens /profile on the panel that holds Save changes. */
async function openProfile(page: Page, baseURL: string): Promise<void> {
  await signInAsNewUser(page, baseURL);
  await expect(page.getByRole("heading", { level: 1, name: /new arrivals/i })).toBeVisible();

  // CONTRACT: Navigate IN-APP and wait for the profile's own GET /v1/users/me
  // before editing. The form renders from the session's cached profile first and
  // reseeds every field when that fetch lands, overwriting an edit typed in
  // between. A `page.goto` reload adds the bootstrap's GET of the same URL, so
  // waiting for "the" GET catches the wrong one and the race stays open.
  const profileFetched = page.waitForResponse(
    (res) => res.url().endsWith("/v1/users/me") && res.request().method() === "GET",
  );
  await page.locator("app-app-header button").filter({ has: page.locator("svg.lucide-user") }).click();
  await page.locator("app-account-menu button", { hasText: "Profile" }).click();
  await expect(page).toHaveURL(/\/profile$/);
  await profileFetched;
  await expect(page.getByRole("heading", { level: 1, name: /profile/i })).toBeVisible();
  await expect(
    fullNameInput(page),
    "the profile never rendered its form — a skeleton stuck on screen means GET " +
      "/v1/users/me never answered",
  ).toBeVisible();

  // CONTRACT: Behind NG_APP_STRIPE_ENABLED the save footer lives in the Delivery
  // address tab's panel, so a build with the flag on needs that tab selected.
  const tabs = page.getByTestId("profile-tabs");
  if ((await tabs.count()) > 0) await page.getByTestId("tab-delivery-address").click();
}

function fullNameInput(page: Page) {
  return page.getByLabel("Full name");
}

function errorBanner(page: Page) {
  return page.getByTestId("profile-save-error-banner");
}

function savedBanner(page: Page) {
  return page.getByTestId("profile-saved-banner");
}

/** Edits Full name and fails its save; returns the value the form must keep. */
async function editAndFailSave(page: Page): Promise<string> {
  const edited = `E2E Retry ${Math.random().toString(36).slice(2, 8)}`;
  await fullNameInput(page).fill(edited);

  const stub = await failNextSave(page);
  await page.getByRole("button", { name: /^save changes$/i }).click();

  // WHY: Without this a stub that never matched passes every assertion below,
  // since an unsent save also leaves the edit in place and no saved banner.
  await expect
    .poll(stub.hits, {
      message: "the stubbed PATCH /v1/users/me was never hit — Save changes did not send a save",
    })
    .toBe(1);
  expect(
    stub.sentFullName(),
    "the failed save did not carry the edit — the form reseeded before Save was clicked",
  ).toBe(edited);

  await expect(
    errorBanner(page),
    "a 500 from PATCH /v1/users/me rendered no Save Error Banner — the failure was swallowed",
  ).toBeVisible();
  await expect(errorBanner(page)).toHaveAttribute("role", "alert");
  await expect(errorBanner(page)).toContainText("Couldn’t save your changes");
  await expect(
    fullNameInput(page),
    "the failed save discarded the edit — the form reseeded from the server's profile",
  ).toHaveValue(edited);
  await expect(savedBanner(page), "a FAILED save showed the Changes saved banner").toHaveCount(0);

  await page.unroute("**/v1/users/me");
  return edited;
}

test.describe("profile save error", () => {
  test("a failed save keeps the edits, and Try again saves them", async ({ page, baseURL }) => {
    await openProfile(page, baseURL!);
    const edited = await editAndFailSave(page);

    const retried = page.waitForResponse(
      (res) => res.url().endsWith("/v1/users/me") && res.request().method() === "PATCH",
      { timeout: SAVE_TIMEOUT_MS },
    );
    await page.getByTestId("profile-save-error-retry").click();
    const res = await retried;
    expect(res.status(), `the retried save failed: ${res.status()} ${await res.text()}`).toBe(200);
    expect(
      res.request().postDataJSON()?.fullName,
      "Try again sent a different fullName than the preserved edit",
    ).toBe(edited);

    await expect(
      errorBanner(page),
      "the Save Error Banner outlived a successful retry",
    ).toHaveCount(0);
    await expect(
      savedBanner(page),
      "a successful retry showed no Changes saved banner",
    ).toBeVisible();

    await page.reload();
    await expect(
      fullNameInput(page),
      "after a reload the profile does not carry the retried edit — the server never stored it",
    ).toHaveValue(edited);
  });

  test("the close button hides the error and keeps the edit", async ({ page, baseURL }) => {
    await openProfile(page, baseURL!);
    const edited = await editAndFailSave(page);

    await page.getByTestId("profile-save-error-dismiss").click();
    await expect(
      errorBanner(page),
      "the Save Error Banner's close button did not hide it",
    ).toHaveCount(0);
    await expect(
      fullNameInput(page),
      "dismissing the Save Error Banner discarded the edit",
    ).toHaveValue(edited);
  });
});
