---
title: "Stripe Payments — Saved Cards and Real Charges"
type: spec
area: shared
status: draft
created: 2026-09-19
updated: 2026-09-22
tags: [type/spec, area/shared, status/draft]
related:
  - "[[users-service-design]]"
  - "[[testing]]"
  - "[[env-files]]"
  - "[[money-representation]]"
  - "[[money-as-integer-cents]]"
  - "[[local-dev]]"
  - "[[logging-context]]"
  - "[[git-workflow]]"
  - "[[soft-delete]]"
  - "[[audit-fields]]"
  - "[[openapi-specs]]"
  - "[[angular-component-authoring]]"
  - "[[cqrs]]"
  - "[[nano-id]]"
  - "[[phase-c-review-flow]]"
  - "[[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]]"
  - "[[skills-catalog]]"
  - "[[code-comments]]"
  - "[[stripe-sandbox-setup]]"
  - "[[browser-rum]]"
propagates-to:
  - "[[users-service-design]]"
  - "[[testing]]"
  - "[[env-files]]"
  - "[[money-representation]]"
  - "[[local-dev]]"
  - "[[logging-context]]"
  - "[[angular-component-authoring]]"
  - "[[browser-rum]]"
---

# Stripe Payments — Saved Cards and Real Charges

> [!info] Validated against Stripe's official agent skill
> This spec's Stripe-specific choices (Payment Element, restricted API keys, dynamic payment
> methods, sandbox usage, pinned versions, CSP, webhook IP allowlisting, PaymentIntents vs.
> Checkout Sessions) were checked against Stripe's own `stripe-best-practices` agent skill,
> installed in this repo at `.claude/skills/stripe-best-practices/` and pinned in
> `skills-lock.json`. See "Tooling" below.

## Summary

This milestone turns the already-existing `NG_APP_STRIPE_ENABLED` flag from a static UI
swap into a real integration: saved cards on Users, real charges on Orders, and a saved-card
checkout flow on the web app. It is large enough that its implementation plan splits into
chainable issues with dependency gates, reviewed in batches per [[phase-c-review-flow]].

## Context

`NG_APP_STRIPE_ENABLED` exists today in `apps/web/src/app/core/config/app-config.ts`,
`.env.example:57`, and `docker-compose.yml:393` (default `false`), but it only swaps a static
"Powered by Stripe" card at `apps/web/src/app/features/checkout/checkout-payment.html:259`
for the plain card-fields branch. No code calls Stripe.

Users creates users in two command handlers — `services/users/src/users/commands/register.command.ts:96`
and `register-passwordless.command.ts:97` — and already has a precedent for storing a
third-party snapshot: `UsersCognitoData`'s `rawPayload Json` column, reused here for Stripe.

Orders (.NET) does not charge anything today; the web's `pay()` just `POST`s `/orders`. Orders
already reaches Users over gRPC (`USERS_GRPC_URL`, `INTERNAL_API_KEY`, `proto/users.proto`,
`rpc GetUserById` returning `UserResponse`), and knows the caller only as `cognitoSub` via
`x-user-id` (`CallerContextMiddleware.cs`).

The repo's E2E tagging mechanism — a row tagged `"E2E Source"` only when the request carries
`x-e2e-source: true` AND the service's `E2E_TESTING_ENABLED` flag is on, both mandatory,
documented in [[testing]] ("E2E cleanup by tag") — extends into this design rather than being
reinvented. `docker-compose.yml` already uses `profiles:` for optional services
(`observability`, `preview`), and this design adds one more.

## Decisions

### 1. Ownership split
Users owns the Stripe customer and its payment methods; Orders owns the charge. The customer
is created and cards are managed on Users; the PaymentIntent is created on Orders.

### 2. Lazy customer creation
`User.stripeCustomerId` starts `null` and is created on first use — first checkout with the
flag on, or first card added — via a single idempotent `ensureStripeCustomer` helper, not
during registration.

Creating the customer synchronously inside `register.command.ts` would put a third-party
network call on the critical path of sign-up: a Stripe outage would then block registration
for users who may never buy anything, and with the flag off no customer should exist at all.
The user-visible effect of lazy creation is identical — by the time a buyer pays, their
customer exists.

### 3. Full metadata is persisted
Users gets a `stripe_payment_methods` table mirroring each card: `stripePaymentMethodId`
(`pm_...`, unique), `userId` FK, `brand`, `last4`, `expMonth`, `expYear`, `funding`, `country`,
`fingerprint`, `billingName`, `billingEmail`, `billingAddress` (`Json`), `isDefault`,
`rawPayload Json` (the whole PaymentMethod object), plus the repo's standard [[audit-fields]]
and [[soft-delete]]. `User` gains `stripeCustomerId String? @unique @map("stripe_customer_id")`
and `stripeCustomerData Json?` (whole Customer object), mirroring `UsersCognitoData`.

Hard limit: the full PAN, the CVC, and the PaymentIntent `client_secret` never reach our
backend by Stripe's design — only `brand`, `last4`, `exp_month`, `exp_year`, `funding`,
`country`, and `fingerprint` are available. Storing a PAN would pull the repo into full PCI
scope. "All the metadata" means everything Stripe actually exposes; `rawPayload` is what makes
future fields available without a migration.

Corollary, stated explicitly: server-side options that accept a raw PAN (e.g.
`payment_method_data` on PaymentIntent creation) require proving PCI compliance to Stripe
before they can be used. This repo deliberately stays outside that scope — nothing in this
implementation may accept or forward a raw card number, on either service.

Cost accepted: a local copy can drift from Stripe (card deleted from the dashboard, expired,
or auto-updated by the issuing bank). Mitigated by the three rules in Decision 4.

### 4. Drift mitigation
- Stripe is always authoritative; the local copy is a cache, never the authority — listing
  reads local, but **charging validates against Stripe**.
- A Stripe webhook (`payment_method.attached/detached/updated/automatically_updated`,
  `customer.updated`) upserts the local copy, the same pattern `UsersCognitoData` already uses
  for Cognito events.
- A card deleted in Stripe is soft-deleted locally, never hard-deleted, so historical orders
  referencing it still resolve.

### 5. Orders stores a denormalized payment snapshot
`PaymentIntentId`, `PaymentStatus`, `AmountCents`, `Currency`, `PaymentMethodId`, plus
`CardBrand`/`CardLast4`/`CardExpMonth`/`CardExpYear`, and `PaymentRawPayload` (whole
PaymentIntent). Denormalized deliberately — an order is a historical document and must not
join against the user's live cards, the same reasoning as the existing
`ShippingAddressSnapshot` and consistent with [[money-representation]]. The snapshot is
written only for a **succeeded** charge (Decision 7/8): a declined attempt creates no order
row, because an order row without a payment would consume an order number and appear in "my
orders" with no stock reserved. The declined attempt is not lost — it is recorded in Stripe
itself (the PaymentIntent carries `metadata.order_id`) and in the `payment_declined` log line
and span (Decision 25).

### 6. Orders gets `stripeCustomerId` over the existing gRPC
`proto/users.proto`'s `UserResponse` gains `stripe_customer_id`; the proto file's existing
comment convention about keeping messages in sync by hand applies. Orders does not persist
this value. `stripeCustomerId` is **not** exposed on `GET /v1/users/me` — the browser needs
the card list, not the customer id, so keeping it out of the public payload avoids leaking it
to devtools for no gain.

### 7. Charge-then-persist ordering
Orders charges **before** persisting the order. Charging after persisting risks an order with
no payment — shipped goods with no charge and no trace. Charging first risks a charge with no
order, which is detectable and repairable: the PaymentIntent carries `metadata.order_id` and is
refundable.

**Client-supplied idempotency (Decision, user, 2026-09-22).** An order id minted server-side
cannot make a client retry idempotent — a re-POST mints a **new** order id, derives a new
Stripe idempotency key from it, and charges a second time. Idempotency must originate with the
client:

- `POST /v1/orders` takes an `Idempotency-Key` request header. **Required** when
  `STRIPE_ENABLED=true` (400 `idempotency_key_required` when missing); optional and ignored
  when the flag is off. Format: an opaque client-generated token (the web app uses a UUID),
  max length documented as **≤ 64 chars ASCII** (the implementation enforces the exact limit).
- **Client contract:** generate ONE key per checkout attempt; reuse it only when retrying after
  a network error, a timeout, or a 5xx; generate a new key after any definitive response (any
  2xx or 4xx).
- Orders persists the key on the order with a **unique index on `(UserId, IdempotencyKey)`**.
  A request whose `(user, key)` pair already has an order returns that existing order (same
  body, `200`) without charging again. A concurrent duplicate that loses the unique-index race
  also returns the existing order, rather than erroring.
- The Stripe idempotency key is derived from **`(user id, client key)`**, e.g.
  `order-charge-{userId}-{clientKey}` — not from the server-minted order id — so a concurrent
  or retried request with the same client key gets the same PaymentIntent back from Stripe,
  never a second charge.
- **Guard — replay of an already-refunded PaymentIntent.** When Stripe replays a cached
  response for that key (`Idempotent-Replayed: true`) and the PaymentIntent has since been
  refunded (the earlier attempt hit a post-charge failure and Decision 9's refund already ran),
  Orders does **not** persist an order and answers `409 idempotency_key_reused`; the client
  must retry with a new key.
- **Guard — body mismatch.** Reusing a key with a different request body is rejected by Stripe
  itself (`idempotency_error`); Orders answers `422 idempotency_key_mismatch`.

This header lives alongside `paymentMethodId` in the `POST /v1/orders` contract — see "Orders
flow" below.

### 8. Card errors return 402
Declined, insufficient funds, and expired-card responses are not server faults; the frontend
must distinguish them to ask for another card. The response carries Stripe's actionable
message, mapped through the frontend's existing `authErrorMessage` pattern.

### 9. Concurrency requirement (first-class, not an implementation detail)
**Widened scope (Decision, user, 2026-09-22):** the automatic refund covers **any** failure
that occurs between a successful charge and a committed order — not only a 409. Concretely:
the stock reservation 409 under the lock, a product removed from under the reservation, the
price-mismatch guard rejecting a stale total, or a persistence/commit failure after the charge
succeeded. In every one of these, the charge must never be left dangling; a charge with no
order is refunded automatically, the same way a 409-after-charge always was. The refund uses
its own idempotency key derived from the PaymentIntent id (e.g. `refund-{paymentIntentId}`),
independent of the order-creation idempotency key from Decision 7, so a retried refund attempt
cannot double-refund.

This is called out explicitly because a silently-dropped concurrency requirement is this
repo's known review failure mode — see
[[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]].

### 10. Local webhook delivery via Stripe CLI, not a tunnel
Chosen over Cloudflare Tunnel and ngrok. `stripe listen --forward-to` opens an **outbound**
connection from the machine to Stripe and forwards events to localhost — no ports exposed, no
domain, no third-party account, reusing the restricted key already injected by hand (Decision
15). Cloudflare Tunnel and ngrok were rejected because an ephemeral URL changes on every start
(requiring dashboard reconfiguration each time), while a stable one needs an account plus a
domain — the opposite of minimal setup — and both expose the local stack to the internet for
no benefit here.

Added as a `stripe-cli` compose service behind `profiles: [stripe]`, following the existing
`observability`/`preview` pattern, reaching `users` over the internal compose network.

Gotcha: `stripe listen` prints its **own** signing secret (`whsec_...`), different from the
dashboard's. Using the dashboard secret locally fails signature verification with a 400 that
looks like a code bug.

Consequence: because delivery is outbound, the webhook needs **no** public API Gateway/nginx
route for local development. A real deployment would still need one; that is out of scope
here (see "Out of scope").

### 11. E2E does not wait on the webhook
Users writes its own local row in the same response when a card is added — it already holds
the PaymentMethod object Stripe returned. Users' webhook is reconciliation for changes
originating **outside** the app. This keeps E2E deterministic and runnable without the
`stripe` compose profile active.

Stripe's own guidance insists fulfillment must be driven from an event handler rather than a
success page, because a buyer may never load the return page. That concern does not apply
here: the charge is synchronous inside `POST /v1/orders` — there is no redirect during which
the buyer can be lost — so **fulfillment** stays synchronous: the order and its payment
snapshot are written by `POST /v1/orders` itself, never by a webhook. If this integration ever
moves to Checkout Sessions or adds a delayed-notification payment method, that changes and
fulfillment must move into a handler.

This paragraph covers fulfillment only. Orders gets its **own** webhook too, but for a
narrower purpose — payment *reconciliation*, the same role Users' webhook already plays for
card state — see Decision 26.

### 12. E2E data is tagged in Stripe too
Reusing the existing mechanism: when `x-e2e-source: true` AND `E2E_TESTING_ENABLED` are both
set, the Stripe customer and payment method are created with `metadata.e2e_source: "true"`,
and local rows carry the `"E2E Source"` tag. The existing `DELETE /v1/users/e2e-cleanup` is
extended to also delete those Stripe-side customers — otherwise the Stripe test account
accumulates garbage every run.

### 13. Graceful degradation on missing key
Each service's restricted API key (Decision 15) is injected by hand into the CUSTOM box of
`.env.local.users` and `.env.local.orders` — never the AUTO box, which `make env-file`
rewrites (see [[env-files]]). If `STRIPE_ENABLED=true` but the key is absent, the service must
still boot, log a warning, and have the Stripe routes answer 503. A missing key must not take
down the local environment.

### 14. stripe-mock is deliberately excluded
Considered and rejected. `stripe-mock` is stateless and returns fixed fixtures, so a card
"saved" through it cannot be listed back — it structurally cannot exercise the
save-a-card-then-switch-between-them flow that is the point of this feature. E2E runs against
a dedicated Stripe sandbox instead (Decision 17). It could be reconsidered later, purely for
offline contract tests that don't need round-tripped state.

### 15. Restricted API keys, one per service — never a shared secret key
Each service gets its own **restricted API key** (`rk_...`), not a secret key (`sk_...`),
following least privilege:
- **Users' RAK** — write access to Customers, PaymentMethods, and SetupIntents only (it creates
  customers, attaches/detaches cards, and sets the default payment method).
- **Orders' RAK** — write access to PaymentIntents, and write access to Charges and Refunds
  (Stripe's restricted-key editor groups these as a single resource with one permission level;
  Write is required to create refunds, and it includes the read needed for Decision 7's
  idempotency replay guard, which lists a PaymentIntent's refunds, and for the `latest_charge`
  expansion). **No access to Customers or PaymentMethods** (Decision D, user, 2026-09-22): Orders
  charges an existing `payment_method` by id and never looks one up — the card brand/last4/expiry
  for the payment snapshot come from the charge itself (`latest_charge.payment_method_details.card`,
  see the Orders flow section), not from a PaymentMethods read. A compromised Orders key should not
  be able to touch a saved card, and this narrower scope is what makes that true in practice, not
  only in intent. Because Charges and Refunds are granted together, Orders' key technically permits
  the legacy Charges API too; the ban on that API (Decision 16) is enforced by code review and the
  prohibited-API grep, not by the key's permission scope.

Keys are injected by hand into the CUSTOM box of the relevant `.env.local.*` file, never the
AUTO box (Decision 13, [[env-files]]). Additional rules from Stripe's security guidance:
- Keys are never logged nor included in error messages.
- Separate keys per environment (local, CI, production) — no key is shared across them.
- A pre-commit hook should catch `sk_`/`rk_` literals in source. This repo already installs a
  pre-commit hook via `make install-comment-hook`
  ([[code-comments]]'s enforcement mechanism); adding a key-literal check to that same hook is
  the natural place for it rather than a new hook.
- Each restricted key additionally gets its own **access policy** (Dashboard → API keys →
  configure access policy), and Users' and Orders' policies are **different from each other**
  — restricting a key's permissions (what it can call) and its access policy (who/where can
  use it) are separate controls, and compromising one service's environment must not expose
  the other's.

**Key-compromise incident response.** Recorded here so the procedure exists before it is
needed, not improvised during one:
1. **Roll or delete the exposed key immediately** from the Dashboard's API keys page — even
   before confirming it was actually used by an unauthorized party.
2. **Review Workbench request logs** for that key for unrecognized activity.
3. **Contact Stripe support** if anything in those logs is unrecognized.

Preparation, ahead of any incident: practice rolling a key so the procedure is not learned
live, audit source for committed keys, and rely on the same pre-commit hook above to prevent
future check-ins — that hook is the concrete form "use pre-commit hooks" takes in this repo.

### 16. Never pass `payment_method_types`
No API call in this integration (`setupIntents.create`, `paymentIntents.create`) passes
`payment_method_types`. Omitting it keeps dynamic payment methods enabled — Stripe evaluates
100+ signals (currency, customer location, amount, device) to select and rank eligible methods,
configurable from the Dashboard with no code change, and it is the natural reflex to hardcode
`payment_method_types: ['card']` when the immediate goal is "accept cards", which is exactly
the trap. If an explicit allowlist is ever needed, use `allowed_payment_method_types`, never
`payment_method_types`. The Terminal/`card_present` exception does not apply — this repo has no
in-person payment flow.

**Prohibited/deprecated Stripe APIs.** Named explicitly, not left implicit, because each is the
"obvious" thing to reach for and naming them here is cheaper than catching them in review:

| API / method | Status | Use instead |
|---|---|---|
| Charges API | Never use | PaymentIntents (Decision 19) |
| Sources API | Deprecated for saving cards | SetupIntents (already this design's choice) |
| Tokens API | Outdated | SetupIntents or Checkout Sessions |
| Card Element | Legacy | Payment Element (see Web section) |
| `createPaymentMethod` / `createToken` (Stripe.js) | Not recommended | Confirmation Tokens, if card details must be inspected before payment |

None of these has a legitimate use in this integration; if a diff introduces one, that is a
regression against this decision, not a judgment call.

### 17. Dedicated sandboxes for local dev and CI, not the shared test-mode account
Two separate Stripe sandboxes — one for local development, one for CI — rather than the
account's shared test-mode sandbox, per Stripe's recommendation for new integration
development. This also gives the E2E suite stronger isolation: CI's Stripe-side state (test
customers, payment methods) never collides with a developer's local runs. `stripe sandbox
create` (Stripe CLI) creates a sandbox with its own test API keys and requires no registration.

Scoping caveat, worth recording because it generalizes beyond tax to any Dashboard-side
configuration: whatever is configured **inside** a sandbox — including Tax Settings and
registrations, if this changes later — is scoped to that sandbox. It does not exist in live
mode and does not carry over to another sandbox. Concretely: the CI sandbox does **not**
inherit anything configured in the local-dev sandbox, or vice versa — each of the two
sandboxes this decision creates must be configured independently.

See [[stripe-sandbox-setup]] for the operator-facing procedure to create both sandboxes and
their keys.

### 18. Pinned versions
Recorded so implementation does not silently drift onto older defaults:
- Stripe API version **`2026-08-26.dahlia`** (use the latest unless a reason is recorded here).
- SDKs: Node.js **22.6.0** (Users), .NET **52.4.0** (Orders).
- Both services instantiate a `StripeClient` and call methods on that instance. The
  global/module-level API key pattern (`Stripe.setApiKey` in Node, `StripeConfiguration.ApiKey
  = …` in .NET) is deprecated in all current SDKs and is not used here.

### 19. Why PaymentIntents and not Checkout Sessions
Stripe's own guidance routes one-time payments to the Checkout Sessions API and reserves
PaymentIntents for off-session payments or when the caller needs to model checkout state
independently. This integration is **off-session**: it charges a card the buyer already
selected inside our own checkout page (Decision 5's saved-card selector), with no redirect and
no Stripe-hosted payment form. That is precisely the case Stripe's own routing sends to the
PaymentIntents API, so PaymentIntents is the considered choice here, not an oversight.

SetupIntents remains the API for saving cards for the same reason it always was — Stripe's
guidance confirms Setup Intents (not the deprecated Sources API) as the correct way to save a
payment method for later use.

### 20. Stripe Tax is considered and deferred — tax stays in-house
Orders already computes tax itself: `services/orders/src/Orders.Domain/Pricing/OrderPricing.cs`
rounds `subtotalCents * taxRate` to the nearest cent (`MidpointRounding.AwayFromZero`) exactly
once per line, with `taxRate` read from a `Configuration` row, per
[[money-as-integer-cents]] / [[money-representation]]. This milestone **keeps that
calculation and does not adopt Stripe Tax / `automatic_tax`**.

Rationale:
- The existing calculation is deterministic — the E2E suite depends on that determinism — and
  it already produces the `formatted` strings the web renders verbatim. Replacing it buys
  nothing this milestone needs.
- Adopting Stripe Tax is a business/compliance decision, not an engineering one: it requires a
  head office address in Tax Settings plus an **active registration per jurisdiction** before
  it collects anything, and nobody has made that determination for this product.

> [!warning] `automatic_tax` without an active registration fails silently
> Stripe's own guidance calls this the single most common Stripe Tax mistake: enabling
> `automatic_tax: { enabled: true }` in a jurisdiction with no active registration returns no
> error and calculates zero tax. The integration looks configured while collecting nothing —
> this is a silent revenue/compliance failure, not a runtime error a test would catch. A future
> reader must not treat "flip `automatic_tax` on" as a free upgrade over the current
> calculation; it requires the registration work first. `automatic_tax` is also all-or-nothing
> per object — it cannot coexist with manual tax rates on the same PaymentIntent, Invoice, or
> Subscription.

Consequences for the rest of this design:
- Because tax is computed by Orders, the PaymentIntent `amount` (Decision 5, Orders flow) is
  the already-tax-inclusive total Orders computed. No Stripe-side tax calculation is created
  or linked to the PaymentIntent.
- Stripe Tax's refund/reversal behavior (which differs by integration — simplified PaymentIntent
  integration reverses tax automatically, custom integration does not) does not apply to
  Decision 9's refund path, precisely because Stripe Tax is not in use here. A refund is a
  plain PaymentIntent refund; there is no tax transaction to reverse.

### 21. Card-field validation on the plain branch (client-side, mirrored server-side without the PAN)

The `@else` branch at `checkout-payment.html` (shown when `stripeEnabled()` is false) has **no
validation today**: `cardForm = form(this.cardModel)` in `checkout-payment.ts` is declared with
no validators at all (its own comment says "nothing submits these"), `groupCardDigits` only caps
input at 19 digits and groups in 4s, `onCardExpiryInput` accepts any 4 digits including `99 / 99`,
and `onCardCvcInput` accepts 1-4 digits regardless of brand. There is no brand detection, so
nothing knows Amex is 15 digits with a 4-digit CVC. This decision closes that gap.

**Scope.** This applies only to the plain branch. The Stripe branch uses the **Payment
Element**, which validates card number, expiry, and CVC itself — nothing in this decision is
duplicated there; a future reader must not add parallel Luhn/expiry checks inside the Stripe
path.

**Validation rules**, applied client-side in Angular:

| Brand | Number length(s) | CVC length | Prefix |
|---|---|---|---|
| Visa | 13, 16, 19 | 3 | starts with 4 |
| Mastercard | 16 | 3 | 51-55, or 2221-2720 |
| Amex | 15 | 4 | 34, 37 |
| Discover | 16, 19 | 3 | 6011, 644-649, 65 |
| Diners Club | 14, 16, 19 | 3 | 300-305, 3095, 36, 38-39 |
| JCB | 16-19 | 3 | 3528-3589 |
| Unknown | 12-19 (accept) | 3 or 4 | — |

An unrecognised prefix is **not** rejected outright — it falls back to "unknown brand" with the
permissive length/CVC range, because rejecting a valid card from an unlisted issuer is worse
than accepting an unknown one in a form that charges nothing (see "Not a security control"
below).

- **Number:** length per the brand table above, AND the Luhn checksum. Length alone does not
  catch a transposed digit (`4242 4242 4242 4241` has Visa's 16 digits and is invalid).
- **Expiry:** month 01-12; month/year must not be in the past, compared against the **last day**
  of the expiry month — a card expiring in the current month is still valid. Two-digit years map
  to `2000 + YY`.
- **CVC:** length follows the *detected* brand (3, or 4 for Amex), so it is re-validated whenever
  the number changes brand mid-typing.
- **Card holder:** non-empty after trim, using the same `required` + `\S` pattern already used
  for street/city in the address form, guarding against the same "accepts a value of spaces"
  trap.
- The card-number grouping becomes brand-aware: Amex groups 4-6-5 (`3782 822463 10005`), not
  4-4-4-4.
- `canPay` additionally requires the card form to be valid on the plain branch (mirroring how it
  requires a selected payment method on the Stripe branch).

**Server-side mirror, metadata only — the PAN and CVC never leave the browser.** Orders
re-validates on `POST /v1/orders` using only `brand`, `last4`, `expMonth`, `expYear` — never the
full number, never the CVC. It checks: brand is a known value, expiry is not in the past,
`last4` is exactly 4 digits. Returns 400 on failure.

Rejected alternative, recorded so a later reader does not "improve" this by sending the full
card number to Orders: doing so would contradict Decision 3 (the PAN and CVC never reach any
backend by design) and would pull this repo into full PCI scope for no benefit — the server
cannot validate a card number/expiry/CVC any better than the client already did; Luhn, length,
and date comparison are the same computation wherever they run. Metadata-only re-validation
exists so the rule is enforced in both places, not because the client's check is untrusted with
card data it never sees the sensitive parts of anyway (the plain branch's `cardModel` holds the
full PAN in the browser only; only `brand`/`last4`/`expMonth`/`expYear` are ever sent onward).

**Not a security control.** This is UX correctness, not a security boundary — the plain branch
charges nothing today (there is no backend call that touches the raw `cardModel`; `pay()` posts
line items and, on the Stripe branch, a `paymentMethodId` — the plain branch's card fields are
inert). That is exactly why client-side validation is the primary home and the server check is a
mirror of it, not a gate guarding a real charge.

### 22. Payment methods are managed from the profile as well as the checkout

This reverses an earlier scoping call: the original "Out of scope" section deferred a
dedicated card-management screen outside checkout to a later milestone ("the user chose
Elements + selector over the larger option"). New design frames (`VcB4y` Profile — Payment
Methods, `wnUi1` Profile — Add Card, plus their mobile pairs `W6IFps`/`WQAq0`) reverse that
deferral: card management lives in **both** surfaces now — the checkout's inline selector
(Decision 23) and a dedicated tab on the profile screen.

Both surfaces are gated behind `STRIPE_ENABLED` exactly like everything else in this design.
With the flag off, the profile's new "Payment methods" tab does not render at all and the
profile keeps its current single-view shape (no `Tabs` frame, no `SAVED CARDS` section) — this
is not a separate flag, it is the same kill switch already governing the checkout branch and
the Users routes.

This decision does not introduce a new HTTP surface: the profile tab is a second **consumer**
of the same five `/v1/users/me/payment-methods*` routes (Decision 4's "Users HTTP surface")
that the checkout selector already calls — `list`, `setup-intent`/`attach` (add a card),
`PUT .../default` (set default), `DELETE` (remove). No new Users endpoint is added by this
decision.

### 23. The checkout can add a card inline, not only select one

The original Web section described the Stripe branch as a saved-card selector plus a
separate "Add card" action. The `New Card Block` inside `wgkmW`/`V2wb9b`'s `Stripe Payment
Element` frame shows a fuller flow: the `Saved Cards List` (the same `Saved Card Row`
instances as the profile, Decision 22) sits alongside an inline new-card form — `Method Tabs`
(Card / Apple Pay / Link), the four `SField` rows, a `Save Info Row`, and a `Save Card Button`
— reachable without leaving the checkout page, with a "Cancel" link that collapses it back to
the saved-cards list.

**Real behavioural branch for Users' API.** The `Save Info Row`'s "Save this card for future
purchases" checkbox is not cosmetic — it decides which Stripe call the resulting payment
method goes through:
- **Checked:** the SetupIntent's resulting `pm_...` is **attached** to the customer via
  `POST /v1/users/me/payment-methods` (Decision 4's attach route) exactly as today — it becomes
  a saved card, appears in future listings, and is eligible to be set default.
- **Unchecked:** the payment method is used **once**, for this order's PaymentIntent only, and
  is never attached to the customer — no row is written to `stripe_payment_methods`, and it
  will not appear in any future `GET /v1/users/me/payment-methods` listing.

This is a real branch the current five-endpoint surface does not express on its own — the
existing routes assume every confirmed SetupIntent gets attached. The web app must send this
choice explicitly (Task 11 in the plan wires the checkbox to it) rather than the backend
inferring it from context.

### 24. An expired saved card is shown, not hidden

The design renders an expired card (`Card American Express` in the profile's Cards List and
checkout's `Saved Cards List`) in place — dimmed `Brand Bubble` (`$bg-subtle`) and `Brand Icon`
(`$text-muted`), expiry text reading `"Expired 01 / 2026"` in `$danger-red` at `fontWeight 600`
— rather than filtering it out of the list.

Rules:
- Expiry is computed client-side from the already-stored `expMonth`/`expYear` (Decision 3's
  data model) — no new field, no new Stripe call.
- The same end-of-month semantics as Decision 21 govern both: a card expiring in the
  **current** month is still valid; comparison is against the last day of the expiry month.
  One rule, two consumers — the plain-branch form validation and this list's expired/valid
  visual state — never two independent expiry calculations.
- An expired card cannot be **selected** for payment (its `Radio` is inert), but it is never
  silently removed from the list. The buyer removes it themselves via the existing `Remove
  Button` (Decision 4's detach route) — this design makes no change to when a card is deleted,
  only to how an expired-but-not-yet-deleted one is displayed.

### 25. Stripe calls join the logs and traces cascade

Every outbound Stripe call is an outbound third-party hop, exactly like the SNS publish
`services/users/src/shared/observability/publish-tracing.ts`'s `withPublishSpan` already
instruments and `services/orders/src/Orders.Infrastructure/Messaging/SnsEventPublisher.cs`
mirrors for .NET. Neither service gets this for free by adding the Stripe SDK — it is
specified here so it is built alongside each call, not bolted on after the milestone ships.

**Spans.** Every outbound Stripe call gets a CLIENT span, following `withPublishSpan`'s
contract:
- **Named after the OPERATION, not the SDK surface** — `stripe.payment_intent.create`,
  `stripe.setup_intent.create`, `stripe.payment_method.attach`,
  `stripe.payment_method.detach`, `stripe.customer.create`, `stripe.refund.create`. The same
  reasoning `publish-tracing.ts` states for its own span name applies unchanged: the name is
  what a waterfall renders, so it must say what happened, not merely that the SDK was called.
- **`SpanKind.CLIENT`** (Node) / `ActivityKind.Client` (.NET) — Stripe is an outbound
  third-party dependency, not a message producer; `PRODUCER`/`ActivityKind.Producer` stays
  reserved for the SNS/SQS publish spans this pattern is borrowed from.
- **Attributes that are queryable, not just readable**: `stripe.operation`,
  `stripe.resource_type`, and the Stripe object id where one exists
  (`stripe.payment_intent_id`, `stripe.customer_id`, `stripe.payment_method_id`). Also
  `stripe.idempotency_key` on the charge path (Decision 7) — an idempotency-retry
  investigation is exactly the moment this attribute is needed, and it is cheap to attach
  always rather than reconstruct after the fact.
- **ERROR status + a recorded exception on failure, and the span ends in a `finally`** — for
  the exact reason `publish-tracing.ts`'s contract states: a span left open on the exception
  path is never exported and nothing errors to say so. Unlike the SNS publisher (which
  swallows its own send failure because the order is already committed), a Stripe call
  failure on the charge path DOES propagate (Decision 8's 402) — the span still records it
  before it propagates, the same as any other failing CLIENT hop.

**Never on a span or in a log — extending [[logging-context]]'s prohibitions with Stripe's
specifics:**
- **The restricted API key or the webhook secret.** Decision 15 already says keys are never
  logged; restated here as a span-attribute rule too, because attributes are a second surface
  people forget when a prohibition is stated only for logs.
- **The PAN, the CVC, or a SetupIntent/PaymentIntent `client_secret`.** The `client_secret` is
  the one most likely to be logged by accident, because it sits on the very response object
  the code is already holding and about to hand to the frontend — the accidental log call is
  `logger.info({ setupIntent })`, not a deliberate leak.
- **The full Stripe response object.** Decision 3 stores `rawPayload` in the **database**
  deliberately; that is not a licence to log or span-attribute it. A card's
  `last4`/`brand`/`expMonth`/`expYear` are safe to emit; nothing else from the card object is.
- **A plaintext email on the customer-creation path** — use `email_hash` per
  [[logging-context]], never the raw address, on the `stripe_customer_created` flow log.

**Flow logs with `app_event`**, following the existing `<flow>_started` / `<flow>_succeeded` /
`<flow>_failed` triad plus `reason` on failure ([[logging-context]] — there is no `SUCCESS`
severity; success is `INFO` + `app_event=*_succeeded`). Named concretely, not left to be
invented at implementation time: `stripe_customer_created`, `payment_method_attached`,
`payment_method_detached`, `payment_method_set_default`, `payment_intent_created`,
`payment_charged`, `payment_declined`, `payment_refunded`, `stripe_webhook_received` (emitted
by **both** services' webhooks — Users' per Decision 4/11, Orders' per Decision 26),
`payment_orphan_refunded` (Orders' webhook only, Decision 26).

**The three paths that must be observable independently, because they are the ones debugged
without Stripe's own dashboard open:**
- **A declined card (402, Decision 8).** A decline is a business outcome, not a server fault:
  `app_event=payment_declined` with Stripe's `decline_code` as `reason`, at INFO/WARN — never
  ERROR. An ERROR span/log here would put an ordinary declined-card page on the same
  on-call dashboard as a real fault.
- **The refund-after-409 path (Decision 9).** The highest-risk requirement in this milestone
  (see [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]]) must be observable
  on its own, independently of the charge that preceded it: its own
  `app_event=payment_refunded` line carrying `order_id` and `payment_intent_id`, so "was a
  dangling charge actually refunded?" is answerable from the logs alone — without opening
  Stripe's dashboard to check.
- **The webhook (Decision 4/11).** `app_event=stripe_webhook_received` with the Stripe
  `event.type` and `event.id` as attributes. A signature-verification failure logs as a
  failure with `reason=signature_verification_failed`, and **never** logs the `stripe-signature`
  header or the raw request body.

**The web side inherits [[browser-rum]]'s rules — it does not get its own.** The new checkout
and profile calls (Decisions 22–23) MUST go through `ApiClient`: a raw `fetch()` bypasses
`rumPropagationInterceptor` entirely, producing no CLIENT span and no `traceparent`, so the
call is invisible in `app_traces` while every dashboard stays green — exactly the failure mode
[[browser-rum]] names ("nothing about the fact that telemetry exists makes a FUTURE endpoint
inherit it"). A card error surfaced in the checkout or profile UI must still reach Angular's
`ErrorHandler` (rethrow, or report deliberately) or it never reaches `rum_logs`. Redaction is
the screen author's problem, per [[browser-rum]]'s Trigger 2: a Stripe error object must never
be handed to the error handler wholesale — only the allow-listed fields it already documents.
This decision does not restate [[browser-rum]]'s checklist; it points at it.

**Verification is in the viewer, not the HTTP status.** Per [[browser-rum]] and
[[2026-08-21-verify-in-the-viewer-not-the-api]], OpenObserve returns 200 and silently drops
records — "observable" means the trace was actually seen in OpenObserve, after allowing a full
export cycle, never inferred from a 200 response. What "covered" means for this milestone:
placing an order with a saved card produces **one** trace spanning browser → gateway → Orders
→ Stripe, with the Stripe hop appearing as its own named CLIENT span in that same waterfall.

### 26. Orders gets its own Stripe webhook — for payment reconciliation, not fulfillment

**Decision, user, 2026-09-22.** Decision 11 is true for **fulfillment**: the order and its
payment snapshot are still written synchronously by `POST /v1/orders`, never by a webhook,
because the charge itself is synchronous and there is no redirect to lose the buyer across.
That stays unchanged. But three failure shapes have no detector today, none of them fixable
by making the synchronous path more careful, because each happens **after** `POST /v1/orders`
has already returned or crashed:

1. **Orphan charges.** A succeeded PaymentIntent carrying `metadata.order_id` (Decision 5's
   ordering, Task 9's `order_id` metadata) with no matching order row — the process was killed
   between the charge and the commit, the post-charge refund in Decision 9's path itself failed
   partway, or a PaymentIntent that was `processing` when Orders answered its caller 402 (Orders
   never retries a `processing` intent — see the Orders flow section) later transitions to
   `succeeded` on Stripe's side with nothing on the Orders side aware of it. In every one of
   these, real money moved with no order to show for it, and it must come back.

   Handler, on `payment_intent.succeeded`: look up an order for `metadata.order_id`.
   - **No order exists, PaymentIntent younger than a grace period** (10 minutes, configurable):
     answer a non-2xx so Stripe retries the delivery later — the in-flight `POST /v1/orders`
     request may still be about to commit, and refunding under it would be a real double-refund
     race, not merely a redundant one.
   - **No order exists, PaymentIntent older than the grace period:** issue a full refund using
     the **same** idempotency key as Decision 9's inline refund path,
     `refund-{paymentIntentId}` — deliberately the same key, not a new one, so the two paths
     (the inline post-charge catch block and this webhook handler) can never both succeed at
     refunding the same charge. Log `app_event=payment_orphan_refunded` (WARNING) with
     `order_id` and `payment_intent_id`.
   - **Order exists:** no-op. This is the common case — most `payment_intent.succeeded`
     deliveries arrive for orders that already committed normally.

2. **Refunds made outside the app.** A refund issued from the Stripe Dashboard, by support, or
   by any path other than this codebase has nothing in Orders reflecting it. Handler, on
   `charge.refunded`: update the order's `PaymentStatus` to `refunded` (full) or
   `partially_refunded` (comparing `amount_refunded` against `amount` on the event).

3. **Disputes.** Nothing today tells Orders a cardholder disputed a charge. Handler:
   `charge.dispute.created` sets `PaymentStatus=disputed`; `charge.dispute.closed` records the
   outcome — won reverts to `succeeded`, lost sets `PaymentStatus=dispute_lost`. Log each
   transition at WARNING; a dispute is not routine traffic.

Every other event type Stripe delivers to this endpoint is acknowledged with a 2xx and
otherwise ignored — an unrecognized type is not an error, it is simply not one of the three
cases above.

**No processed-event table.** Stripe may deliver an event more than once, or out of order,
and this design accepts both without deduplicating deliveries by `event.id`: every handler
above is idempotent on its own terms — the orphan-refund path reuses Decision 9's exact
idempotency key, the refund/dispute-status handlers are plain upserts of the order's
`PaymentStatus` keyed on the PaymentIntent/charge id, so replaying the same event twice sets
the same status twice. A processed-event table would only buy protection a plain idempotent
handler already has for this handler shape.

**Route.** `POST /v1/orders/stripe/webhook` — public, no JWT (`auth = false` in the gateway
route map, the same shape as Users' `stripe_webhook` route). Signature verified on the
**raw** request body using Orders' **own** `STRIPE_WEBHOOK_SECRET` before any handler runs —
an invalid signature answers `400 invalid_signature` and dispatches nothing, mirroring
Decision 4's webhook. `STRIPE_ENABLED=true` with the secret absent answers `503
stripe_unavailable`, the same graceful-degradation shape Decision 13 already specifies for
every other Stripe-backed route.

**Observability.** `app_event=stripe_webhook_received` with `event.type` and `event.id`, the
same shape Decision 25 already specifies for Users' webhook — this is the same event, applied
to Orders' own endpoint, not a new logging shape.

**Local delivery (Decision 10).** `stripe listen`'s signing secret is the same value for every
event it forwards on one machine — the CLI mints one secret per running `listen` process, not
per destination. `make stripe-webhook-secret` therefore writes that **one** `whsec_...` into
**both** `.env.local.users`' and `.env.local.orders`' CUSTOM boxes. What the implementer must
verify, not invent: whether one `stripe listen --forward-to` invocation can forward to two
local endpoints, or whether two concurrent `stripe listen` processes are needed (in which case
they would mint two *different* secrets, contradicting the shared-secret premise above) — run
`stripe listen --help` and confirm before wiring the compose command; do not assume flags that
have not been checked against the installed CLI's own help output. A real deployment gives each
endpoint its own Dashboard-issued secret, so this shared-secret-on-one-machine shape is a local
convenience, not a production characteristic.

## Data model

**Users (Postgres, Prisma):**
- `User.stripeCustomerId String? @unique @map("stripe_customer_id")`
- `User.stripeCustomerData Json? @map("stripe_customer_data")`
- New table `stripe_payment_methods`: `stripePaymentMethodId` (`pm_...`, unique), `userId` FK,
  `brand`, `last4`, `expMonth`, `expYear`, `funding`, `country`, `fingerprint`, `billingName`,
  `billingEmail`, `billingAddress Json`, `isDefault`, `rawPayload Json`, plus the standard
  [[audit-fields]] and [[soft-delete]] columns. Primary key follows [[nano-id]].

**Orders (Postgres, EF Core):** a payment snapshot on the order aggregate — `PaymentIntentId`,
`PaymentStatus`, `AmountCents`, `Currency`, `PaymentMethodId`, `CardBrand`, `CardLast4`,
`CardExpMonth`, `CardExpYear`, `PaymentRawPayload` — denormalized per Decision 5, alongside the
existing `ShippingAddressSnapshot`. Plus a nullable `IdempotencyKey` column with a unique index
on `(UserId, IdempotencyKey)`, per Decision 7's client-supplied idempotency.

## Users HTTP surface

All routes flag-guarded; not mounted when `STRIPE_ENABLED` is off.

- `POST /v1/users/me/payment-methods/setup-intent` — ensures the customer exists (lazy),
  returns a SetupIntent `client_secret` for Elements.
- `GET /v1/users/me/payment-methods` — lists from the local copy.
- `POST /v1/users/me/payment-methods` — confirms the tokenized `pm_...`, attaches it to the
  customer, writes the local row in the same response.
- `DELETE /v1/users/me/payment-methods/:id` — detaches in Stripe, soft-deletes locally.
- `PUT /v1/users/me/payment-methods/:id/default` — sets `invoice_settings.default_payment_method`,
  mirrors `isDefault` locally.
- `POST /v1/users/stripe/webhook` — public, signature-verified via `STRIPE_WEBHOOK_SECRET`,
  upserts per Decision 4.

Security requirement: every route verifies the `pm_...` belongs to the caller's customer
before acting — without that check, passing someone else's id would delete another user's
card. Endpoints are specified in the service's `openapi.yaml` per [[openapi-specs]].

## Orders flow

With the flag on, `paymentMethodId` arrives in the `POST /v1/orders` body (400 if missing), and
the request additionally carries an `Idempotency-Key` header (400 `idempotency_key_required` if
missing — Decision 7). With the flag off, `paymentMethodId` is ignored, the header is optional
and ignored too, and the endpoint behaves exactly as today. Orders fetches `stripe_customer_id`
over gRPC (Decision 6); checks `(UserId, IdempotencyKey)` for an existing order and returns it
(`200`, no charge) on a match; otherwise creates the PaymentIntent (amount = the total Orders
already computes, `customer`, `payment_method`, `off_session: true, confirm: true`, an
idempotency key derived from `(userId, clientKey)`), then persists the order with the payment
snapshot (Decision 5), charging before persisting (Decision 7) and refunding automatically if
any failure — a stock conflict, a removed product, the price-mismatch guard, or a
persistence/commit failure — occurs after a successful charge (Decision 9). A replayed
Stripe response for an already-refunded PaymentIntent answers `409 idempotency_key_reused`; a
reused key with a mismatched body answers `422 idempotency_key_mismatch` (Decision 7).

The payment snapshot's card fields (`CardBrand`/`CardLast4`/`CardExpMonth`/`CardExpYear`,
Decision 5) come from the charge, not from a PaymentMethods lookup: the PaymentIntent create
call expands `latest_charge`, and the card fields are read from
`latest_charge.payment_method_details.card` (Decision D, user, 2026-09-22) — consistent with
Orders' restricted key having no PaymentMethods access at all (Decision 15).

**`POST /v1/orders/stripe/webhook`** — public, no JWT, signature-verified against Orders' own
`STRIPE_WEBHOOK_SECRET` — handles payment *reconciliation* (orphan charges, refunds made outside
the app, disputes), never fulfillment; see Decision 26.

## Web

Two design surfaces implement the routes above, both new since the design frames were read
live from `assets/web-app/web-app.pen` via the Pencil MCP: **Checkout — Payment (add card)**
(`wgkmW` / mobile `V2wb9b`) and **Profile — Payment Methods** (`VcB4y` / mobile `W6IFps`), plus
**Profile — Add Card** (`wnUi1` / mobile `WQAq0`). Seven HTML snapshots for these frames (and
one shared component) are exported under `apps/web/design/exports/`:
`checkout-payment-add-card.html`, `mobile-checkout-payment-add-card.html`,
`profile-payment-methods.html`, `mobile-profile-payment-methods.html`,
`profile-add-card.html`, `mobile-profile-add-card.html`, `saved-card-row.html`. **All 32
design tokens this milestone's frames use already exist in `apps/web/src/styles.css`** — there
is no design-system gap to report and nothing new to add there.

**`Saved Card Row` — new reusable component.** A single component (`vPwZ1` in the `.pen`)
renders one saved card, in three states the design's Cards List demonstrates side by side:

1. *Selected + default* — `bg-surface-subtle` fill, `border-brand-navy` stroke, radio dot
   filled, `Default Badge` shown, "Set as default" link **hidden**.
2. *Unselected, not default* — transparent fill, `border-line` stroke, radio dot empty,
   `Default Badge` hidden, "Set as default" link shown.
3. *Expired* (Decision 24) — dimmed `Brand Bubble`/`Brand Icon` (`bg-surface-subtle` /
   `text-ink-muted`), expiry text `text-danger-red font-semibold` reading `"Expired MM /
   YYYY"` instead of the live card's `text-ink-secondary` normal-weight `"Expires MM / YYYY"`,
   and the row cannot be selected.

The component is shared, not duplicated, between the checkout's `Saved Cards List` and the
profile's `Cards List` — the same three states apply in both places (see the plan's Task 11).

**The `@if (stripeEnabled())` branch at `checkout-payment.html:259`** stops being a static card
and becomes the `Stripe Payment Element` frame's two parts: a `Saved Cards List` of
`Saved Card Row` instances (default preselected), and, per Decision 23, an inline
`New Card Block` — `Method Tabs` (Card / Apple Pay / Link), the four `SField` rows, a
"Cancel" link collapsing it back to the list, a "Save this card for future purchases"
checkbox, and a `Save Card Button` — shown directly when the user has no saved cards.
`pay()` sends the selected `paymentMethodId` and maps a 402 to an actionable card error via
the existing `authErrorMessage` pattern (the same shape as the current 409 mapping).

**Profile — Payment Methods** (Decision 22) adds a `Tabs` frame ("Delivery address" /
"Payment methods", active tab `text-ink-primary font-semibold` with a visible 2px
`Tab Indicator`, inactive `text-ink-secondary` normal with a transparent indicator) above a
`SAVED CARDS` section: a `Section Top` (label + live count, e.g. "3 cards"), the `Cards List`
of `Saved Card Row` instances, an `Add Card Button` (reusing the existing `Button Ghost`
component `aUEDx`, not a new button), and a `Security Note` ("Cards are stored by Stripe.
3MRAI never sees your full card number."). With the flag off, none of this renders — the
profile keeps its current single-view shape.

The **Payment Element** is used by name, not the legacy Card Element and not the Payment
Element restricted to card-only mode — both are traps Stripe's own guidance calls out. The
Card Element is deliberately not used here because it is legacy and Stripe directs new
integrations to the Payment Element. Side benefit: the Payment Element surfaces other eligible
payment methods (per Decision 16's dynamic payment methods) with no extra code.

Constraints:
- `stripeEnabled` is read from `APP_CONFIG`, never `import.meta.env` — that contract is defined
  in `app-config.ts`.
- The publishable key ships as `NG_APP_STRIPE_PUBLISHABLE_KEY` and is the **only** Stripe value
  allowed in the bundle; neither service's restricted key (Decision 15) ever does.
- The dev-fill button does not apply to the Stripe branch — the Payment Element runs in an
  iframe that cannot be filled from outside the frame (use test card `4242 4242 4242 4242` by
  hand) — and stays unchanged on the plain branch.
- `canPay` keeps requiring an address and now also a selected card.
- `apps/web`'s nginx config carries a `Content-Security-Policy` allowing `https://*.stripe.com`
  in `script-src`, `frame-src`, and `connect-src` — Stripe.js requires it, and a missing or
  overly permissive CSP weakens the XSS protections Stripe.js relies on. This is a concrete
  nginx change, tracked as its own item under Infra.

Component structure and state handling follow [[angular-component-authoring]].

On the plain branch (flag off), the card fields gain real validation per Decision 21: brand
detection, Luhn, brand-aware CVC length, and expiry checks, with `canPay` requiring a valid card
form. This is independent of the Payment Element work above — the Payment Element already
validates its own branch.

## Local webhook delivery

See Decision 10. `stripe-cli` runs as a compose service behind `profiles: [stripe]`, started
with `make stripe-up` and inspected with `make stripe-logs`, following the `observability`
pattern in [[local-dev]]. It forwards Stripe events to **both** Users and Orders over the
internal compose network — Orders' own webhook (Decision 26) needs delivery too, using the
**same** `stripe listen`-minted signing secret in both services' CUSTOM boxes (Decision 26's
local-delivery paragraph); no public route exists for either locally (Decision 10's
consequence).

## Testing

All three layers per [[testing]] — a gate, not a suggestion:

1. **Unit/integration** — Users via Vitest dispatching through the real CommandBus/QueryBus
   (never `handler.execute()` directly, per [[cqrs]]), Orders via xUnit. The Stripe client is
   mocked at this layer, where declines and the refund-after-409 path (Decision 9) are made
   deterministic.
2. **Internal E2E** — Playwright against `localhost:3000` (Users) and `localhost:3001`
   (Orders), against the CI Stripe sandbox (Decision 17).
3. **Gateway E2E** — real Cognito JWT, including the UI journey: add a card via the Payment
   Element, switch cards, pay.

Everything E2E creates is tagged both in Stripe (`metadata.e2e_source`) and locally
(`"E2E Source"`), per Decision 12; `e2e-cleanup` removes it from both. Local development and CI
use their own dedicated sandboxes (Decision 17), each with its own restricted keys (Decision
15) — a developer's local runs and CI never share Stripe-side state.

Load tests send neither `x-e2e-source` nor `x-test-mode`, and with the flag off by default they
never touch Stripe — this is verified, not assumed, because a load test issuing real charges
would be expensive.

**Observability verification is part of "done" for these routes**, per CLAUDE.md's rule that
every new/changed HTTP endpoint requires observability and that reads are not exempt. A route
is not finished when its tests are green; it is finished when Decision 25's spans and
`app_event` lines have been seen in OpenObserve for at least the declined-card path, the
refund-after-409 path, and the webhook — not merely coded and assumed correct.

## Infra

New gateway routes in `infra/modules/api-gateway/main.tf` — including `POST
/v1/orders/stripe/webhook` (Decision 26), `auth = false`, the same shape as Users'
`stripe_webhook` route — are their own implementation task, not a footnote: a route missing
from the gateway map 404s while working on the service port. `/v1/orders/stripe/webhook`
needs **no new** nginx `location` block in `infra/modules/compute/nginx/nginx.conf` — it falls
under the existing `location /v1/orders` prefix block, which forwards path and all to Orders
unchanged; verified against the current file, not assumed. That block's existence is still
worth restating: a new top-level path with no matching `location` silently falls through to
`location /`, which routes to Users. Plus the `stripe-cli` compose service behind `profiles:
[stripe]` and the `make stripe-up` / `make stripe-logs` targets.

Also tracked here, not as footnotes:
- The `Content-Security-Policy` change to `apps/web`'s nginx config (Web section) allowing
  `https://*.stripe.com` in `script-src`, `frame-src`, and `connect-src`.
- **Webhook signature verification is mandatory** (already required by Decision 4's webhook
  handler; restated here as a deployment gate, not an optional hardening step). For a real
  deployment, Stripe's IP addresses should additionally be allowlisted on the public webhook
  endpoint as defense in depth. This is a deployment-time measure only — it does not apply to
  local delivery via `stripe listen`, which is an outbound connection from the machine to
  Stripe and has no inbound public endpoint to allowlist (Decision 10).

## Flag gate

With `STRIPE_ENABLED=false` (the default), the whole repo behaves exactly as today: no mounted
routes, no Stripe calls, no meaningful migrations triggered at runtime. This is tested, not
assumed.

## Tooling

This repo installs Stripe's official agent skills as real directories under `.claude/skills/`
(`stripe-best-practices`, `stripe-docs`), pinned in `skills-lock.json` with a `well-known`
sourceType from `https://docs.stripe.com`, installed with:

```
pnpm dlx skills add https://docs.stripe.com --skill stripe-best-practices --skill stripe-docs --agent claude-code --copy
```

Per [[skills-catalog]], plain Agent Skills use this npx/pnpm-dlx mechanism (version-controlled,
auditable), while `/plugin` is reserved for packages that bundle an MCP server or agents.
Stripe's `stripe agent setup` plugin path was deliberately **not** used here because it also
configures the Stripe MCP server, which reaches live account data and is not needed to write
this integration.

Manually installed skills do not auto-update — `pnpm dlx skills update` refreshes them.

## Out of scope

- A separate `payments` microservice.
- `stripe-mock` (Decision 14).
- The public webhook route for a real, non-local deployment. This is about the **deployed**
  endpoint (a real Dashboard-configured webhook URL, IP allowlisting — see Infra), not about
  Orders having a webhook at all: Decision 26 adds Orders' `POST /v1/orders/stripe/webhook` for
  local delivery via `stripe listen` in this same milestone, same as Users' webhook already
  does.

> [!note] Superseded scoping call
> An earlier draft of this section deferred a dedicated card-management screen outside
> checkout to a later milestone ("Elements + selector was chosen over that larger surface").
> Decision 22 reverses that: the new design frames put card management on the profile as well
> as the checkout, in this same milestone. That line is removed rather than kept as a stale
> "out of scope" entry that contradicts Decision 22.

## Related

- [[users-service-design]] — target for the Users-side data model, HTTP surface, and gRPC
  contract change.
- [[testing]] — the three-layer gate this design's testing section follows, and the E2E
  cleanup-by-tag mechanism it extends.
- [[env-files]] — the AUTO/CUSTOM box convention governing where the Stripe secret keys live.
- [[money-representation]] — the amount/currency representation the payment snapshot follows.
- [[money-as-integer-cents]] — the ADR behind Orders' existing tax calculation that Decision 20
  keeps in place instead of adopting Stripe Tax.
- [[local-dev]] — the `profiles:`-gated optional-service pattern the `stripe-cli` service
  follows.
- [[logging-context]] — the shared logging context the new payment endpoints must emit under
  (no plaintext card data, ever).
- [[git-workflow]] — branch/PR flow this milestone's implementation issues follow.
- [[soft-delete]] — the deletion pattern `stripe_payment_methods` uses.
- [[audit-fields]] — the standard audit columns `stripe_payment_methods` includes.
- [[openapi-specs]] — where the new Users routes are specified.
- [[angular-component-authoring]] — the component pattern the checkout saved-card selector,
  the new `SavedCardRow` shared component, and the profile's Payment methods tab all follow.
- [[cqrs]] — the CommandBus/QueryBus dispatch discipline Users' unit tests must exercise.
- [[nano-id]] — the primary-key convention for the new `stripe_payment_methods` table.
- [[phase-c-review-flow]] — how this milestone's issues chain and batch for review.
- [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]] — why Decision 9 is called
  out as a first-class requirement rather than left implicit.
- [[skills-catalog]] — the Agent Skills vs. `/plugin` installation mechanism this spec's
  Tooling section follows for `stripe-best-practices` and `stripe-docs`.
- [[code-comments]] — the pre-commit hook (`make install-comment-hook`) that Decision 15
  proposes extending with a key-literal check; also the rule Decision 21's `numeric-input.ts`
  change must follow when rewriting that file's contract comment to its final, brand-aware state.
- `apps/web/DESIGN.md` — the durable component/route reference table this design's new
  `Saved Card Row` component and three add-card/Payment-methods state variants are recorded in
  (Decisions 22–24); read live from the `.pen` via the Pencil MCP, confirming all 32 design
  tokens these frames use already exist in `apps/web/src/styles.css`.
- [[stripe-sandbox-setup]] — the operator-facing runbook for Decision 17's sandboxes and
  Decision 15's restricted keys.
- [[browser-rum]] — the Trigger 1/2/3 checklist Decision 25's web-side paragraph defers to
  rather than restating, for the new checkout and profile Stripe calls.
