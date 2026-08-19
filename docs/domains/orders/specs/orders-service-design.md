---
title: Orders Service Design
type: spec
area: orders
status: accepted
created: 2026-06-26
updated: 2026-08-19
tags: [type/spec, area/orders, status/accepted]
related:
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

## Data Model

All fields follow snake_case naming in the database and are mapped to PascalCase aliases in the ORM layer. See [[db-naming]]. All IDs use the prefixed nano-id format (`ord_`, `prd_`, `odd_`). See [[nano-id]]. All entities carry the standard audit fields and support soft delete only. See [[audit-fields]] and [[soft-delete]].

> [!note] Money is integer cents, not decimal
> The tables below still show the original `decimal(10,2)` columns as first designed. As shipped,
> every monetary column is an integer-cents `bigint` (`unit_price_cents`, `subtotal_cents`,
> `tax_cents`, `total_cents`) with a non-persisted computed dollar property — see
> [[money-as-integer-cents]] for the full decision and rationale. `Order` and `OrderDetails` also
> carry both `user_id` (internal) and `cognito_sub` (gateway-supplied) — the "double identity"
> decision recorded in [[2026-07-14-orders-service-milestone-design]].

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
- [[nano-id]] — prefixed nano-ids for all entity IDs (`ord_`, `prd_`, `odd_`).
- [[audit-fields]] — `created_by`, `created_at`, `updated_by`, `updated_at`, `deleted_by`, `deleted_at` on every entity.
- [[db-naming]] — snake_case in DB, PascalCase aliases in EF Core models.
- [[cqrs]] — read queries routed to the read replica; write commands routed to the write replica.
- [[versioning]] — all HTTP endpoints versioned under `/v1/`.
- [[logging-context]] — every log line carries the shared cross-service context (`request_id`, `trace_id`, `cognito_sub`, `user_id`, `email_hash`, `order_id`, `duration_ms`); Orders attaches it via a Serilog enricher reading `ICurrentCaller` lazily (never cached — see `services/orders/CLAUDE.md` §4). `request_id` is seeded in `CallerContextMiddleware`, but the correlation scope is opened in the **outermost** middleware — `UseSerilogRequestLogging` writes its `request completed` line on the way back out, after the inner frame that would otherwise hold the `AsyncLocal` value is gone. Propagates to Tracking via the `x-request-id` HTTP header and as a root field on `ORDER_CREATED`. Full design: [[2026-08-15-request-id-correlation-design]].
- [[env-files]] — Orders reads its config from `.env.local.orders`, generated by `make env-file`; nothing is hand-maintained.
- [[testing]] — every endpoint needs all three test layers (unit/integration, internal E2E, gateway E2E with a real Cognito JWT); see [[domains/orders/testing/index]] for how Orders satisfies it.
- [[ADR-0019-distributed-tracing-opentelemetry]] — traces export via OTel to Jaeger, logs to OpenObserve; OTel endpoint/protocol come from environment variables only, never set in code.
- [[2026-08-18-distributed-tracing-spans-design]] — `create_order` (Orders' single flow with a
  full `app_event` triad) gets a manual workflow span via `IWorkflowTracer`
  (`Orders.Infrastructure/Observability/WorkflowTracer.cs`), a thin wrapper over
  `System.Diagnostics.ActivitySource` mirroring Users' `withWorkflowSpan`/Tracking's
  `workflow_span` shape: `OK` on success, `ERROR` + the same `reason` the log carries on failure,
  closed via `using`'s `Dispose()` (the .NET equivalent of the mandatory `finally`). Orders also
  gained `OpenTelemetry.Instrumentation.AWS`, so the `SqsEventPublisher`'s `SendMessageAsync`
  produces a CLIENT span, and the publisher now injects `Activity.Current?.Id` (a W3C
  `traceparent` string) into the message's `MessageAttributes` for events-pipeline's consumer to
  link back to.

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
