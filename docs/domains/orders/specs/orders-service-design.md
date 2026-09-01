---
title: Orders Service Design
type: spec
area: orders
status: accepted
created: 2026-06-26
updated: 2026-08-26
tags: [type/spec, area/orders, status/accepted]
related:
  - "[[2026-08-25-response-caching-layer-design]]"
  - "[[x-cache-response-header]]"
  - "[[2026-08-25-account-deletion-design]]"
  - "[[2026-08-15-request-id-correlation-design]]"
  - "[[soft-delete]]"
  - "[[nano-id]]"
  - "[[audit-fields]]"
  - "[[db-naming]]"
  - "[[cqrs]]"
  - "[[versioning]]"
  - "[[ADR-0003-grpc-inter-service]]"
  - "[[ADR-0006-read-write-replicas]]"
  - "[[logging-context]]"
  - "[[env-files]]"
  - "[[testing]]"
  - "[[ADR-0019-distributed-tracing-opentelemetry]]"
  - "[[clean-architecture-divergence]]"
  - "[[money-as-integer-cents]]"
  - "[[grpc-api-key-authorization]]"
  - "[[for-update-pessimistic-locking]]"
  - "[[2026-07-14-orders-service-milestone-design]]"
  - "[[2026-07-16-orders-list-products-endpoint-design]]"
  - "[[tracking-service-design]]"
  - "[[users-service-design]]"
  - "[[events-pipeline-design]]"
  - "[[2026-08-10-product-catalogue-image-categories-design]]"
  - "[[2026-08-12-custom-business-metrics-cloudwatch-design]]"
  - "[[2026-08-18-distributed-tracing-spans-design]]"
  - "[[2026-08-18-distributed-tracing-spans]]"
  - "[[money-representation]]"
  - "[[nano-id]]"
  - "[[2026-08-25-cart-endpoints-design]]"
---

# Orders Service Design

> [!note] Live since the Orders Service milestone
> The Orders service shipped in the Orders Service milestone (merged via PR #51, plus follow-up
> commits) as a .NET Core 10 Minimal API on Aurora MySQL (Floci-emulated locally), with a live
> Users gRPC client, OpenTelemetry tracing, and the three-layer test suite ([[testing]]). It
> diverges from this spec's original design in several ways — see
> [[#Deltas from the original design (superseded)|Deltas from the original design]] below and the
> service-local decision notes it links to. `services/orders/CLAUDE.md` is the day-to-day
> reference for stack/commands; this note is the durable service-design record.
>
> **Not yet built:** Orders' own gRPC **server** surface (`GetOrderById`) and Product CRUD — both
> explicitly out of scope for the shipped milestone. `ORDER_CREATED` SQS publish shipped in a
> later commit (`528153c`) — see [Events](#events) below. The product catalogue's display image
> and category facets shipped later (PR #65) — see the note under [Product](#product) below;
> category **filtering** on `GET /v1/products` remains out of scope.
>
> **Cart shipped 2026-08-25** — three `/v1/cart` routes plus a repo-wide `Money` wire type. See
> [Cart](#cart) below and [[money-representation]]. Full design:
> [[2026-08-25-cart-endpoints-design]].

## Summary

The Orders service is responsible for creating and managing orders submitted by users. It exposes a REST API built with .NET Core 10 Minimal APIs, persists data in Aurora MySQL using two replicas (one for reads, one for writes), and publishes an `ORDER_CREATED` event to SQS whenever a new order is placed. Inter-service data retrieval is handled via gRPC.

## Stack & Data Store

| Concern | Choice |
|---|---|
| Runtime | .NET Core 10 — Minimal APIs |
| ORM | Entity Framework Core |
| Database | Aurora MySQL |
| Read traffic | Read replica |
| Write traffic | Write replica |
| Event bus | AWS SQS |
| Inter-service RPC | gRPC |
| Auth | AWS Cognito (via API Gateway) |

Database credentials are stored in AWS Secrets Manager and pulled at startup via AWS Parameter Store. See [[ADR-0006-read-write-replicas]] for the replica strategy and [[ADR-0007-secrets-parameter-store]] for secrets management.

## API / Endpoints

All routes are versioned under the `/v1` prefix. See [[versioning]] for the versioning convention.

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/orders` | Create a new order. Publishes `ORDER_CREATED` to SQS via `SqsEventPublisher` (`Orders.Infrastructure/Messaging/SqsEventPublisher.cs`) — see [Events](#events) below. Accepts an optional `x-test-mode` header, guarded by `E2E_TESTING_ENABLED`, propagated as `test_mode` on the HTTP call to Tracking's `init-tracking` — see [[tracking-service-design#TestMode automatic progression]]. Also resolves the caller's delivery address via `GetUserById` and snapshots it on the order — see [Delivery address flow](#delivery-address-flow-users--orders--tracking) below. |
| `GET` | `/v1/orders/my-orders` | List all orders belonging to the authenticated user. |
| `GET` | `/v1/orders/{order_id}` | Fetch a single order. Returns `404` if the order does not belong to the requesting user — see the ownership note below. |
| `GET` | `/v1/products` | List the active product catalog. Private (requires `x-user-id`), no ownership filtering — products have no owner. See [[2026-07-16-orders-list-products-endpoint-design]]. |
| `GET` | `/v1/cart` | The caller's active cart, fully priced and calculated. Always `200` — an empty cart (`id: null`, `items: []`) rather than `404`. See [Cart](#cart) below. |
| `PUT` | `/v1/cart` | Full replacement of the cart's line set. `quantity: 0` removes a line; an empty resulting cart is deleted. `400` on a negative quantity, a duplicated `productId`, or missing/null `items`; `404 unknown_user` **only on a request that carries lines** (same Cognito-sub-not-found mapping `POST /v1/orders` uses) — an emptying `PUT` (`items: []`, or every line at `quantity: 0`) never resolves identity and always succeeds regardless of whether the caller is a known user. See [Cart](#cart) below. |
| `DELETE` | `/v1/cart` | Deletes the caller's active cart and its lines. `204`, idempotent (also `204` when there was no cart). |
| `DELETE` | `/v1/orders/by-user` | **Internal.** Explicitly **NOT on the API Gateway** — see [Account-deletion cascade (internal)](#account-deletion-cascade-internal) below. Soft-deletes every order, order line, and cart belonging to a user, matching `cognito_sub OR user_id`. Authenticated with the shared `GRPC_API_KEY`, the same secret [[grpc-api-key-authorization]] already covers — but validated **inbound** here for the first time, not merely presented outbound. |
| `GET` | `/v1/orders/health` (gateway) | Liveness/readiness probe. **Gateway-published path is prefixed**, not the bare `/v1/health` the service serves internally — nginx rewrites the prefixed gateway path down to the service's unprefixed `/v1/health` (health-only rewrite; see [[tracking-service-design#Gateway-prefixed health path, not bare `/v1/health`]] for the full rationale, which applies identically here: an unprefixed gateway route would fall through nginx's default proxy and silently resolve to Users). Returns `200 { "status": "ok" }` when healthy. No auth required. Used by ALB/Fargate as health check target. |

> [!note] Authorization check — filter in the query, not fetch-then-compare
> `GET /orders/{order_id}` filters `WHERE id = @orderId AND cognito_sub = @callerSub`
> directly in the query, so another user's order returns zero rows and the endpoint answers
> **`404`**, not `403` — indistinguishable from "does not exist," so existence of other users'
> orders is never leaked. This **supersedes** this spec's original `403 Forbidden` choice; see
> [[2026-07-14-orders-service-milestone-design]].

## gRPC Methods

Defined in the `OrdersService` proto. Used by other microservices to fetch order data without going through the public HTTP API. See [[ADR-0003-grpc-inter-service]].

| Method | Request | Response |
|---|---|---|
| `GetOrderById` | `GetOrderByIdRequest { order_id: string }` | `OrderResponse { id, user_id, subtotal, tax, total, created_at }` |

Orders is also a gRPC **client** of Users: `POST /v1/orders` calls `GetUserById` (see
[[users-service-design]]) to resolve the caller. It reaches Tracking over **HTTP**, not gRPC —
Tracking serves no gRPC (see [[tracking-service-design]]). See
[Delivery address flow](#delivery-address-flow-users--orders--tracking) below.

## Delivery address flow (Users → Orders → Tracking)

The delivery address originates in Users, flows through Orders at order-creation time, and ends up
in Tracking — persisted as an independent **snapshot** at each stop, not as a shared reference.

```
Orders.CreateOrder
  → gRPC GetUserById(cognito_sub)     → Users returns { id, email, full_name, address }
  → persist order.shipping_address     (snapshot)
  → POST /v1/trackings/init-tracking   { order_id, shipping_address, test_mode }
      forwarding the caller's x-user-id header
  → Tracking resolves the caller itself, persists tracking.shipping_address (snapshot)
```

1. **Resolve.** `POST /v1/orders` calls Users' `GetUserById` (already the gRPC call Orders makes to
   resolve the caller identity) and reads the `address` field on the response — see
   [[users-service-design]] for the typed `Address` wire shape and its privacy implication.
2. **Snapshot on `Order`.** The resolved address is persisted as `shipping_address` on the `Order`
   row (see [Order](#order) below) at the moment the order is created.
3. **Forward to Tracking.** Orders POSTs to `init-tracking` with `order_id`, the same address, and
   `test_mode` (see [[tracking-service-design#TestMode automatic progression]]). It **forwards the
   `x-user-id` header** it received from the gateway rather than sending an identity in the body:
   Tracking resolves the caller itself, against Users, exactly as Orders does. A second call for
   the same order is rejected with `409` — Tracking guards creation for idempotency.
4. **Snapshot on `Tracking`.** Tracking persists its own `shipping_address` copy — see
   [[tracking-service-design]] for that table.

> [!note] Snapshots are deliberate, not accidental denormalization
> Both copies (`Order.shipping_address` and `Tracking.shipping_address`) are point-in-time copies
> **by design**. If the user later edits their profile address, the historical order and its
> tracking record must still show where the shipment was actually sent — that is only possible if
> each stop keeps its own copy taken at the time it acted. A future reader should not "clean this
> up" into a single shared reference; that would silently rewrite delivery history whenever a user
> edits their address.

## Cart

A user's in-progress selection of products, persisted server-side so the frontend does every
calculation-free render and computes nothing itself. At most **one active cart per user**. Full
design: [[2026-08-25-cart-endpoints-design]].

### Cart aggregate

- **`Cart`** — `id` (`crt_`), `user_id` (internal `usr_`), `cognito_sub`, standard audit fields,
  soft-delete.
- **`CartItem`** — `id` (`cti_`), `cart_id` (FK), `product_id`, `quantity`, standard audit
  fields, soft-delete. Stores **no price**. Every read resolves price, name, image, and stock
  live from the catalogue, in **one batched query** (`WHERE Id IN (...)`) for the whole cart —
  never one query per line. This is the deliberate opposite of `Order`/`OrderDetails`, which
  freeze prices on creation: a cart must always show the real current price so it never
  disagrees with what checkout actually charges, while a past order must keep reporting what it
  really cost regardless of later price changes.

### The one-active-cart invariant — enforced by the database, not C#

A user having at most one live cart is enforced by a **unique index over a stored generated
column**, not by an application-level "does one already exist?" check — that check would race
under two concurrent requests, both reading "no cart" and both inserting. The generated column
`active_user_id` equals `user_id` while the row is live (`deleted_at IS NULL`) and is `NULL`
once soft-deleted; MySQL ignores `NULL`s in a unique index, so a user may accumulate any number
of deleted carts and at most one active one. `cart_item` carries the identical trick one level
down: a generated `active_cart_id` backs a unique index over (`active_cart_id`, `product_id`),
so a cart cannot hold two live lines for the same product while its deleted history stays intact.

> [!warning] InnoDB gotcha this invariant ran into
> A `CASCADE`/default foreign key on the column a stored generated column depends on
> (`cart_item.cart_id` → `active_cart_id`) fails at migration time with errno 1215. See
> [[2026-08-25-cart-innodb-generated-column-fk-restriction]].

**The race the index detects is resolved with a retry, not a 500.** Two concurrent `PUT`s from
a caller with no cart both read `null` and both attempt an insert; the unique index rejects the
loser with a `DbUpdateException`. `CartWriteService` catches that specific violation, rolls
back the losing transaction, re-reads the cart that won, and applies the caller's lines to it
instead — a normal `200`, not an error, for a race the system is designed to handle. Retried
**once**: a second failure means something other than this race, and retrying it again would
mask that. (Before a post-merge review fix, this violation escaped unhandled as a bare `500`
for a race the database was already resolving correctly.)

Detection matches on the **index name** — `CartConfiguration.ActiveUserIdIndexName`
(`"uq_cart_active_user_id"`), a single constant read by both the schema definition and
`CartWriteService.IsActiveCartUniqueViolation` — never on the bare MySQL error number alone.
`cart_item` carries its **own** unique index (two live lines for the same product), whose
violation means something a retry would not fix; matching on the error number alone would
catch that case too and retry it wrongly. If the index-name constant and the schema's actual
index name ever drift apart, the retry silently stops firing and the `500` returns — which is
why it is a shared constant rather than a string literal repeated at each call site.

### One invariant, three triggers — "a cart with no live lines does not exist"

There is exactly one deletion rule, evaluated once as a post-condition, not three special cases
implemented separately. Three routes converge on it, through one code path
(`CartWriteService.DeleteForUserAsync` — static and non-saving, so `POST /v1/orders` composes it
into its own order-creation transaction rather than calling out to a separate save):

1. `PUT /v1/cart` where the resulting line count is zero — whether the client sent `items: []`
   or sent every line at `quantity: 0`. Both forms hit the same post-condition check. Neither
   resolves the caller's identity (see the endpoint table above): identity is needed only to
   stamp a `usr_` id onto a cart being **created**, so an emptying `PUT` never depends on Users
   being reachable, and never 404s for an unresolvable caller.
2. `DELETE /v1/cart`.
3. `POST /v1/orders`, on successful order creation, soft-deletes the caller's active cart
   **inside the same transaction** — a created order that left the cart alive would make the
   user re-purchase on reload. There is no separate `/v1/cart/checkout` route; the user chose to
   keep the cart at three verbs and let order creation consume it.

### Availability verdicts

Each line carries an explicit verdict, checked in this order — **`out_of_stock` before
`insufficient_stock`**, deliberately: reversed, every empty product would report
`insufficient_stock` and the client could not distinguish "gone" from "you asked for too many."

| Situation | `available` | `unavailableReason` |
|---|---|---|
| Sufficient stock | `true` | *(omitted)* |
| Product no longer exists / is deleted | `false` | `unknown_product` |
| `unitsInStock == 0` | `false` | `out_of_stock` |
| `0 < unitsInStock < quantity` | `false` | `insufficient_stock` |

Unavailable lines are excluded from cart-level totals (`subtotal`/`tax`/`total`) — charging for
what cannot ship is worse than showing a smaller total — but each line still reports its own
`unitPrice` and `subtotal` (what it would cost) so the frontend renders it normally with a
badge. The one exception is `unknown_product`: there is no catalogue row left, so `unitPrice`,
`subtotal`, and `image` are all null.

**Tax is rounded per line, then summed** — `CartPricing.Totalize` mirrors
`OrderPricing.PriceLine` (called per line inside `CreateOrderService`, accumulated as
`tax += lineTax`) exactly, rather than rounding once over the cart's whole subtotal. The cart
exists to show what checkout will charge, so its tax must be computed the same way checkout
computes it — not merely with the same rounding *mode*, but at the same rounding *application
point*. Rounding once over the subtotal instead can disagree with the per-line total by a cent
whenever the per-line remainders would each independently round up (worked example and the
general rule: [[money-representation#Rounding point, not just rounding mode]]). This was a real
defect found and fixed in final review before merge — see
[[2026-08-25-preview-must-mirror-charging-roundings-application-point]]. The order's own pricing
(`OrderPricing.PriceLine`) was deliberately left unchanged; it is the incumbent and it is what
actually bills.

**Shipping is reported unconditionally**, so `total = subtotal + tax + shipping` holds with no
exceptions — a deliberate choice over zeroing it, meaning an empty cart reports a non-zero
total. The frontend must not paint `total` as "amount due" beside an empty basket.

`canCheckout` is `true` only when the cart has at least one line and every line is available.
It is a **hint**, not a guarantee — another buyer can take the last unit between reading the
cart and checking out. The only source of truth for stock remains the `SELECT ... FOR UPDATE`
inside the `POST /v1/orders` transaction (see [[for-update-pessimistic-locking]]); this window
was explicitly not closed by reserving stock.

### `Money` — every amount, in cents and dollars

`PUT`/`GET /v1/cart` responses (and every other Orders HTTP DTO — `OrderDto`, `OrderLineDto`,
`ProductDto`) report money as a `Money` object rather than a bare `*_cents` integer:
`{ cents, amount, formatted, currency }`. Cross-cutting convention, not an Orders-only shape:
see [[money-representation]]. Storage is unaffected — [[money-as-integer-cents]] still holds.

### Wire casing

Cart JSON is **camelCase** (`productId`, `unitsInStock`, `canCheckout`, `unavailableReason`),
matching every other Orders HTTP response. The design spec's example body originally showed
snake_case field names; that was a drafting artifact, corrected once the implementation shipped
— the real names are whatever `services/orders/openapi.yaml`'s generated `CartDto`/`CartLineDto`
schemas declare.

### Observability — six flow events, read/write shaped differently

Per [[logging-context]]'s flow-log pattern, the cart emits six `app_event` values across its
three routes, following the read/write distinction: a read gets a span plus one `_succeeded`
line carrying a count, while a write gets `_started`/`_succeeded` and a `_failed` **only where
the flow actually has a failure of its own to name**.

`update_cart` has one — `unknown_user`, when the caller does not resolve — so it carries the
full triad. **`delete_cart` deliberately has no `_failed`**: `DELETE` is idempotent by
contract, so "deleted nothing" is a success rather than a distinct outcome, and a DB fault
throws out of `TraceWorkflowAsync`, which already records it on the span and sets ERROR
status. Inventing a `reason` for a branch the code does not have is what the convention
forbids. **Do not query for `delete_cart_failed` — it does not exist.**

| Route | `app_event` | Shape |
|---|---|---|
| `GET /v1/cart` | `read_cart_succeeded` | read — one line, `item_count` |
| `PUT /v1/cart` | `update_cart_started` | write |
| `PUT /v1/cart` | `update_cart_succeeded` | write |
| `PUT /v1/cart` | `update_cart_failed` | write, + `reason` |
| `DELETE /v1/cart` | `delete_cart_started` | write |
| `DELETE /v1/cart` | `delete_cart_succeeded` | write |

`delete_cart_succeeded` matters as its own line, not just `_started`: it is what lets a query
against OpenObserve distinguish "the user asked to delete their cart" from "an order consumed
it" (the third, silent deletion trigger — see
[One invariant, three triggers](#one-invariant-three-triggers-a-cart-with-no-live-lines-does-not-exist)
above), since only the former emits `delete_cart_*` at all. Each write's workflow span carries
the same `app_event`/`reason` as its log line, per [[logging-context]]. This shape — and the
gap where `GET`/`DELETE` originally shipped with **none** of it — is documented in
[[2026-08-25-reads-are-not-exempt-from-observability]]; full rule in
`services/orders/CLAUDE.md` §4.

## Response caching

> [!info] Shipped 2026-08-25 — Response Caching Layer milestone
> Full cross-service design: [[2026-08-25-response-caching-layer-design]]. Header contract:
> [[x-cache-response-header]]. Orders is the one service that also runs the fourth,
> identity-mapping component of that design.

### The four cached routes

| Route | Key | TTL | `.WithCache(...)` call site |
|---|---|---|---|
| `GET /v1/products` | `orders:products:v1` | 10 min | `Endpoints/ProductEndpoints.cs` |
| `GET /v1/cart` | `orders:cart:v1:{sub}:{userId}` | 60 s | `Endpoints/CartEndpoints.cs` |
| `GET /v1/orders/my-orders` | `orders:my-orders:v1:{sub}:{userId}:t{0\|1}` | 2 min | `Endpoints/OrderEndpoints.cs` |
| `GET /v1/orders/{orderId}` | `orders:order:v1:{sub}:{userId}:{orderId}:t{0\|1}` | 2 min | `Endpoints/OrderEndpoints.cs` |

### `.WithCache(...)` — an `IEndpointFilter`, not middleware, and not generic

`CachedReadFilter` (`Orders.Api/Caching/CachedReadFilter.cs`) is an `IEndpointFilter` applied at
route-mapping time via a `.WithCache(keyBuilder, ttl)` extension method. A **filter**, deliberately,
not middleware: `HttpErrorMetricsMiddleware` elsewhere in this service documents choosing
middleware specifically *because* a filter misses short-circuited responses — the opposite
argument applies here. The cache must wrap only the handler and must never stamp `X-Cache` on the
`401` `CallerContextMiddleware` produces before routing ever reaches the endpoint; a filter runs
inside the endpoint, which is exactly the scope wanted.

**Why the filter is not generic (`CachedReadFilter<T>`).** `GET /v1/orders/my-orders` returns two
different result types from **one** route: `Ok<IReadOnlyList<OrderDto>>` when
`includeTracking=false`, `Ok<OrderWithTrackingDto[]>` when it is true
(`Orders.Api/Caching/CachedReadFilter.cs:32-43`). A generic filter matching `IValueHttpResult<T>`
would bind to only one of those two `T`s, so the other variant would never be cached — a silent,
permanent `MISS` that every test exercising only one variant would still pass. `IValueHttpResult<T>`
is not covariant in `T`, so `T = object` does not rescue it either. `CachedReadFilter` instead
matches the **non-generic** `IValueHttpResult` and stores the response as pre-serialized JSON — a
shape that works identically across every route regardless of its DTO, and has a second benefit: a
`HIT` replays the exact bytes a `MISS` produced, so the two responses cannot drift through a
serializer difference.

**Why the app's own `JsonSerializerOptions` must be used on write, and only matters on a HIT**
(`CachedReadFilter.cs:101-107,130-134`). Minimal APIs serialize `Results.Ok<T>` with the
framework's web defaults (camelCase); calling `JsonSerializer.Serialize(value)` with no options
uses PascalCase. Mixing the two means a stored `MISS` body is camelCase but a naively-serialized
cache write would produce PascalCase — every client reading `unitPrice` would see `undefined`/a
missing field **on a `HIT` only**, since a `MISS` always goes through the framework's real
serializer. `ResolveJsonOptions` reads the app's own `IOptions<JsonOptions>` (falling back to
`JsonSerializerOptions.Web` if that service is somehow unavailable) so a cached body and a fresh
one are byte-identical.

On a hit the handler never runs at all; `X-Cache: HIT` + `X-Cache-TTL` are stamped and the stored
bytes are replayed verbatim. On a miss the handler runs, and only a `200` response populates the
cache — a per-user key additionally joins the caller's Redis-SET index (`TrackKeyAsync`) so a later
write can invalidate it without `KEYS`/`SCAN`; the product catalogue key is excluded from indexing,
since it belongs to no user. `WithCache` adds **no OpenAPI metadata** — the route's documented
contract is unchanged by caching, and `X-Cache` is operational, not part of the schema.

### `orders:index:v1:{sub}` — the per-user key index

A Redis SET per caller (`CacheKeys.UserIndex`), populated by every cacheable per-user write and
consulted by invalidation instead of `KEYS`/`SCAN`. TTL 1 h — longer than any response entry it
tracks, so the index cannot expire out from under a key it is the only way to reach. This is what
lets `InvalidateOrderCreationAsync` clear the cart, both `my-orders` variants (`t0`/`t1`), and every
order-by-id variant in one sweep, without reconstructing key names the invalidator was never told.

### `CachedUserDirectory` — the identity-mapping cache, as an `IUserDirectory` decorator

`Orders.Infrastructure/Identity/CachedUserDirectory.cs` wraps the gRPC-backed `IUserDirectory` and
is the Orders half of
[[2026-08-25-response-caching-layer-design#Fourth component — the identity-mapping cache (Orders and Tracking only)]].
Key `identity:sub-to-user:v1:{cognitoSub}`, 1 h TTL. It sits **in front of** the response cache:
every per-user response key carries `userId`, so this resolution must run before a response key can
even be built — on hits too — which is exactly why `CallerContextMiddleware`'s once-per-request
resolution stops paying a gRPC round trip on the hot path once this cache is warm. Registered as a
plain decorator (`Program.cs`) so nothing that consumes `IUserDirectory` changes.

**Never caches a negative resolution.** A `null` means "not found right now" — caching that behind
a 1h TTL would freeze a just-created user as unknown to Orders for up to an hour after Users
already knows about them. Only a **positive** resolution is stored.

**Deliberately does NOT cache the full profile.** `ResolveCallerAsync` (email, name, delivery
address) passes straight through to the inner directory, uncached. The full profile is read only on
the order-creation write path, where the caching saving would be negligible and the PII sitting in
Redis for an hour would not be.

### `NoopCacheInvalidator` — bound when `CACHE_ENABLED=false`, because the write services take `ICacheInvalidator` unconditionally

`Program.cs` registers `ICacheGateway` only when `CACHE_ENABLED` is `true` (default). The **write**
services (`CreateOrderService`, `CartWriteService` callers, the account-deletion cascade handler)
take `ICacheInvalidator` as a plain constructor dependency, with no conditional — so the kill switch
must still leave *something* registered, or `CACHE_ENABLED=false` would take the service down at
the first cart write instead of merely disabling the cache. `NoopCacheInvalidator` is that
something: every method is a no-op `Task.CompletedTask`, deliberately **not** a `CacheInvalidator`
wired to a `NoopCacheGateway` — with nothing cached there is nothing to invalidate, so the honest
implementation does nothing rather than routing calls through a gateway that would discard them
anyway.

### Account-deletion cascade invalidation

`InvalidateDeletedUserAsync(cognitoSub, userId, ct)` — called from `Endpoints/InternalEndpoints.cs`
inside `DELETE /v1/orders/by-user` (see
[Account-deletion cascade (internal)](#account-deletion-cascade-internal) below) — sweeps **both**
identities, not just the canonical pair the cascade receives. Cache keys are built from whichever
identifier the *client* put in `x-user-id`, verbatim (`CallerContextMiddleware` stores the raw
header value, and Users' `GetUserById` accepts either a `usr_` id or a Cognito sub) — so a user who
authenticated with their `usr_` id owns `orders:index:v1:usr_…` and
`identity:sub-to-user:v1:usr_…`, which a sweep of the sub alone never reaches. This is not
theoretical: it produced a real data leak, where a deleted user's orders kept replaying from cache
for up to 2 minutes and their identity mapping kept resolving for up to an hour after the account
was gone — see [[2026-08-26-cache-keys-built-from-a-raw-identity-header]]. The sweep removes the
user index (covering the cart, both `my-orders` variants, and every order-by-id entry) under each
identity, plus the identity-mapping key by name (it is the one per-user entry never in the index,
since only `CachedReadFilter` calls `TrackKeyAsync`). The shared product catalogue is deliberately
**not** invalidated here — the cascade never touches `product.units_in_stock`, unlike the E2E
restock, which does.

## Account-deletion cascade (internal)

> [!info] Shipped 2026-08-26 — Account Deletion milestone
> Full design: [[2026-08-25-account-deletion-design]]. `DELETE /v1/orders/by-user` is one of two
> internal cascade legs `DELETE /v1/users/me` calls synchronously; see
> [[users-service-design#Account deletion]] for the caller side.

`InternalEndpoints.cs` maps `DELETE /v1/orders/by-user`, a service-to-service route that soft-
deletes every order, order line, and cart belonging to a user. It is **not published on the API
Gateway** — reachable only inside the compose/ECS network — and is **not** behind Cognito.

### Inbound authentication — Orders validates `GRPC_API_KEY` inbound for the first time

Every previous use of `GRPC_API_KEY` in this service was **outbound**: Orders presenting it as
`x-api-key` gRPC metadata when calling Users' `GetUserById` (see
[[grpc-api-key-authorization]]). This route is the first time Orders sits on the **other** side
of that same secret — validating it **inbound**, on a plain REST route rather than gRPC
metadata. The handler reads the `x-api-key` header and compares it to `GRPC_API_KEY` using a
constant-time comparison, rejecting a missing or mismatched key with `401` before the request
body is even parsed.

`[[grpc-api-key-authorization]]`'s own text previously framed Orders purely as a **presenter** of
this key; that framing is now incomplete and has been corrected there to record both directions.

### Exempted from the `x-user-id` guard, not exempted from authentication

`PublicRoutes.cs` lists `DELETE /v1/orders/by-user` alongside the health check and the E2E
cleanup route. **"Public" here means only "exempt from the `x-user-id` guard"** — it does **not**
mean unauthenticated or externally reachable. The route is absent from the gateway and its
handler requires the `GRPC_API_KEY` before touching anything; it carries no end-user identity by
design, because the subject travels in the request **body** (`{ cognitoSub, userId }`) — the
caller is Users acting on a user's behalf, not the user's own request, so there is no end-user
`x-user-id` to guard on in the first place.

### Sweep order — details before orders, and why

The cascade stamps `order_details` **before** `orders`, mirroring the existing E2E cleanup:

1. **Details first.** The detail predicate is a subquery over the parent `orders` table
   (`order_id IN (SELECT id FROM orders WHERE cognito_sub = @sub OR user_id = @uid)`). If orders
   were soft-deleted first, they would be **hidden from their own children's subquery** by the
   global EF Core query filter that excludes soft-deleted rows by default — orphaning every
   detail line as a live child of a parent that the sweep can no longer see. Reversing the order
   is not a style choice; it is the one ordering that avoids that trap.
2. **Details are selected via `order_id IN (...)`, not the ownership columns directly** —
   `order_details` carries `user_id`/`cognito_sub` denormalized, but has **no index** on either
   (only `order_id`, `product_id`, `deleted_at`), so filtering on them directly would table-scan.
3. **Orders**, matched on the same `cognito_sub OR user_id` predicate as the detail subquery,
   exactly — if the two predicates diverged, the cascade could soft-delete a parent order while
   leaving its lines live, the precise orphaning bug the ordering above exists to avoid.
4. **The cart**, through the dedicated 3-arg `CartWriteService.DeleteForUserAsync` overload — see
   [[soft-delete#The per-user cascade]] for why this is a separate overload from the narrow 2-arg
   form the live cart routes use, and never the same one.

### The `cognito_sub OR user_id` predicate

Every statement in the cascade — details, orders, and the cart lookup feeding
`DeleteForUserAsync` — matches **either** identity, not `cognito_sub` alone. `cognito_sub` is not
the durable identity: a user who deletes their account and registers again gets a **new** sub
from Cognito, while their internal `usr_` id never changes. Matching only the sub would leave a
row whose sub is stale or empty silently unreachable by the erasure request. This costs nothing
— `Order` and `OrderDetails` already index both columns (`idx_order_user_id`,
`idx_order_cognito_sub`). **Orders' ordinary reads still filter by `cognito_sub` alone** — the
widening described here is erasure-only; see [[soft-delete#The per-user cascade]] for the
service-agnostic statement of this rule, shared verbatim with Tracking.

### `DeleteForUserAsync` — two overloads, one deliberately kept narrow

`CartWriteService` now exposes **two** overloads, not one:

- **2-arg** `DeleteForUserAsync(db, cognitoSub, ct)` — pre-existing, **unchanged**. Scoped to the
  caller's current sub alone, matching at most one cart. Still the only form `DELETE /v1/cart`,
  an emptying `PUT /v1/cart`, and `POST /v1/orders`'s post-checkout cleanup use — each acts for a
  **live request** whose identity is the current sub. Widening it would let a checkout destroy a
  cart that merely shares a `usr_` id under an older sub, losing someone's basket mid-purchase.
- **3-arg** `DeleteForUserAsync(db, cognitoSub, userId, ct)` — **new**, matching `cognito_sub OR
  user_id`. The cascade's **only** caller. Static and non-saving like its sibling, so the handler
  enlists it inside `AmbientActor.RunAsync` and calls `SaveChangesAsync` itself under the audit
  actor below.

### Audit actor and observability

The cascade is a **hybrid** write, not a single mechanism: order and detail rows go through
`ExecuteUpdateAsync` (bypassing `SaveChanges`, and therefore the `AuditInterceptor`), while the
cart goes through ordinary `SaveChanges` under `AmbientActor`. `DeletedBy` on every row this
route touches is stamped with `AuditActor.DeleteByUser` = `"orders_api:delete_by_user"`
(`Orders.Application/Abstractions/AuditActor.cs`) — see [[soft-delete#Implementation (Orders, EF Core)]]
for the now-two deliberate `ExecuteUpdateAsync` exceptions to the interceptor.

The route emits the standard `internal_delete_by_user` triad, wrapped in `IWorkflowTracer`:

| `app_event` | When | `reason` values |
|---|---|---|
| `internal_delete_by_user_started` | Once the API key has passed | — |
| `internal_delete_by_user_succeeded` | With per-table counts (`deleted`, `deletedDetails`, `deletedCarts`) | — |
| `internal_delete_by_user_failed` | Bad/missing key, missing identity, or a DB fault | `invalid_api_key`, `cognito_sub_required`, `user_id_required`, `db_error` |

**`invalid_api_key` is logged and returned OUTSIDE the workflow span, deliberately.** An
unauthenticated request never started the flow, so there is no flow to trace — the span and the
`_started` line both begin only after the key check passes. Full event contract:
[[2026-08-25-account-deletion-design#Observability]].

## Data Model

All fields follow snake_case naming in the database and are mapped to PascalCase aliases in the ORM layer. See [[db-naming]]. All IDs use the prefixed nano-id format (`ord_`, `prd_`, `odd_`, `crt_`, `cti_`). See [[nano-id]]. All entities carry the standard audit fields and support soft delete only. See [[audit-fields]] and [[soft-delete]].

> [!note] Money is integer cents, not decimal
> The tables below still show the original `decimal(10,2)` columns as first designed. As shipped,
> every monetary column is an integer-cents `bigint` (`unit_price_cents`, `subtotal_cents`,
> `tax_cents`, `total_cents`) with a non-persisted computed dollar property — see
> [[money-as-integer-cents]] for the full decision and rationale. `Order` and `OrderDetails` also
> carry both `user_id` (internal) and `cognito_sub` (gateway-supplied) — the "double identity"
> decision recorded in [[2026-07-14-orders-service-milestone-design]]. **HTTP responses**
> (`OrderDto`, `OrderLineDto`, `ProductDto`, `CartDto`, `CartLineDto`) report every amount as a
> `Money` object (`cents`/`amount`/`formatted`/`currency`), not a bare cents integer — see
> [[money-representation]]. This is a DTO-layer change only; storage is unaffected.

> [!note] Every id-bearing column is `varchar(28)`, not `varchar(26)`
> The width is `PREFIX_LENGTH + LENGTH` = 4 + 24 = **28**, per [[nano-id]]. A column sized for the
> old, shorter nano-id would silently truncate every id MySQL stores in it — MySQL truncates a
> too-long `varchar` rather than erroring, so a mismatch here surfaces nowhere until something
> downstream fails to find a row. Verified live against `orders`' MySQL schema (2026-08-16): all 19
> id/audit varchar columns across `product`, `order`, and `order_details` are `varchar(28)`.

### Product

Catalog of available products. Used by `OrderDetails` to record what was ordered.

| Column | Type | Notes |
|---|---|---|
| `id` | `varchar(28)` | `prd_` prefix, nano-id |
| `name` | `varchar(255)` | |
| `description` | `text` | |
| `unit_price` | `decimal(10,2)` | |
| `units_in_stock` | `int unsigned` | |
| `image` | `json` | Nullable. Display artwork as `{uri, width, height, blurhash}`. `uri` is a bucket key **relative** to the assets base URL (e.g. `products/runner-low-canvas.jpg`), never absolute — see the note below. |
| `categories` | `json` | Non-nullable, defaults to `[]`. Array of UPPERCASE facet strings, e.g. `["FOOTWEAR"]`. |
| `created_by` | `varchar(28)` | audit |
| `created_at` | `datetime` | audit |
| `updated_by` | `varchar(28)` | audit |
| `updated_at` | `datetime` | audit |
| `deleted_by` | `varchar(28)` | audit |
| `deleted_at` | `datetime` | audit — null means active |

Computed property `isDeleted` returns `true` when `deleted_at` is not null.

> [!note] `image`/`categories` shipped in the Product Catalogue Enrichment milestone (PR #65)
> Both columns follow the same `ValueConverter`+`ValueComparer` treatment as `Order.Tags` above —
> the `ValueComparer` is **mandatory**, not optional: without it EF Core compares `List<string>`
> (and the `ProductImage` record) by reference and silently skips the `UPDATE`. `ProductImage` is
> a value object (a C# `record`, no `Id`, no table, no audit fields), embedded in the `image`
> column, not a separate entity.
>
> **`uri` is always relative, never absolute**, and this is enforced by a test
> (`MigrationSeedTests` asserts every seeded `uri` starts with `products/` and contains no
> `://`), not merely documented: Floci re-mints the assets bucket on every apply and `make clean`
> destroys it, so a persisted absolute URL is dead data after a rebuild, and it would bake an
> infrastructure detail into the domain. `ProductReadService` composes the absolute form on read
> from `ASSETS_BASE_URL` — written to `.env.local.orders` by `generate_env_files.py`, reusing the
> pre-existing `discover_assets_base_url()` and its derived fallback
> `http://localhost:4566/post-3mrai-local-post-assets`; see [[env-files]]. `GET /v1/products`'s
> response body grows to match (additive — no route/status/auth change): `ProductDto` gains
> `Categories` and `Image` (`{Uri, Width, Height, Blurhash}`, `Uri` served **absolute**).
>
> Blurhashes are computed by `infra/modules/assets-bucket/scripts/sync_assets.py` from the
> **optimised** served objects (not the masters under `assets/products/` — `RESIZE_TARGETS` caps
> the long edge at 1080) and embedded in the seed as C# constants; `ProductSeedManifestTests`
> guards against the two drifting apart. The catalogue itself is now the eight products from the
> web-app design (stock tiered 100/50/25), replacing the original `Widget`/`Gadget`/`Gizmo`
> placeholders — an existing local database keeps its old rows until a rebuild (`make clean` +
> `make bootstrap`), since the seed only plants rows into an empty table.
>
> Not built: category filtering on `GET /v1/products`, product search, admin CRUD, image upload,
> multiple images per product, a `FEATURED` facet — see the callout at the top of this note. Full
> design and reasoning: [[2026-08-10-product-catalogue-image-categories-design]].

### Order

One record per submitted order.

| Column | Type | Notes |
|---|---|---|
| `id` | `varchar(28)` | `ord_` prefix, nano-id |
| `user_id` | `varchar(28)` | FK → Users service (resolved via gRPC) |
| `subtotal` | `decimal(10,2)` | |
| `tax` | `decimal(10,2)` | |
| `total` | `decimal(10,2)` | |
| `shipping_address` | `json` | Snapshot of the delivery address at order-creation time, resolved via Users' `GetUserById` (see [[users-service-design]]) and forwarded to Tracking's `init-tracking`. See [Delivery address flow](#delivery-address-flow-users--orders--tracking). Deliberately a point-in-time copy, not a live reference — see the snapshot-semantics note above. |
| `created_by` | `varchar(28)` | audit |
| `created_at` | `datetime` | audit |
| `updated_by` | `varchar(28)` | audit |
| `updated_at` | `datetime` | audit |
| `deleted_by` | `varchar(28)` | audit |
| `deleted_at` | `datetime` | audit — null means active |

### OrderDetails

Line items for each order. One row per product per order.

| Column | Type | Notes |
|---|---|---|
| `id` | `varchar(28)` | `odd_` prefix, nano-id |
| `product_id` | `varchar(28)` | FK → `products.id` |
| `user_id` | `varchar(28)` | denormalized for query convenience |
| `quantity` | `int unsigned` | |
| `subtotal` | `decimal(10,2)` | |
| `tax` | `decimal(10,2)` | |
| `total` | `decimal(10,2)` | |
| `created_by` | `varchar(28)` | audit |
| `created_at` | `datetime` | audit |
| `updated_by` | `varchar(28)` | audit |
| `updated_at` | `datetime` | audit |
| `deleted_by` | `varchar(28)` | audit |
| `deleted_at` | `datetime` | audit — null means active |

### Cart

At most one live row per user, enforced by the unique index described under [Cart](#cart) above.

| Column | Type | Notes |
|---|---|---|
| `id` | `varchar(28)` | `crt_` prefix, nano-id |
| `user_id` | `varchar(28)` | internal id |
| `cognito_sub` | `varchar(255)` | gateway-supplied |
| `active_user_id` | `varchar(28)`, nullable | **Generated, stored.** `user_id` while `deleted_at IS NULL`, else `NULL`. Backs `uq_cart_active_user_id`. |
| `created_by` | `varchar(28)` | audit |
| `created_at` | `datetime` | audit |
| `updated_by` | `varchar(28)` | audit |
| `updated_at` | `datetime` | audit |
| `deleted_by` | `varchar(28)` | audit |
| `deleted_at` | `datetime` | audit — null means active |

### CartItem (table: `cart_item`)

No price column, deliberately — see [Cart](#cart) above.

| Column | Type | Notes |
|---|---|---|
| `id` | `varchar(28)` | `cti_` prefix, nano-id |
| `cart_id` | `varchar(28)` | FK → `cart.id`, `ON DELETE RESTRICT` (not the EF default `Cascade` — see the InnoDB gotcha callout under [Cart](#cart)) |
| `product_id` | `varchar(28)` | FK → `product.id` |
| `quantity` | `int unsigned` | |
| `active_cart_id` | `varchar(28)`, nullable | **Generated, stored.** `cart_id` while `deleted_at IS NULL`, else `NULL`. Backs `uq_cart_item_active_cart_product` with `product_id`. |
| `created_by` | `varchar(28)` | audit |
| `created_at` | `datetime` | audit |
| `updated_by` | `varchar(28)` | audit |
| `updated_at` | `datetime` | audit |
| `deleted_by` | `varchar(28)` | audit |
| `deleted_at` | `datetime` | audit — null means active |

## Events

`SqsEventPublisher` publishes `ORDER_CREATED` to the shared SQS queue on every successful
`POST /v1/orders`, inside the same write transaction as the order itself. `NoopEventPublisher`
still exists for tests and any environment that must not emit, but is not the production
binding.

| Event | Trigger | Payload |
|---|---|---|
| `ORDER_CREATED` | `POST /orders` succeeds | `{ order_id, user_id, total, created_at }`, plus the shared envelope's `author` object |

The event is dispatched to SQS. The Events Pipeline Lambda picks it up, saves it with status `STARTED`, dispatches to `OrderCreatedHandler`, and updates status to `COMPLETED` or `FAILED`.

Publish failures are logged and swallowed, never rethrown, because the publish call runs
**inside** the write transaction — re-raising would roll back a commercially valid, already
paid-for order over a notification failure. See [[events-pipeline-design]] for the consumer
side and the full envelope contract.

## Metrics

> [!info] Shipped 2026-08-12 — Custom Business Metrics milestone
> Full design and the Floci/OpenObserve gotchas that constrain this metric:
> [[2026-08-12-custom-business-metrics-cloudwatch-design]]; the CloudWatch-not-OTLP pipeline and
> the shared query gotchas are in [[logging-context#Metrics — the third pillar, and why it does
> NOT go over OTLP]].

| Metric | Type | Dimensions |
|---|---|---|
| `orders_total` | gauge | `Service=orders` |

`orders_total` is a gauge — the true count of live orders — published by
`OrdersMetricsPublisher`, a `BackgroundService` polling Orders' own database on the same interval
as every other service's gauge poller (15s locally, 60s in real AWS). This is the service's
**first** `BackgroundService`; there were none before this milestone.

**`orders_total` minus Tracking's `(DELIVERED + IN_PROGRESS)`
([[tracking-service-design#Metrics]]) is a health indicator for the Orders→Tracking
integration.** In the normal flow every order gets a tracking row at creation time
(`POST /v1/trackings/init-tracking`, called during `POST /v1/orders`), so the difference is 0. The
gap this metric would surface is not a bug — it is the **deliberately-accepted failure mode**
documented verbatim in `services/orders/src/Orders.Application/Tracking/TrackingInitResult.cs`:
four of the six `TrackingInitOutcome` values (`UnknownUser`, `Unauthorized`, `Failed`,
`Unreachable`) leave a committed order with no tracking, on purpose — failing the order after
stock was decremented would invite a double purchase. `TrackingInitResult.cs`'s own comment
promises this stays observable through a log; this metric is what makes it visible at a glance
and alarmable, rather than only discoverable by reading logs after the fact.

## Cross-cutting rules

This service follows all shared conventions defined once in the vault:

- [[soft-delete]] — no physical deletes; `deleted_at`/`deleted_by` only. DB user forbidden from running `DELETE`.
- [[nano-id]] — prefixed nano-ids for all entity IDs (`ord_`, `prd_`, `odd_`, `crt_`, `cti_`).
- [[money-representation]] — every HTTP amount is a `Money` object (`cents`/`amount`/`formatted`/`currency`), camelCase on the wire; storage stays `bigint` cents per [[money-as-integer-cents]], and the `ORDER_CREATED` SQS envelope is unaffected.
- [[audit-fields]] — `created_by`, `created_at`, `updated_by`, `updated_at`, `deleted_by`, `deleted_at` on every entity.
- [[db-naming]] — snake_case in DB, PascalCase aliases in EF Core models.
- [[cqrs]] — read queries routed to the read replica; write commands routed to the write replica.
- [[versioning]] — all HTTP endpoints versioned under `/v1/`.
- [[logging-context]] — every log line carries the shared cross-service context (`request_id`, `trace_id`, `cognito_sub`, `user_id`, `email_hash`, `order_id`, `duration_ms`); Orders attaches it via a Serilog enricher reading `ICurrentCaller` lazily (never cached — see `services/orders/CLAUDE.md` §4). `request_id` is seeded in `CallerContextMiddleware`, but the correlation scope is opened in the **outermost** middleware — `UseSerilogRequestLogging` writes its `request completed` line on the way back out, after the inner frame that would otherwise hold the `AsyncLocal` value is gone. Propagates to Tracking via the `x-request-id` HTTP header and as a root field on `ORDER_CREATED`. Full design: [[2026-08-15-request-id-correlation-design]].
- [[env-files]] — Orders reads its config from `.env.local.orders`, generated by `make env-file`; nothing is hand-maintained.
- [[testing]] — every endpoint needs all three test layers (unit/integration, internal E2E, gateway E2E with a real Cognito JWT); see [[domains/orders/testing/index]] for how Orders satisfies it, including its Layer 4 (load testing, a fourth surface answering "what shape under sustained traffic?" rather than correctness) with the cart's `GET`-is-the-hot-path load pattern.
- [[ADR-0019-distributed-tracing-opentelemetry]] — traces and logs both export via OTel to OpenObserve (single backend since Jaeger's 2026-08-21 removal, see the ADR's Amendment); OTel endpoint/protocol come from environment variables only, never set in code.
- [[2026-08-18-distributed-tracing-spans-design]] — `create_order` gets a manual workflow span
  via `IWorkflowTracer` (`Orders.Infrastructure/Observability/WorkflowTracer.cs`), a thin
  wrapper over `System.Diagnostics.ActivitySource` mirroring Users' `withWorkflowSpan`/
  Tracking's `workflow_span` shape: `OK` on success, `ERROR` + the same `reason` the log carries
  on failure, closed via `using`'s `Dispose()` (the .NET equivalent of the mandatory `finally`).
  `update_cart`/`delete_cart` (full write triads) and `read_cart` (the read shape) added since —
  see [Observability](#observability--six-flow-events-readwrite-shaped-differently) under
  [Cart](#cart) above. Orders also gained `OpenTelemetry.Instrumentation.AWS`, so the
  `SqsEventPublisher`'s `SendMessageAsync` produces a CLIENT span, and the publisher now injects
  `Activity.Current?.Id` (a W3C `traceparent` string) into the message's `MessageAttributes` for
  events-pipeline's consumer to link back to.
- [[2026-08-25-response-caching-layer-design]] — the four `.WithCache(...)` routes, the
  identity-mapping cache (`CachedUserDirectory`), and the `NoopCacheInvalidator` kill-switch
  binding. See [Response caching](#response-caching) above. Header contract:
  [[x-cache-response-header]].

Additional ADRs and service-local decisions:

- [[ADR-0003-grpc-inter-service]] — gRPC is the inter-service communication protocol.
- [[ADR-0006-read-write-replicas]] — Aurora MySQL read/write replica topology.
- [[ADR-0008-screaming-arch-di]] — Screaming architecture + dependency injection (Orders diverges — see [[clean-architecture-divergence]]).
- [[ADR-0010-cognito-auth]] — Authentication via AWS Cognito JWT.
- [[clean-architecture-divergence]] — Orders' 5-project Clean Architecture layering, service-local.
- [[money-as-integer-cents]] — money stored as integer cents, not `decimal`.
- [[grpc-api-key-authorization]] — the `x-api-key` scheme securing the Orders→Users gRPC call.
- [[for-update-pessimistic-locking]] — tagged LINQ + interceptor for the stock row lock.

## Deltas from the original design (superseded)

The following decisions, made during and after the Orders Service milestone, supersede what this
spec originally said:

- Money columns: `decimal(10,2)` → integer `_cents` `bigint` columns. See [[money-as-integer-cents]].
- `GET /v1/orders/{order_id}` ownership-failure response: `403 Forbidden` → `404 Not Found` (filter-in-query pattern, avoids leaking existence).
- `Order`/`OrderDetails` store both `user_id` (internal) and `cognito_sub` (gateway-supplied), not `user_id` alone.
- Architecture diverges from [[ADR-0008-screaming-arch-di]] for this service only. See [[clean-architecture-divergence]].
- Added `GET /v1/products` (not in the original endpoint table). See [[2026-07-16-orders-list-products-endpoint-design]].
- Added the gRPC `x-api-key` authorization scheme for the Users call. See [[grpc-api-key-authorization]].
- Stock locking moved from raw `FOR UPDATE` SQL to tagged LINQ + an EF Core interceptor. See [[for-update-pessimistic-locking]].

Full milestone design: [[2026-07-14-orders-service-milestone-design]].

## Related

- [[2026-08-25-account-deletion-design]] — full design for the internal
  `DELETE /v1/orders/by-user` cascade: the `cognito_sub OR user_id` predicate, the sweep order,
  and the four-layer empty-identity guards.
- [[2026-08-15-request-id-correlation-design]] — the cross-service `request_id` correlation
  field: seeded in `CallerContextMiddleware`, correlation scope opened in the outermost
  middleware, propagated to Tracking via HTTP header and to `ORDER_CREATED` as an envelope field.
- [[soft-delete]]
- [[nano-id]]
- [[audit-fields]]
- [[db-naming]]
- [[cqrs]]
- [[versioning]]
- [[logging-context]]
- [[env-files]]
- [[testing]]
- [[ADR-0003-grpc-inter-service]]
- [[ADR-0006-read-write-replicas]]
- [[ADR-0007-secrets-parameter-store]]
- [[ADR-0008-screaming-arch-di]]
- [[ADR-0010-cognito-auth]]
- [[ADR-0019-distributed-tracing-opentelemetry]]
- [[2026-08-18-distributed-tracing-spans-design]] — the `create_order` workflow span,
  `IWorkflowTracer`, and the AWS SDK instrumentation this note's Cross-cutting rules section
  documents.
- [[2026-08-18-distributed-tracing-spans]] — implementation plan.
- [[clean-architecture-divergence]]
- [[money-as-integer-cents]]
- [[grpc-api-key-authorization]]
- [[for-update-pessimistic-locking]]
- [[2026-07-14-orders-service-milestone-design]]
- [[2026-07-16-orders-list-products-endpoint-design]]
- [[tracking-service-design]] — the `x-test-mode` header on `POST /v1/orders` propagates as
  `test_mode` on the HTTP call to `init-tracking`, which also carries the `shipping_address`
  snapshot and forwards the caller's `x-user-id`. Tracking's REST reads
  (`GET /v1/trackings/{orderId}`, `GET /v1/trackings?order_ids=...`) reuse this spec's
  `404`-not-`403` ownership pattern and the same `x-user-id` gateway-injection mechanism — see
  [[tracking-service-design#Ownership & scoping]].
- [[users-service-design]] — `GetUserById` is where Orders resolves the delivery address it
  snapshots onto `Order.shipping_address`.
- [[events-pipeline-design]] — the consumer of `ORDER_CREATED`, the shared envelope contract,
  and the `author` object carried alongside the order payload.
- [[2026-08-10-product-catalogue-image-categories-design]] — full design and reasoning for the
  `image`/`categories` columns, the eight-product reseed, and the `ASSETS_BASE_URL` wiring
  documented under [Product](#product) above.
- [[2026-08-12-custom-business-metrics-cloudwatch-design]] — the design for `orders_total` and
  the `orders_total`-minus-Tracking health indicator for the Orders→Tracking integration.
- [[2026-08-25-cart-endpoints-design]] — full design for the `Cart`/`CartItem` aggregate, the
  three `/v1/cart` routes, and the `Money` wire type.
- [[money-representation]] — the cross-cutting `Money` wire contract every Orders HTTP DTO uses.
- [[2026-08-25-cart-innodb-generated-column-fk-restriction]] — the InnoDB errno 1215 gotcha the
  `cart_item.cart_id` foreign key ran into.
- [[2026-08-25-route-works-in-process-but-404s-at-gateway]] — the missing-gateway-route lesson
  the cart routes surfaced.
- [[2026-08-25-preview-must-mirror-charging-roundings-application-point]] — the tax-rounding
  drift between the cart's preview total and the order's real charge, found and fixed in
  final review before merge.
- [[2026-08-25-reads-are-not-exempt-from-observability]] — `GET`/`DELETE /v1/cart` shipped
  with no span or log line at all, found by the user after the branch was pushed; the
  read/write log-shape distinction now documented in `services/orders/CLAUDE.md` §4.
- [[domains/orders/testing/index]] — how Orders satisfies the three-layer testing convention
  plus its Layer 4 (load testing), including the cart's load-test scenario detail.
- [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]] — the retry mechanism
  documented in the "one-active-cart invariant" section above was correctly specified in the
  design spec from its first committed version; the implementation silently shipped without
  it, and no review layer caught the gap until a later whole-branch review.
- [[2026-08-25-response-caching-layer-design]] — the full cross-service response-caching
  design: the four cached routes and their TTLs, `CachedReadFilter`'s non-generic shape and
  camelCase serialization requirement, `CachedUserDirectory`'s identity-mapping cache, and the
  `NoopCacheInvalidator` kill-switch binding. See [Response caching](#response-caching) above.
- [[x-cache-response-header]] — the `X-Cache`/`X-Cache-TTL` response-header contract
  `CachedReadFilter` implements.
- [[2026-08-26-cache-keys-built-from-a-raw-identity-header]] — the data leak found in this
  service's account-deletion cascade: cache keys built from the raw `x-user-id` header,
  swept incompletely when the cascade invalidated only the canonical identity pair.
