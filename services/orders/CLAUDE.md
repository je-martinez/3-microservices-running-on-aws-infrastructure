# CLAUDE.md — Orders service

Nested project memory for the **Orders** microservice. Source of truth for this
service's stack and conventions. The global `orders-impl` agent reads this
first, every time. Cross-cutting rules are **referenced**, never duplicated.

## 1. Stack & versions
- Framework: .NET Core 10 — Minimal APIs.
- Language: C#.
- Database: Aurora MySQL (read + write replicas). Locally: MySQL via Floci.
- ORM: Entity Framework Core 9 (Pomelo MySQL provider — pinned 9.0.0; Pomelo has
  no EF 10 build). CQRS split: `OrdersReadDbContext` (read replica, `AsNoTracking`)
  and `OrdersWriteDbContext` (write replica, transactional). Locally both point at
  the same MySQL. See [[cqrs]] and [[ADR-0006-read-write-replicas]].
- Inter-service identity: a **gRPC client** to the Users service
  (`Grpc.Net.Client` + `Grpc.Tools`), generated from the shared repo-root
  `proto/users.proto` (`GrpcServices="Both"` — the client is used at runtime; the
  server stub is only for the in-process test). Every call attaches the shared
  `x-api-key` metadata (`GRPC_API_KEY`); `NOT_FOUND` maps to a null resolution.
- Money: stored as **integer cents** in `bigint` `_cents` columns (Stripe-style),
  mapped to `long` in C#. Dollar values are non-persisted computed properties
  (`cents / 100m`), ignored by EF. Never `decimal`/`float` for stored money; API
  responses expose cents.
- Config: read from environment via `builder.Configuration` (options + validation
  parity with the Users Zod convention).

## 2. Commands
- Restore: `dotnet restore`
- Build: `dotnet build` — **also (re)generates `services/orders/openapi.yaml`** at
  build time (see §2a). There is no separate `generate:openapi` step; the plain
  build is the regenerate command.
- Test: `dotnet test` (unit + Testcontainers-MySQL integration; needs Docker)
- Format: `dotnet format` (verify in CI: `dotnet format --verify-no-changes`)
- Add a migration: `dotnet ef migrations add <Name> --project src/Orders.Infrastructure --startup-project src/Orders.Infrastructure --context OrdersWriteDbContext`
  — the startup project is **Infrastructure, not Api**. `Microsoft.EntityFrameworkCore.Design`
  is referenced by Infrastructure with `PrivateAssets`, so it does not flow to Api, and pointing
  the startup project there fails with "doesn't reference Microsoft.EntityFrameworkCore.Design".
  Infrastructure carries `OrdersWriteDbContextFactory` for exactly this, so no live database is
  needed.
- Apply migrations: `dotnet ef database update --project src/Orders.Infrastructure --startup-project src/Orders.Api --context OrdersWriteDbContext`
- Run local (docker-watch): `docker compose up orders --watch` (from repo root)

## 2a. GOLDEN RULE — keep `openapi.yaml` in sync

`services/orders/openapi.yaml` is **generated from the Minimal-API endpoint
metadata at build time** and is the artifact imported into **Datadog**. It only
stays correct if it is regenerated after the routes change.

The pipeline: `Microsoft.AspNetCore.OpenApi` builds an OpenAPI **3.1** document
(configured in `Program.cs` via `AddOpenApi("v1", …)`, title `Orders Service API`);
`Microsoft.Extensions.ApiDescription.Server` (a build-only `PackageReference`,
`PrivateAssets=all`) emits it **at build time** into the service root as
`openapi.json`; then the `ConvertOpenApiToYaml` MSBuild target in
`Orders.Api.csproj` runs the file-based converter `tools/openapi-json-to-yaml.cs`
to re-serialize it as `openapi.yaml` (3.1) and deletes the intermediate JSON. The
`--file-name openapi` + document name `v1` combination is what produces a clean
`openapi.json` (no `_v1` suffix).

**Whenever you add/remove an HTTP route, or change any route's request/response
shape (`.Accepts<T>`, `.Produces<T>(status)`, path/query params, or the DTOs it
references), you MUST regenerate and commit `openapi.yaml` together with the code
change.** A route change without a matching `openapi.yaml` update is an incomplete
change.

**Regenerate command:** `dotnet build` (of `Orders.Api`, or the whole solution).
Generation is build-time — there is no separate generate script.

- Each endpoint carries `.WithName(...)` (→ `operationId`), `.WithTags("Orders")`,
  `.WithSummary(...)`, and `.Produces<T>(status)`/`.Produces(status)` for the
  **actual** status codes it returns — keep these accurate to the handler, do not
  document responses the code never returns.
- The E2E cleanup route (`DELETE /v1/orders/e2e-cleanup`) is only mapped at runtime
  under `E2E_TESTING_ENABLED`, but `Program.cs` also maps it during document
  generation (entry assembly `GetDocument.Insider`) so the committed spec is
  complete without exposing the route in a production runtime. Keep that guard if
  you add other flag-gated endpoints you still want documented.
- Response/request DTOs (`OrderDto`, `CreateOrderRequest`, …) surface as named
  `#/components/schemas/*` — the generator prunes unreferenced component schemas,
  so only DTOs a route actually uses appear.
- Verify after regenerating: all five routes are present with their real statuses,
  the document is OpenAPI 3.1, and `dotnet build && dotnet test` pass.

Locally Orders now runs against a **provisioned Floci MySQL cluster** (the second
`rds-aurora` instantiation in `infra/environments/local`), reached at Floci's RDS
proxy port — not the old `7002` placeholder (the port is discovered from
`terraform output`, never hardcoded). Migrations run via **`make migrate-orders`**
as the cluster superuser (`test/test`), mirroring Users' `make migrate` — NOT via
`SEED_ON_STARTUP` at boot. A least-privilege **`orders_app`** user
(SELECT/INSERT/UPDATE, **no DELETE** — [[soft-delete]]/[[ADR-0004-soft-delete-only]])
is created post-apply by `infra/environments/local/bootstrap.sh`. See
[[ADR-0017-floci-local]] and [[floci-rds-apigw-limits]].

## 2b. GOLDEN RULE — test every endpoint in all three layers

Convention: [../../docs/shared/conventions/testing.md](../../docs/shared/conventions/testing.md) → [[testing]].

**Every Orders HTTP endpoint MUST have all three test layers:**
1. **Unit/integration** — xUnit + Testcontainers-MySQL via the in-process
   `WebApplicationFactory` (`OrdersApiFactory`).
2. **Internal E2E** — the service URL directly, `x-user-id` faked.
3. **Gateway E2E** — through `API_GATEWAY_URL` with a real Cognito JWT (the URL the
   user hits: JWT authorizer → njs → nginx → service). Specs live in
   `e2e/tests/gateway/`; run with `pnpm --filter @3mrai/e2e test` (needs `make bootstrap`).

**An endpoint without gateway E2E is an incomplete change** — in-process and internal
tests fake the authorizer and never touch the gateway, so they cannot catch
gateway-only bugs (missing route, dropped path param, method mismatch). Adding a
route means adding its gateway spec, same as regenerating `openapi.yaml` (§2a).

## 3. Solution layout (Clean Architecture)
Five projects; dependencies point inward (Domain ← Application ← Infrastructure/Api,
Api → Infrastructure). Domain references nothing.
```
services/orders/
├── Orders.sln
├── src/
│   ├── Orders.Domain/          — entities (AuditableEntity, Product, Order,
│   │                             OrderDetail), OrderPricing. No dependencies.
│   ├── Orders.Application/      — ports + pure DTOs/records/exceptions:
│   │                             IUserDirectory, IEventPublisher, OrderDto,
│   │                             CreateOrderCommand, InsufficientStock/UnknownUser.
│   ├── Orders.Infrastructure/   — EF Core DbContexts + configs + migrations, the
│   │                             nano-id helper, the gRPC client
│   │                             (Grpc/UserDirectoryGrpcClient), NoopEventPublisher,
│   │                             and the read/write SERVICES (Orders/OrderReadService,
│   │                             Orders/CreateOrderService).
│   └── Orders.Api/              — composition root: Program.cs DI, Minimal-API
│                                 endpoints (Endpoints/), CallerIdentity.
└── tests/Orders.Tests/         — xUnit; Domain unit tests + Testcontainers-MySQL
                                  integration + WebApplicationFactory endpoint tests.
```

> **Dependency-direction rule (important).** Application must NOT reference
> Infrastructure/EF Core. Any class that touches a DbContext or the gRPC client
> lives in **Infrastructure**, not Application — this is why `OrderReadService`
> and `CreateOrderService` sit under `Orders.Infrastructure.Orders` even though
> the plan drafted them in Application. Application owns only ports (interfaces),
> commands, DTOs, and exceptions. The Api wires the concrete services.

## 4. Conventions (referenced, never duplicated)
- CQRS (read/write DbContexts): [../../docs/shared/patterns/cqrs.md](../../docs/shared/patterns/cqrs.md)
- Soft delete only: [../../docs/shared/conventions/soft-delete.md](../../docs/shared/conventions/soft-delete.md)
- Prefixed nano IDs (`prd_`, `ord_`, `odd_`): [../../docs/shared/conventions/nano-id.md](../../docs/shared/conventions/nano-id.md)
- Audit fields: [../../docs/shared/conventions/audit-fields.md](../../docs/shared/conventions/audit-fields.md)
- API versioning (`/v1`): [../../docs/shared/conventions/versioning.md](../../docs/shared/conventions/versioning.md)
- DB naming (snake_case columns ↔ PascalCase properties): [../../docs/shared/conventions/db-naming.md](../../docs/shared/conventions/db-naming.md)
- gRPC inter-service: [../../docs/shared/decisions/ADR-0003-grpc-inter-service.md](../../docs/shared/decisions/ADR-0003-grpc-inter-service.md)
- Read/write replicas: [../../docs/shared/decisions/ADR-0006-read-write-replicas.md](../../docs/shared/decisions/ADR-0006-read-write-replicas.md)
- Logging context & tracing: [../../docs/shared/conventions/logging-context.md](../../docs/shared/conventions/logging-context.md)
- Code comments: [../../docs/shared/conventions/code-comments.md](../../docs/shared/conventions/code-comments.md) → [[code-comments]]

### Logging & tracing in this service
- **Every endpoint gets a workflow span and at least one flow log — READS INCLUDED.**
  This was got wrong once and is worth stating plainly: a read is not exempt. The
  shape differs, though, and the difference is the point:
  - **Reads** (`list_my_orders`, `read_cart`) get a span plus ONE `_succeeded` line
    carrying a count, and no `_started` twin and no `_failed` branch. There is no
    intermediate step at which `_started` could be the last line seen, and the method
    names no failure of its own — a DB fault throws out of `TraceWorkflowAsync`, which
    already records it on the span. Inventing a `reason` for a branch the code does not
    have is exactly what the convention forbids.
  - **Writes** (`create_order`, `update_cart`, `delete_cart`) get the full
    `_started`/`_succeeded`/`_failed` triad plus `reason` on failures, because they
    have real intermediate steps at which `_started` can be the last thing seen.
  - The `_succeeded` line must be emitted INSIDE the activity so it carries that span's
    `span_id`; the outer `request completed` line is written under the AspNetCore span
    and cannot serve a span-scoped log lookup.
  - Never re-pass `cognito_sub` / `user_id` at a call site — `LogContextEnricher` already
    puts them on every line, and duplicating them is how a PII-adjacent field ends up
    somewhere nobody audits. Pass only the count or the flow-specific field.
  - **Instrument the entry point, not a shared helper.** `CartReadService.BuildAsync` is
    called by the WRITE path to render its response, so instrumenting there would emit a
    spurious nested read span inside every `update_cart`. The span belongs on
    `GetMyCartAsync`.
- The shared log context is attached by a Serilog `ILogEventEnricher`
  (`Orders.Api/Logging/LogContextEnricher.cs`) reading `ICurrentCaller` via
  `IHttpContextAccessor` — no call site passes identity into the logger.
- **Read the caller on EVERY event, never cache it.** `ResolveInternalUserIdAsync` resolves the
  internal `usr_` id lazily, so `user_id` is absent early in a request and present later; caching
  would freeze the empty early value onto the whole request. `ResolvedInternalUserId` is the
  non-triggering view the enricher uses — a getter that fired the gRPC call would turn every log
  line into a network request.
- `EmailHash.Compute` MUST stay byte-identical to Users' `hashEmail` (SHA-256 of the trimmed,
  lowercased email, hex, first 16 chars). Both sides pin `b4c9a289323b21a0` for
  `user@example.com` in a test so a drift fails in CI instead of silently returning no results.
- `UseSerilog` must use the **three-argument** overload; the two-arg one has no `services`
  parameter, so the enricher cannot resolve `IHttpContextAccessor`.
- OTel endpoint and protocol come from **environment variables only** — do not set
  `options.Endpoint` or `options.Protocol` in code. Hand-building the endpoint made this service
  POST to the collector's root (404) and export nothing, silently.

## 5. Agent rules
- Converse with the user in **Spanish**; write code and comments in **English**.
- `orders-impl` writes **only source code** — never runs git or touches Linear.
- Leave finished work in the working tree for the **main session** to commit
  (`github-ops` is an optional helper for complex git batches — see [[git-workflow]]).
- Stay within the single task handed to you (YAGNI).

## 6. Design reference
- Service spec (vault): [../../docs/domains/orders/specs/orders-service-design.md](../../docs/domains/orders/specs/orders-service-design.md)
- Endpoints (all `/v1`-prefixed):
  - `[GET] /v1/health`
  - `[POST] /v1/orders` → 201 (new `ord_` id) · 401 no `x-user-id` · 404
    `unknown_user` · 409 `insufficient_stock`. Resolves the caller's Cognito sub
    to the internal `usr_` id via the Users gRPC client, then in one transaction
    locks each product `FOR UPDATE`, decrements stock, prices lines in cents,
    persists Order + OrderDetails with BOTH `user_id` and `cognito_sub`, and emits
    `ORDER_CREATED` to SQS (see below). Full rollback on any failure.
  - `[GET] /v1/orders/my-orders`, `[GET] /v1/orders/{order_id}` — ownership by
    query filter (`cognito_sub` from `x-user-id`); another user's order → 404.
    Both take an optional `includeTracking` query param (default **false**); when
    true the order carries its tracking, fetched through Tracking's batch read —
    one call for N orders, never one per order. A typed `TrackingDto` guarded by
    `TrackingContractTests`, not an opaque passthrough. Tracking being down
    degrades to `tracking: null` with a 200; it never fails the read.
    **Reads DO make one gRPC call.** `CallerContextMiddleware` resolves the
    caller's `usr_` id once per request so every log line carries `user_id` —
    deliberate, and the cost was accepted explicitly. Read lines previously
    carried only a sub and could not be joined to Users or Tracking, which key by
    `user_id`. Do not "optimise" this away; see §4 and the middleware's comment.
  - `[DELETE] /v1/orders/e2e-cleanup` — soft-deletes every order tagged
    `"E2E Source"` **by tag, never by caller** (the E2E harness's global teardown
    runs with no identity at all, so a caller-scoped filter would delete nothing).
    Also **restores catalogue stock** to `ProductSeed.SeedStock` — orders
    decrement stock permanently and a soft-delete does not give it back, so
    without this the catalogue drained ~17 units per run and the suite failed
    around the sixth. Mapped only when `E2E_TESTING_ENABLED`.
  - `[GET] /v1/cart` → **always 200**. A user with no active cart gets an EMPTY
    cart (`id: null`, `items: []`), never a 404 — the frontend then has one shape
    to render and never branches. Prices, names, images and stock are resolved
    LIVE from the catalogue on every read, in ONE batched query for all the
    cart's product ids; `cart_item` deliberately stores no price, so the user can
    never see a frozen figure that disagrees with what checkout charges (an Order
    is the opposite, and freezes its prices on purpose).
  - `[PUT] /v1/cart` → 200 · 400 `invalid_request` · 401 · 404 `unknown_user`
    **(only on a request that carries lines)**. FULL REPLACEMENT of the line
    set: a product absent from the array is removed, and `quantity: 0` removes a
    line too (deliberately redundant, so the frontend may send its list
    pre-filtered or not). 400 on a NEGATIVE quantity, a duplicated `productId`,
    or a missing/null `items` — zero is a valid instruction, not an error, and an
    empty array is the documented way to empty the cart. A non-existent product
    is **not** a 404: the line comes back flagged `available: false` with an
    `unavailableReason`, because that is a fact about one line, not a failure of
    the operation.
  - **Identity is resolved ONLY when there are lines left to persist**
    (`wanted.Count > 0`, after dropping `quantity: 0` entries), because the
    internal `usr_` id is needed for exactly one thing: stamping it onto a cart
    being CREATED. An emptying `PUT` (`items: []`, or every line at
    `quantity: 0`) never calls Users and never 404s for an unresolvable caller —
    it reaches the same "no cart" state `DELETE /v1/cart` does, and both must
    behave alike for the same caller. Resolving identity unconditionally was the
    original shape and a post-merge review fix; do not reintroduce it.
  - `[DELETE] /v1/cart` → 204, idempotent (204 whether or not a cart existed — a
    404 for "already gone" would make a retry after a dropped response look like
    a failure).
  - **One invariant behind all three: a cart with no live lines does not exist.**
    An emptying PUT, `DELETE /v1/cart`, and a completed order all route through
    `CartWriteService.DeleteForUserAsync`, which is static and does NOT save, so
    order creation composes it into its own transaction. Do not re-implement it
    per call site.
  - **One active cart per user is enforced by a DB unique index**, not a C#
    check: a stored generated column (`active_user_id` = `user_id` while live,
    NULL once soft-deleted) plus a unique index — MySQL ignores NULLs there. A
    "does one already exist?" read would race under two concurrent requests. Note
    the FK to `cart` is `Restrict`, not `Cascade`: InnoDB rejects a CASCADE FK on
    a column a STORED generated column depends on (errno 1215) — see
    [[2026-08-25-cart-innodb-generated-column-fk-restriction]].
  - **The loser of that race is retried, not surfaced as a 500.** Two concurrent
    `PUT`s from a caller with no cart both read `null` and both insert; the
    unique index rejects one as a `DbUpdateException`. `CartWriteService`
    catches it, rolls back, re-reads the winning cart, and applies the caller's
    lines to it instead — one retry, then a normal 200. A second failure means
    something other than this race, so it is not retried again. Detection
    matches on the **index name**
    (`CartConfiguration.ActiveUserIdIndexName`, shared by the schema and
    `IsActiveCartUniqueViolation`), never the bare MySQL error number: matching
    on the number alone would also fire on `cart_item`'s own unique index (two
    lines for one product), where a retry is the wrong response. If the two
    spellings ever drift, the retry silently stops firing and the 500 returns —
    that is why it is a shared constant, not a literal repeated in each place.
  - Cart routes are **absent from `PublicRoutes.cs`** — all three require
    identity — and are wired at the gateway plus an nginx `location /v1/cart`
    block. Without that block `/v1/cart` falls through to `location /` and
    silently reaches **Users**, not Orders.
  - The `"E2E Source"` tag is applied at creation only when the request sent
    `x-e2e-source: true` **and** `E2E_TESTING_ENABLED` is on. Both halves are
    required: the conjunction is what stops an untrusted client tagging its own
    rows for someone else's teardown to delete. `order.tags` is a JSON column
    (MySQL has no array type), queried with `JSON_CONTAINS`; `OrderDetail`
    carries no tag of its own and is deleted through its parent.
- `ORDER_CREATED` **is published to SQS** by `SqsEventPublisher`
  (`Orders.Infrastructure/Messaging/`), on the shared events queue Users and
  Tracking also write to. `NoopEventPublisher` is kept for tests that must not
  emit. The envelope is snake_case with `type`/`source` also set as message
  attributes, and `event_id` is minted inside the publisher as the pipeline's
  idempotency key. It carries an `author` block —
  `{ actor: AuditActor.CreateOrder, user_id, cognito_sub }` — recording WHO
  originated the event, as distinct from the root `user_id` (who it is ABOUT).
  Serialized with `JsonIgnoreCondition.WhenWritingNull`, **not** `Never`: an
  identity the author does not have must be OMITTED, and `Never` would emit
  `"cognito_sub": null`, which the contract forbids. See [[audit-fields]]. Its payload carries the caller's **email**, which is why
  `CallerProfile` maps it off the `GetUserById` response order creation already
  makes. A publish failure is logged and swallowed, never rethrown: the publish
  runs inside the write transaction, so throwing would roll back a paid-for
  order because a queue was down.
