import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";
import { gatewayClient } from "../../support/gateway-client.js";
import { makeUser } from "../../support/chance-factory.js";
import {
  assertMailpitReachable,
  waitForEmailTo,
  getMessage,
} from "../../support/mailpit-client.js";

// CONTRACT: Screenshots from Mailpit HTML — proves full pipeline, not preview sampleProps.
// WHY: setContent at 600px viewport; assertions on brand + this-run data precede capture.
// See [[testing]]

//: Where the PNGs land. `e2e/screenshots/` is gitignored: these are the OUTPUT
// of the run, inspected by a human, not a committed baseline.
const OUT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../screenshots/delivered",
);

//: The width the email layout is designed for — `max-width:600px` in
// components/layout.tsx. Rendering wider would letterbox the email inside a
// blank page and hide exactly the kind of layout break these images exist to
// reveal.
const EMAIL_WIDTH = 600;

//: Delivery crosses producer → SQS → Lambda → SES → Mailpit and was measured at
// 0.5-1.8s locally. 45s is that with generous room for a cold Lambda, bounded
// for the same reason every other wait in this suite is.
const EMAIL_TIMEOUT_MS = 45_000;

//: The text lockup in components/layout.tsx renders as two adjacent <span>s,
// "3M" (white) + "RAI" (orange). Asserted as the two halves rather than the
// string "3MRAI", which does NOT appear contiguously in the HTML.
const BRAND_SPANS = ["3M", "RAI"];

// WHY: setContent waitUntil load — half-styled capture if styles not settled.
async function captureEmail(page: Page, html: string, fileName: string): Promise<string> {
  await page.setViewportSize({ width: EMAIL_WIDTH, height: 800 });
  await page.setContent(html, { waitUntil: "load" });

  const file = path.join(OUT_DIR, fileName);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

// Assert branded shell + inline styles survived relay (not just plain text).
function expectBrandedShell(html: string, what: string): void {
  for (const span of BRAND_SPANS) {
    expect(html, `${what}: the "${span}" half of the brand lockup is missing`).toContain(span);
  }
  // The header band's navy. Present only as an inlined `background-color`, so it
  // is also the proof that inline styles survived the SES → SMTP hop: a relay
  // that dropped them would still deliver the brand TEXT and lose this.
  expect(html, `${what}: the brand navy is absent — were inline styles stripped?`).toContain(
    "rgb(45,55,72)",
  );
  // A template rendered with a prop the handler never passed prints the literal
  // string. Cheap to check, and it is the single most likely rebrand regression.
  expect(html, `${what}: the rendered body contains "undefined"`).not.toContain("undefined");
}

test.beforeAll(async () => {
  await assertMailpitReachable();

  fs.mkdirSync(OUT_DIR, { recursive: true });
});

// OTP screenshot — asserts code visible in HTML, not just plain-text (otp-flow.spec.ts).
test("captures the delivered OTP email", async ({ page }) => {
  // CONTRACT: test.setTimeout must exceed EMAIL_TIMEOUT_MS or Playwright aborts
  // waitForEmailTo and drops its diagnostic message.
  test.setTimeout(EMAIL_TIMEOUT_MS + 30_000);

  const api = await gatewayClient(); // public routes; no token needed
  const user = makeUser();

  const reg = await api.post("v1/users/register", { data: user });
  expect(reg.status(), `register failed: ${await reg.text()}`).toBe(201);

  const start = await api.post("v1/users/otp/start", { data: { email: user.email } });
  expect(start.status()).toBe(200);

  const [summary] = await waitForEmailTo(user.email, {
    timeoutMs: EMAIL_TIMEOUT_MS,
    matching: (m) => m.Subject === "Your one-time code",
    description: 'the "Your one-time code" email',
  });
  const message = await getMessage(summary.ID);

  expectBrandedShell(message.HTML, "OTP email");

  // Cross-check: code from text part must appear in HTML (not any six digits in markup).
  const code = message.Text.match(/\b(\d{6})\b/)?.[1];
  expect(code, `no 6-digit code in the delivered text part: ${message.Text.slice(0, 200)}`).toBeTruthy();
  expect(
    message.HTML,
    "the OTP code is in the text part but not in the HTML one — the visual email would show no code",
  ).toContain(code!);

  const file = await captureEmail(page, message.HTML, "auth-otp.png");
  console.log(`[delivered] OTP email (code ${code}) → ${file}`);
});

// Welcome + order confirmation from one register→order journey (tracking emails omitted).
test("captures the delivered welcome and order-confirmation emails", async ({ page }) => {
  // Register → login → catalogue → order, plus two inbox waits. Comfortably
  // beyond Playwright's 30s default.
  test.setTimeout(EMAIL_TIMEOUT_MS + 90_000);

  const anon = await gatewayClient();
  const user = makeUser();

  const reg = await anon.post("v1/users/register", { data: user });
  expect(reg.status(), `register failed: ${await reg.text()}`).toBe(201);

  const login = await anon.post("v1/users/login", {
    data: { email: user.email, password: user.password },
  });
  expect(login.status(), `login failed: ${await login.text()}`).toBe(200);
  const body = await login.json();
  // accessToken with idToken as the fallback, same as support/auth.ts.
  const token = body.accessToken ?? body.idToken;
  expect(token, `login returned no token: ${JSON.stringify(body)}`).toBeTruthy();

  const api = await gatewayClient(token);

  const products = await api.get("v1/products");
  expect(products.status()).toBe(200);
  const catalogue = await products.json();
  const product = catalogue.find((p: { unitsInStock: number }) => p.unitsInStock > 0);
  expect(product, "no product with stock in the catalogue").toBeTruthy();

  const created = await api.post("v1/orders", {
    data: { lines: [{ productId: product.id, quantity: 2 }] },
  });
  expect(created.status(), `order creation failed: ${await created.text()}`).toBe(201);
  const order = await created.json();
  expect(order.id).toMatch(/^ord_/);

  // Both emails at once (minCount), not two sequential waits: they are produced
  // by two different services concurrently and arrive in no guaranteed order, so
  // waiting for them one after the other is only a slower way to wait for both.
  const inbox = await waitForEmailTo(user.email, {
    minCount: 2,
    timeoutMs: EMAIL_TIMEOUT_MS,
    description: "the welcome and order-confirmation emails",
  });
  const subjects = inbox.map((m) => `"${m.Subject}"`).join(", ");

  // --- USER_CREATED ---------------------------------------------------------
  const welcomeSummary = inbox.find((m) => m.Subject === "Welcome to 3MRAI");
  expect(welcomeSummary, `no welcome email among: ${subjects}`).toBeTruthy();
  const welcome = await getMessage(welcomeSummary!.ID);

  expectBrandedShell(welcome.HTML, "welcome email");
  // The registered address, which is what proves the template received the
  // EVENT's payload: the catalog's sampleProps say "ada@example.com", so a
  // handler rendering the sample would satisfy the subject check and fail here.
  expect(
    welcome.HTML,
    "the welcome email does not name this user's address — rendered from sample props?",
  ).toContain(user.email);

  const welcomeFile = await captureEmail(page, welcome.HTML, "user-created-welcome.png");
  console.log(`[delivered] welcome email (${user.email}) → ${welcomeFile}`);

  // --- ORDER_CREATED --------------------------------------------------------
  const orderSummary = inbox.find((m) => m.Subject === "Order confirmed");
  expect(orderSummary, `no order confirmation among: ${subjects}`).toBeTruthy();
  const confirmation = await getMessage(orderSummary!.ID);

  expectBrandedShell(confirmation.HTML, "order confirmation");
  expect(
    confirmation.HTML,
    "the order email does not name this order — rendered from sample props?",
  ).toContain(order.id);

  // The money figure, formatted the way the template formats it
  // (emails/order-created.tsx `formatCents`: cents / 100, two decimals). This is
  // the assertion the task calls for — the order TOTAL, not merely the id — and
  // it is what would catch a receipt that rendered the sample's $47.39 while
  // naming the right order.
  const totalCents = order.total?.cents;
  expect(
    typeof totalCents,
    `the order response carries no numeric total.cents to check against: ${JSON.stringify(order).slice(0, 300)}`,
  ).toBe("number");
  const formattedTotal = `$${(totalCents / 100).toFixed(2)}`;
  // WHY: order.total.formatted uses Intl (thousands sep); email uses toFixed — compare separately.
  const moneyFormattedTotal = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(totalCents / 100);
  expect(
    order.total.formatted,
    `order.total.formatted disagrees with cents-derived ${moneyFormattedTotal}`,
  ).toBe(moneyFormattedTotal);
  expect(
    confirmation.HTML,
    `the order email does not show this order's total (${formattedTotal})`,
  ).toContain(formattedTotal);

  const orderFile = await captureEmail(page, confirmation.HTML, "order-created.png");
  console.log(`[delivered] order confirmation (${order.id}, ${formattedTotal}) → ${orderFile}`);
});
