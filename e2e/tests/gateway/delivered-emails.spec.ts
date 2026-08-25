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

// Screenshots of what the pipeline ACTUALLY DELIVERED — the last hop, not a
// preview render.
//
// ## Why this is not the same thing as screenshotting the templates
//
// A preview render imports the react-email component and renders it with the
// catalog's `sampleProps`. It proves the component compiles and that Ada
// Lovelace's fake order looks right. It cannot prove any of the following, all
// of which sit BETWEEN the component and a real inbox:
//
//   - the producer published the event at all, with the payload the template
//     expects (a renamed field renders "undefined", not an error);
//   - the Lambda's dispatch mapped the event `type` to this template;
//   - `renderTemplate` was called with the EVENT's props rather than the
//     sample ones;
//   - SES → the SMTP relay carried the HTML through intact — inlined styles
//     survive, a <style> block does not, and nothing in the pipeline's own
//     tests would notice a relay that mangled the body.
//
// So these images are captured from `GET /api/v1/message/{ID}` — the bytes
// Mailpit received — and they are the only artifact in the repo that shows the
// rebrand as a recipient sees it.
//
// ## setContent, not Mailpit's web UI
//
// The alternative was to point Playwright at Mailpit's own message view and
// screenshot that. Rejected: that page wraps the email in Mailpit's chrome
// (header bar, tabs, address panel) and renders the body inside an <iframe>,
// so the resulting PNG is a screenshot of a mail CLIENT, not of the email.
// Fetching the raw `HTML` field and rendering it standalone at a 600px viewport
// — the width the layout is built for (`max-width:600px`) — produces exactly
// the pixels the template describes, and nothing else. It is also stable: it
// does not break the day Mailpit changes its UI.
//
// ## The screenshots are an ARTIFACT, the assertions are the test
//
// A spec whose only output is an image is a spec that passes against an empty
// inbox. Every capture below therefore asserts on the delivered HTML first: the
// brand mark (proving the layout survived the relay) and the flow's own data —
// this run's OTP code, this run's order id and total — which is what
// distinguishes "the pipeline rendered MY event" from "the pipeline rendered
// the catalog sample".
//
// Every request path is RELATIVE (no leading slash) — see gateway-client.ts.

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

// Renders one delivered email standalone and writes a full-page PNG.
//
// `setContent` with `waitUntil: "load"` rather than the default: the body
// carries a <style> block and remote-free inline styles, and returning before
// load has settled has produced half-styled captures. Nothing here fetches over
// the network (the templates deliberately ship no remote images — see the note
// in order-created.tsx), so `load` cannot hang on a third party.
async function captureEmail(page: Page, html: string, fileName: string): Promise<string> {
  await page.setViewportSize({ width: EMAIL_WIDTH, height: 800 });
  await page.setContent(html, { waitUntil: "load" });

  const file = path.join(OUT_DIR, fileName);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

// The one assertion every captured email shares: the branded shell arrived.
//
// This is what a relay that stripped the body, or a layout that failed to
// render, would fail — and it is the difference between "an email arrived" and
// "a BRANDED email arrived", which is the whole claim of the rebrand.
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
  // Same fail-fast contract as the other Mailpit specs: global-setup already
  // refuses to run without the stack, and `assertMailpitReachable` names the
  // missing container and the command that starts it (`make bootstrap`). Not a
  // skip — see the long note on that function.
  await assertMailpitReachable();

  fs.mkdirSync(OUT_DIR, { recursive: true });
});

// AUTH_OTP_REQUESTED → "Your one-time code".
//
// Driven exactly as tests/gateway/otp-flow.spec.ts drives it, because that flow
// is already proven to reach the inbox: register through the gateway, ask for a
// code, wait for the mail. The value added here is reading the code out of the
// delivered HTML and asserting the IMAGE shows it — a template that rendered
// the code into an invisible element, or not at all, passes otp-flow.spec.ts
// (which reads the plain-text part) and fails here.
test("captures the delivered OTP email", async ({ page }) => {
  // Must exceed EMAIL_TIMEOUT_MS, or Playwright's 30s default aborts the test
  // WHILE waitForEmailTo is still polling — replacing its diagnosis ("nothing
  // arrived; check the Lambda, the queue url, the mailpit container") with a
  // bare "Test timeout of 30000ms exceeded". Observed exactly that against a
  // stack whose DocumentDB was down: the useful message was the one that got
  // thrown away.
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

  // THIS run's code, taken from the plain-text part and then demanded of the
  // HTML. Going through the text part first is deliberate: it is the same
  // extraction otp-flow.spec.ts uses, so the two specs cannot disagree about
  // what the code is, and it makes the HTML assertion a genuine cross-check
  // rather than a tautology (a regex over the HTML would find any six digits,
  // including a timestamp).
  const code = message.Text.match(/\b(\d{6})\b/)?.[1];
  expect(code, `no 6-digit code in the delivered text part: ${message.Text.slice(0, 200)}`).toBeTruthy();
  expect(
    message.HTML,
    "the OTP code is in the text part but not in the HTML one — the visual email would show no code",
  ).toContain(code!);

  const file = await captureEmail(page, message.HTML, "auth-otp.png");
  console.log(`[delivered] OTP email (code ${code}) → ${file}`);
});

// USER_CREATED → "Welcome to 3MRAI", and ORDER_CREATED → "Order confirmed".
//
// One test for both because one journey produces both: registering is what
// publishes USER_CREATED, and the order placed by the same user publishes
// ORDER_CREATED at the same address. Splitting them would mean walking the
// register → login → order chain twice to capture two emails that a single walk
// already delivers.
//
// Deliberately NOT extended to the five tracking emails: reaching DELIVERED
// requires the ~40s TestMode progression that tracking-flow.spec.ts already
// owns, and re-walking it here to fill the gallery is exactly the "elaborate
// new fixture" this task rules out.
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
  // The Money shape also carries its own pre-formatted string — assert it agrees
  // with the cents-derived figure, so the `.amount`/`.formatted` view is actually
  // covered rather than merely present.
  //
  // Derived with Intl, NOT with the `toFixed(2)` used for the email below: the
  // service builds `Money.Formatted` with "C2" against en-US, which inserts a
  // thousands separator ($1,000.00), while the email template's own formatCents
  // uses toFixed and does not ($1000.00). Comparing `.formatted` against the
  // toFixed string passes for every total under $1000 and then fails on the first
  // order that crosses it — a spurious failure that would read as a service bug.
  // The two formats genuinely differ; each assertion must use its own.
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
