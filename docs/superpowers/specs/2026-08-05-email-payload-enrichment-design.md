---
title: Email payload enrichment — closing the gap between the mockups and SQS
type: spec
area: events-pipeline
status: draft
created: 2026-08-05
updated: 2026-08-06
tags:
  - area/events-pipeline
  - area/orders
  - area/tracking
  - area/users
  - type/spec
  - status/draft
propagates-to:
  - "[[events-pipeline-design]]"
  - "[[orders-service-design]]"
  - "[[tracking-service-design]]"
related:
  - "[[events-pipeline-design]]"
  - "[[orders-service-design]]"
  - "[[tracking-service-design]]"
  - "[[floci-vs-ministack-spike-findings]]"
  - "[[env-files]]"
---

# Email payload enrichment

The rebranded email mockups in `assets/email/emails.pen` render data the SQS
envelopes do not carry. This spec inventories that gap, decides what to
transport, what to model, and what to hardcode — then specifies the change per
producer.

## Problem

Every transactional template was redesigned from a plain-text block into a
branded document: a receipt with line items, a delivery timeline, an account
summary. The payloads behind them were sized for the old templates. Rendering
the new ones against today's envelopes would leave most fields blank.

The gap is not uniform. Some data already exists in a producer's database and
merely fails to reach the queue; some does not exist anywhere; and one field
(shipping cost) is displayed by the mockup but absent from the domain, which
would make the email's own arithmetic wrong.

## Inventory

Established by reading each producer's schema against each mockup's text nodes.

### Already persisted — transport only

| Field | Source | Service |
| --- | --- | --- |
| Full name | `User.fullName` | Users |
| Member since | `User.createdAt` | Users |
| Account id | `User.id` (`usr_…`) | Users |
| Line items | `OrderDetail` + `Product.Name`, `Product.UnitPriceCents` | Orders |
| Subtotal, tax | `Order.SubtotalCents`, `Order.TaxCents` | Orders |
| Shipping address | `Order.ShippingAddress`, `Tracking.shipping_address` | Orders, Tracking |
| Status timeline | `TrackingHistory` — one row per transition, each with `datetime` | Tracking |

`Tracking.history` is already loaded with `lazy="selectin"`, so serializing the
full timeline costs the publisher no extra query. An earlier reading of this
gap assumed the timeline was unavailable because an event describes a single
transition; that was wrong — the history table holds every prior step.

### Not persisted anywhere

| Field | Decision |
| --- | --- |
| Tracking number | **New column** on `tracking` (see below) |
| Estimated delivery | **Computed** at render time as `PLACED + 7 days` |
| Shipping cost | **New column** on `orders`, sourced from `Configuration` |
| Carrier | Template constant — `"FedEx Express"` |
| Ship from | Template constant — `"San Juan, PR"` |
| CTA destinations | Placeholder `https://app.3mrai.com/…` until the web app exists |

## Decisions

### Shipping becomes a real domain field

The mockup shows `Subtotal / Shipping / Tax / Total`. `Order.TotalCents` is
`subtotal + tax`, with no shipping component. Displaying a $15.00 shipping line
above a total that excludes it produces an email whose figures do not add up —
a receipt that fails the reader's own arithmetic is worse than one that omits a
row.

So shipping is modelled rather than faked: a `shipping_cents` column on
`orders`, and `total = subtotal + tax + shipping` in `CreateOrderService`. The
$15.00 rate is read from the `configuration` table through
`IConfigurationReader`, exactly as `tax_rate` already is. That keeps one pattern
for business parameters instead of introducing a hardcoded second one, and lets
the rate change without a redeploy.

This is the only change here that alters what an order costs. It is deliberate:
the alternative is an email that lies about its own total.

### Tracking number is minted by Tracking

A `tracking_number` column on `tracking`, NOT NULL and unique, generated in
`init-tracking` alongside the row itself. Since a tracking record is created at
`PLACED` — long before any carrier is involved — the value is our own
identifier, not a carrier's. Generating it at creation keeps it always present,
so no template has to branch on its absence.

### Estimated delivery is computed, not stored

`TrackingHistory` already records when `PLACED` happened. The pipeline derives
`PLACED + 7 days` at render time. Persisting it would duplicate a value nothing
can currently change; a column becomes justified the day delivery estimates need
to shift (delays, carrier differences), and adding it then is a smaller change
than keeping a redundant column correct until then.

### CTA links point at a placeholder host

No web app exists yet, so no CTA has a real destination. The buttons render
against `https://app.3mrai.com/…` rather than an empty or literal-`None` href:
a broken-looking link is no worse for the reader than a dead button, and when
the frontend ships only the base URL changes. Omitting the buttons entirely
would mean re-adding them to five templates later.

## Payload changes

The **envelope** is `snake_case` everywhere — that is the contract shared by all
producers. Payloads are not uniform: `ORDER_CREATED` and
`TRACKING_STATUS_CHANGED` are `snake_case`, while `USER_CREATED` and
`AUTH_OTP_REQUESTED` have always been camelCase (`fullName`, `ttlSeconds`).

Each payload keeps its own existing casing. Mixing both inside one object would
leave it permanently inconsistent, and renaming the established keys would break
every consumer schema in flight for no gain.

### `USER_CREATED` (Users)

Current: `fullName`, `email` — camelCase.

Add `userId` and `createdAt`. Both are already in hand in `register.ts` — `id`
is minted there and `createdAt` comes off the row `create` returned. Feeds the
mockup's "Account ID" and "Member Since" rows.

Both registration paths publish it: `register.ts` and
`register-passwordless.ts` must emit the identical shape, since both produce
the same welcome email.

### `ORDER_CREATED` (Orders)

Current: `order_id`, `user_id`, `email`, `total_cents`, `created_at`.

Add:

- `full_name` — from the `GetUserById` round trip `CreateOrderService` already
  makes for `caller.Email`. No new call.
- `subtotal_cents`, `tax_cents`, `shipping_cents` — the receipt's breakdown.
- `shipping_address` — `Order.ShippingAddress`.
- `items[]` — `{ name, quantity, unit_price_cents }` per line.

`items[]` is the only addition needing more than a field copy: `OrderDetail`
stores `ProductId`, not the product's name, so the publisher joins against
`Products`. The products are already loaded in `CreateOrderService`'s pricing
loop, so the join is in-memory rather than a second query.

### `TRACKING_STATUS_CHANGED` (Tracking)

Current: `status`, `previous_status`, `changed_at`, `email`.

Add:

- `full_name` — from the existing `GetUserById` gRPC call.
- `order_id` — present on the envelope but not the payload; the template shows
  it in the body.
- `tracking_number` — the new column.
- `shipping_address` — `Tracking.shipping_address`.
- `history[]` — `{ status, datetime }` per entry, from `Tracking.history`.

`history[]` is what makes the five-step timeline renderable. Without it a
transition event can only describe its own step, and the template would have to
invent the rest.

### `AUTH_OTP_REQUESTED` (Cognito challenge Lambda)

Current: `email`, `code`, `ttlSeconds` — camelCase.

Add `full_name` from `event.request.userAttributes`.

**The attribute was not populated when this spec was first written**, and the
consequence was a login-code email that greeted everyone as "Hello,". Users'
`AdminCreateUser` wrote only `email`, `email_verified` and
`custom:app_user_id`: `register.ts` had the name, persisted it and published it
on `USER_CREATED`, but the `AuthProvider` port's `signUp(email, password,
appUserId)` had no parameter to carry it.

That was an ordering artefact rather than an oversight — `signUp` predates the
OTP flow, and until that Lambda existed nothing outside Users needed the name in
Cognito. The Lambda is the first consumer that cannot reach Postgres: it runs
inside Cognito with no SDK and no database, so it sees only what Cognito stores.

**Now fixed.** `signUp` takes a fourth `fullName` argument, `AdminCreateUser`
writes the standard `name` attribute, and both registration paths forward it —
`register-passwordless` most of all, since those users sign in exclusively
through OTP and receive that email every time.

Two caveats stand. Existing users have no `name` attribute, so the fallback is
still load-bearing for them; backfilling would need
`AdminUpdateUserAttributes`. And the fallback remains `""` rather than
`undefined`, because `JSON.stringify` drops undefined keys, the key would vanish
from the wire, and the consumer's schema would reject the whole envelope —
costing the user their login code, not just a greeting.

The code itself is unchanged and stays subject to its existing handling: never
logged, never persisted, redacted before the event document is written.

## Mockup corrections

Two mismatches between the design and the backend, to fix in the `.pen` rather
than in code:

- **OTP expiry.** The mockup reads "This code expires in 10 minutes";
  `OTP_CODE_TTL_SECONDS` is 300. The template must render the real TTL, which
  the payload already carries.
- **Template naming.** The OTP screen is a *login* code (Cognito's
  `CUSTOM_AUTH` flow issues tokens on success), not account verification. The
  frame was renamed to "OTP Login Email" and its copy now says sign in;
  no account-verification flow exists in the repo.

## Deferred — logo hosting (not in scope here)

Every template renders the brand as a text lockup ("3M" white + "RAI" orange) rather than an
image. This is deliberate: icon fonts, inline SVG, and remote images all fail or are blocked
across mail clients, so `assets/img/standalone-logo.png` is not referenced by any template
and no image work is part of this spec.

Hosting the logo was considered and **deferred**, with the shape of the decision recorded now
so it is not lost:

- **When it happens: S3 private + CloudFront with OAC, never a public bucket.** The logo must
  stay an *enhancement* — a client that blocks remote images must still see the brand via the
  existing text lockup, never a broken-image gap where the wordmark used to be.
- **Locally it degrades to the S3 bucket URL directly** (no CloudFront available to validate
  locally — see the CloudFront finding in [[floci-vs-ministack-spike-findings]]), with the
  base URL supplied via a generated env var, the same mechanism as every other
  environment-specific value (see [[env-files]]).
- **Trigger condition: build it when the web app exists**, not before. The web app will need
  its own CloudFront distribution regardless, so standing one up solely to serve a 42px logo
  that many clients block anyway is disproportionate before that distribution exists for
  another reason.

## Testing

Per the repo's three-layer rule, each changed producer needs unit coverage of
the enriched payload, and the pipeline needs snapshot coverage of every catalog
entry rendering with the new fields. The two schema changes (`shipping_cents`,
`tracking_number`) each need a migration plus a test that a created row carries
the new value.

The `ORDER_CREATED` shipping change alters an existing assertion surface:
any test asserting `total == subtotal + tax` must be updated to include
shipping, and that update is the signal the domain change landed.

## Related

- [[events-pipeline-design]]
- [[orders-service-design]]
- [[tracking-service-design]]
- [[audit-fields]]
- [[testing]]
- [[floci-vs-ministack-spike-findings]] — CloudFront management-plane-only finding behind the
  local-degradation decision above
- [[env-files]] — mechanism for the generated base-URL env var when logo hosting is built
