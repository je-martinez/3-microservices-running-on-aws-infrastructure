---
title: Cart Endpoints + Money Representation Design
type: spec
area: orders
status: active
created: 2026-08-25
updated: 2026-08-25
tags:
  - type/spec
  - area/orders
  - status/active
propagates-to:
  - "[[orders-service-design]]"
  - "[[nano-id]]"
  - "[[money-representation]]"
related:
  - "[[orders-service-design]]"
  - "[[nano-id]]"
  - "[[soft-delete]]"
  - "[[audit-fields]]"
  - "[[db-naming]]"
  - "[[testing]]"
  - "[[logging-context]]"
  - "[[money-representation]]"
---

# Cart Endpoints + Money Representation Design

## Context

The frontend currently computes cart state and money formatting itself. The goal of this
design: the backend persists the cart, does every calculation, and the frontend only reads.
A user may have at most **one active cart** at a time. Work happens in the Orders service
(.NET 10 Minimal APIs, Aurora MySQL, EF Core, Clean Architecture). Branch:
`feature/cart-endpoints`.

Scope check performed during brainstorming: only Orders exposes money over HTTP. Users and
Tracking have no monetary amounts. events-pipeline consumes the `ORDER_CREATED` SQS event,
which is an internal contract and is deliberately **not** changed by this work.

## Part A — The `Money` object (cross-cutting within Orders)

A `record Money(long Cents, string Amount, string Formatted, string Currency)` lives in
`Orders.Domain`, with a `Money.FromCents(long)` factory.

It **replaces** each loose `*_cents` field in the HTTP DTOs of Orders:

- `OrderDto`: subtotal, tax, shipping, total
- `OrderLineDto`: subtotal, tax, total
- `ProductDto`: unitPrice

This is a **breaking change** to existing response shapes. Accepted deliberately.

JSON shape:

```json
{ "cents": 3998, "amount": "39.98", "formatted": "$39.98", "currency": "USD" }
```

### Boundaries

Important, and the part a future reader must not "clean up":

- `Money` lives **only** in the DTO/HTTP layer. Persistence stays `bigint _cents` columns;
  entities keep `long`. Money is a presentation concern, not a storage one.
- The `ORDER_CREATED` SQS envelope does **not** change. It is a contract with
  events-pipeline; changing it would widen scope for no benefit and break a consumer that
  has its own tests.
- `Currency` is the constant `"USD"` — there is no multi-currency in this repo.
- `Formatted` is produced with the **invariant / `en-US`** culture explicitly, so the string
  never depends on the container's locale. A container with a different default culture
  would otherwise silently emit `$39,98`.

> [!done] Propagated
> This spec's `Money` contract (Part A) landed in [[money-representation]] (new cross-cutting
> convention), and Part B (the Cart aggregate + `/v1/cart` routes) landed in
> [[orders-service-design]] and [[nano-id]] (the `crt_`/`cti_` prefixes). See those notes'
> `## Related` sections for the back-links. Propagated 2026-08-25.

## Part B — The Cart aggregate (new, in Orders)

### Entities

- `Cart` — id with `crt_` prefix, `user_id` (internal `usr_`), `cognito_sub`, standard audit
  fields + soft-delete.
- `CartItem` — id with `cti_` prefix, `cart_id` (FK), `product_id`, `quantity`, standard
  audit fields + soft-delete.

`CartItem` stores **no price**. Price is read live from the catalogue on every read, so the
user always sees the real current price and there is never a frozen price that disagrees
with what is charged.

### The "one active cart per user" invariant

Enforced by a **unique index in the database**, not by a check in C# code. A generated
column `active_user_id` equals `user_id` when `deleted_at IS NULL` and is `NULL` otherwise,
with a unique index over it. MySQL ignores `NULL`s in unique indexes, so a user may have N
deleted carts and at most one live one.

Rationale: a C# "does an active cart already exist?" check is a race under two concurrent
requests. The database is the only place the invariant can actually hold.

The same treatment applies to `cart_item`: a unique index over (`cart_id`, `product_id`)
restricted to active rows.

### Layering

Follows the service's Clean Architecture exactly as the rest of Orders does: entities in
`Orders.Domain`; DTOs and ports in `Orders.Application`; `CartReadService` /
`CartWriteService` in `Orders.Infrastructure` (they touch the DbContext, so they cannot
live in Application); endpoints in `Orders.Api`.

## HTTP surface — three routes under `/v1/cart`

All authenticated via `x-user-id` through the existing `CallerContextMiddleware`.

### `GET /v1/cart` → always 200

If the user has no active cart, returns an **empty** cart (`id: null`, `items: []`, zeroed
totals) rather than 404. An empty cart is not an error, and this way the frontend does not
branch.

### `PUT /v1/cart` → full replacement of the item set

Body: `{ "items": [{ "productId": "prd_...", "quantity": 2 }, ...] }` (camelCase on the
wire — see [[money-representation]])

- No cart existed → create it. A cart existed → sync its lines against the received array
  (insert new ones, update quantities, soft-delete the ones no longer present).
- `quantity: 0` removes that line (soft-delete), rather than being rejected. This lets the
  frontend send its desired state verbatim without having to filter zeros out first. Only a
  **negative** `quantity` is a `400` — zero is a valid instruction, not an error.
- `items: []` → soft-delete the whole cart and return 200 with the empty cart. This is the
  user's "if all items are removed, delete the cart" rule, and replacement semantics
  produce it naturally — no special case needed.
- `400` on an invalid body: `items` missing/null, a **negative** `quantity`, or a duplicated
  `productId` within the array. Duplicates are **rejected** rather than summed: under
  full-replacement semantics, two entries for the same product is client ambiguity, not an
  intent.
- `404 unknown_user` when the Cognito sub does not resolve in Users (same mapping
  `POST /v1/orders` already uses).

A non-existent product is **not** a 404. The line is persisted and comes back flagged
unavailable, exactly like an out-of-stock product. The problem is a field of the line, not
a failure of the operation. This was an explicit user requirement.

#### `PUT` body rules

| Input | Result |
|---|---|
| `quantity` ≥ 1 | The line is created or updated to that quantity |
| `quantity: 0` | The line is removed (soft-delete) |
| `productId` absent from the array | The line is removed — this is full replacement |
| Every line `0` (or `items: []`) | The whole **cart** is deleted |
| `quantity` negative | `400 invalid_request` |
| Duplicated `productId` | `400 invalid_request` |
| `items` missing or `null` | `400 invalid_request` |

`quantity: 0` and omitting the product from the array are deliberately redundant — both
remove the line. The frontend may send its list with zeros left in, or pre-filter them out
before sending; both are correct, so it does not need to special-case zero client-side.

#### The "no live lines" invariant

All the ways of emptying a cart converge on **one** rule, evaluated once, after the
replacement is applied — not three special cases to implement separately: **a cart with no
live lines does not exist.** Whether the client sent `items: []`, sent every line at
quantity `0`, or removed the last product by omission, the result is the same: the service
deletes the cart and returns `200` with the empty cart (`id: null`, `items: []`, zeroed
totals). A future reader must not re-implement this as three separate branches in the
handler — it is a single post-condition check on the resulting line count.

### `DELETE /v1/cart` → 204

Soft-deletes the active cart and its items. Idempotent: 204 as well when there was no cart.

### Hook into order creation

`POST /v1/orders`, on successful order confirmation, soft-deletes the user's active cart
**within the same transaction**. If the user had no cart (ordered directly with `lines`),
nothing happens. Inside the transaction deliberately: a created order that left the cart
alive would make the user re-purchase on reload.

There is no `/v1/cart/checkout` route. The user chose to keep the cart at three verbs and
let `POST /v1/orders` consume the cart.

#### Three routes, four triggers, one invariant

There are three explicit routes that can leave a user without an active cart — and a fourth
trigger folded into the first of them — and all of them must route through the same
deletion code path rather than duplicating the logic:

1. `PUT` where every resulting line is removed. This single route covers **two** trigger
   forms: (a) the client sent `items: []`, or (b) the client sent every line at
   `quantity: 0` (see [The "no live lines" invariant](#the-no-live-lines-invariant) above —
   both forms hit the same post-condition check, not two branches).
2. `DELETE /v1/cart`.
3. `POST /v1/orders`, deleting the cart inside its own transaction on successful order
   creation.

All of these land on the same "a cart with no live lines does not exist" invariant — one
rule with several triggers, not several independent deletion implementations.

## Availability and calculation

Every cart read (`GET`, and the `PUT` response) makes **one** catalogue query for all the
cart's product ids — a `WHERE Id IN (...)`, never one query per line — resolving price,
name, image, stock and availability in a single round trip.

Because the frontend renders a product preview in the cart, every line also carries `image`
— the existing `ProductImageDto` from `Orders.Application.Orders` (`uri`, `width`, `height`,
`blurhash`), reused as-is rather than reduced to a bare URL string, since `blurhash` is the
placeholder the client paints while the real image loads. `uri` is an absolute URL, composed
on read from `ASSETS_BASE_URL` plus the bucket-relative key stored on the product, the same
way `ProductReadService` already composes it for `ProductDto` — never persisted, since Floci
re-mints the bucket on every apply and a stored absolute URL would be dead data after a
rebuild. `image` is nullable and omitted when null, following `ProductDto`: a product may
have no artwork yet (`Product.Image` is `ProductImage?`).

Each line carries an explicit verdict:

| Situation | `available` | `unavailableReason` |
|---|---|---|
| Sufficient stock | `true` | *(omitted)* |
| Product no longer exists / is deleted | `false` | `unknown_product` |
| `unitsInStock == 0` | `false` | `out_of_stock` |
| `0 < unitsInStock < quantity` | `false` | `insufficient_stock` |

Per the logging/DTO convention ([[logging-context]]), `unavailableReason` is **omitted**
when the line is available, never null.

Every line always carries `unitsInStock` so the frontend can say "only 3 left" without
another call. For `unknown_product`, price, name, and image come back null and the line
contributes 0 to the totals — there is no catalogue row left to read any of that from.

Cart-level totals:

- `subtotal` = sum of **available** lines only
- `tax` from the `tax_rate` key of the `configuration` table
- `shipping` from the `shipping_cents` key of the same table
- `total` = subtotal + tax + shipping

Unavailable lines stay out of the totals: charging for what cannot be shipped is worse than
showing a smaller total. A line always reports its own `unitPrice` and `subtotal` (what it
would cost), so the frontend can render the line normally with an unavailable badge — what
changes is only that the line is excluded from the cart-level `subtotal`/`tax`/`total`. The
example above demonstrates exactly this: the unavailable Mechanical Keyboard line shows its
own `subtotal` of $89.99, yet the cart `subtotal` is $39.98. The one exception is
`unknown_product`: there `unitPrice`, `subtotal`, and `image` are all null/absent, because
there is no catalogue row left to read any of that from; every other unavailable line
reports its money and artwork normally.

Reuses `OrderPricing.PriceLine` as-is. Shipping is applied **once** at cart level, never per
line — the same rule `Order.ShippingCents` already documents (a line whose total exceeded
unitPrice × quantity could not be explained from its own fields).

`canCheckout` (cart level): `true` only when there is at least one line **and** every line
is available. It is the signal that tells the frontend whether to enable the button, instead
of the frontend walking the lines.

**Honest limitation**: `canCheckout: true` does **not** guarantee
that `POST /v1/orders` will not return `409 insufficient_stock`. Between reading the cart
and checking out, another buyer can take the last unit. The cart informs; the only truth
about stock remains the `SELECT ... FOR UPDATE` inside the order transaction. This window
cannot be closed without reserving stock, which was explicitly rejected.

### Example `CartDto` response

> [!note] Wire casing is camelCase
> As shipped, the HTTP DTO fields below are **camelCase** (`productId`, `unitsInStock`,
> `unitPrice`, `unavailableReason`, `canCheckout`), matching every other Orders HTTP response —
> see [[money-representation]] and [[orders-service-design#Wire casing]]. This example
> originally used snake_case as a drafting artifact; corrected 2026-08-25 to match
> `services/orders/openapi.yaml`, the generated source of truth. Fields and semantics are
> otherwise unchanged.

```json
{
  "id": "crt_7gK3mP1vXz9wLq2bN8rRt4Yc",
  "items": [
    {
      "productId": "prd_9fA2cD4eXy7zLm1qP0sTu3Rb",
      "name": "Wireless Mouse",
      "quantity": 2,
      "unitsInStock": 14,
      "available": true,
      "unitPrice": { "cents": 1999, "amount": "19.99", "formatted": "$19.99", "currency": "USD" },
      "subtotal": { "cents": 3998, "amount": "39.98", "formatted": "$39.98", "currency": "USD" },
      "image": {
        "uri": "https://assets.example.com/products/wireless-mouse.jpg",
        "width": 800,
        "height": 600,
        "blurhash": "LEHV6nWB2yk8pyo0adR*.7kCMdnj"
      }
    },
    {
      "productId": "prd_1kL5nB8gWq3xVc6mZ2yHj9Ta",
      "name": "Mechanical Keyboard",
      "quantity": 1,
      "unitsInStock": 0,
      "available": false,
      "unavailableReason": "out_of_stock",
      "unitPrice": { "cents": 8999, "amount": "89.99", "formatted": "$89.99", "currency": "USD" },
      "subtotal": { "cents": 8999, "amount": "89.99", "formatted": "$89.99", "currency": "USD" },
      "image": {
        "uri": "https://assets.example.com/products/mechanical-keyboard.jpg",
        "width": 900,
        "height": 900,
        "blurhash": "L6PZfSi_.AyE_3t7t7R**0o#DgR4"
      }
    }
  ],
  "subtotal": { "cents": 3998, "amount": "39.98", "formatted": "$39.98", "currency": "USD" },
  "tax": { "cents": 320, "amount": "3.20", "formatted": "$3.20", "currency": "USD" },
  "shipping": { "cents": 599, "amount": "5.99", "formatted": "$5.99", "currency": "USD" },
  "total": { "cents": 4917, "amount": "49.17", "formatted": "$49.17", "currency": "USD" },
  "canCheckout": false
}
```

## Persistence, errors, observability

**Schema.** Two new tables via one EF migration (`AddCart`), following repo conventions
([[db-naming]], [[audit-fields]], [[soft-delete]]): `snake_case` columns, full audit fields,
soft-delete only (the `orders_app` user has no `DELETE` grant, so "delete" is always
`deleted_at`).

- `cart` — `id` (`crt_`), `user_id`, `cognito_sub`, audit fields, generated `active_user_id`
  + unique index.
- `cart_item` — `id` (`cti_`), `cart_id` (FK), `product_id`, `quantity`, audit fields,
  unique index over active (`cart_id`, `product_id`).

The `crt_` / `cti_` prefixes are added to `NanoId` alongside the existing `prd_` / `ord_` /
`odd_`, and to [[nano-id]].

**Concurrency.** Two simultaneous `PUT`s from the same user could both try to create a cart;
the unique index makes one fail with a duplicate-key violation. Catch that specific
violation and retry **once** by reading the cart that won. That is the correct resolution:
the second request wanted a cart for that user, and one now exists.

**Writes.** `PUT` runs in a transaction and under `AmbientActor.RunAsync` with a new
`AuditActor.UpdateCart`, so `created_by`/`updated_by` read `orders_api:update_cart` rather
than the buyer's id — the same treatment `CreateOrder` already uses.

**Observability.** Flow logs with `app_event` = `update_cart_started|_succeeded|_failed`
plus `reason` on failures, and the workflow span via `IWorkflowTracer`, following
`CreateOrderService`. `GET` carries no flow logs (it is a read, like `my-orders`). Never log
prices or the cart body, per [[logging-context]].

> [!warning] Correction (found by the user after the branch was pushed) — the claim above is false
> This spec's own words are left as the historical record of what was planned and what shipped
> from it, but the claim is wrong on its own terms: `OrderReadService.GetMyOrdersAsync` (the
> `my-orders` endpoint cited as precedent) already wraps itself in a `list_my_orders` workflow
> span and emits a `list_my_orders_succeeded` line carrying `order_count`. The precedent was
> never opened before being cited, and its confident phrasing then went unchallenged through
> implementation and every per-task review. `GET`/`DELETE /v1/cart` shipped with **no span and
> no log line at all**.
>
> **Fixed before final merge**: `GET /v1/cart` gets a `read_cart` span plus one
> `read_cart_succeeded` line carrying `item_count` (no `_started`/`_failed` — a read has no
> intermediate step and no failure of its own to name); `DELETE /v1/cart` gets the full write
> triad (`delete_cart_started`/`_succeeded`, span `delete_cart`), because deleting a user's cart
> needs a trail even though the method is a few lines long. Full read/write log-shape rule now
> lives in `services/orders/CLAUDE.md` §4. Lesson:
> [[2026-08-25-reads-are-not-exempt-from-observability]].

## Testing — all three layers for all three routes

Per `services/orders/CLAUDE.md` §2b and [[testing]]:

1. **Unit/integration** (xUnit + Testcontainers-MySQL): active-cart uniqueness under
   concurrent writes; the empty `PUT` (`items: []`) that deletes the cart; a `PUT` with
   `quantity: 0` on one line removing just that line while the rest of the cart survives; a
   `PUT` where every line is `quantity: 0` deleting the whole cart, same as the empty-array
   case; a negative `quantity` returning `400`; all four availability verdicts; totals
   excluding unavailable lines; `canCheckout`; and that `POST /v1/orders` leaves the cart
   deleted.
2. **Internal E2E** against the service URL with a faked `x-user-id`.
3. **Gateway E2E** with a real Cognito JWT in `e2e/tests/gateway/` — without this the change
   is incomplete.

Plus `Money` tests: rounding, `Formatted` under invariant culture, and confirmation that
existing contracts (`TrackingContractTests`, the events-pipeline `ORDER_CREATED` tests) stay
green, since the SQS event does **not** change.

`openapi.yaml` must be regenerated via `dotnet build` and committed with the code (Orders
CLAUDE.md §2a) — three new routes plus the reshaped Money DTOs.

## Out of scope (YAGNI)

No stock reservation. No cart expiry/TTL. No merging an anonymous cart on sign-in. No
checkout route. No multi-currency. No changes to Users or Tracking.

## Related

- [[orders-service-design]]
- [[nano-id]]
- [[soft-delete]]
- [[audit-fields]]
- [[db-naming]]
- [[testing]]
- [[logging-context]]
- [[money-representation]] — the cross-cutting convention this spec's `Money` contract
  propagated into.
- [[2026-08-25-cart-innodb-generated-column-fk-restriction]] — the InnoDB errno 1215 lesson
  from implementing the `active_cart_id` generated column.
- [[2026-08-25-route-works-in-process-but-404s-at-gateway]] — the missing-gateway-route lesson
  from verifying the three `/v1/cart` routes.
- [[2026-08-25-preview-must-mirror-charging-roundings-application-point]] — the tax-rounding
  drift between `CartPricing.Totalize` and `OrderPricing.PriceLine`, found and fixed in final
  review before merge.
- [[2026-08-25-reads-are-not-exempt-from-observability]] — `GET`/`DELETE /v1/cart` shipped
  with no observability at all; the amendment above documents the fix.
