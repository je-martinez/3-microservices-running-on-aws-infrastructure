---
title: Tracking Service Design
type: spec
area: tracking
status: accepted
created: 2026-06-26
updated: 2026-08-27
tags: [type/spec, area/tracking, status/accepted]
related:
  - "[[2026-08-25-response-caching-layer-design]]"
  - "[[x-cache-response-header]]"
  - "[[2026-08-25-account-deletion-design]]"
  - "[[2026-08-15-request-id-correlation-design]]"
  - "[[soft-delete]]"
  - "[[nano-id]]"
  - "[[audit-fields]]"
  - "[[db-naming]]"
  - "[[versioning]]"
  - "[[ADR-0003-grpc-inter-service]]"
  - "[[ADR-0006-read-write-replicas]]"
  - "[[ADR-0007-secrets-parameter-store]]"
  - "[[orders-service-design]]"
  - "[[users-service-design]]"
  - "[[logging-context]]"
  - "[[testing]]"
  - "[[local-gateway-per-route-integrations]]"
  - "[[nginx-njs-x-user-id-injection]]"
  - "[[grpc-api-key-authorization]]"
  - "[[user-id-vs-cognito-sub-ownership-key]]"
  - "[[two-api-keys-two-trust-domains]]"
  - "[[testmode-in-process-no-durable-scheduler]]"
  - "[[events-pipeline-design]]"
  - "[[env-files]]"
  - "[[2026-08-03-events-pipeline-milestone-design]]"
  - "[[2026-08-05-realtime-tracking-events-websocket-design]]"
  - "[[2026-08-05-realtime-tracking-events-websocket]]"
  - "[[2026-08-12-custom-business-metrics-cloudwatch-design]]"
  - "[[2026-08-18-distributed-tracing-spans-design]]"
  - "[[2026-08-18-distributed-tracing-spans]]"
  - "[[ADR-0019-distributed-tracing-opentelemetry]]"
  - "[[2026-08-27-go-vs-python-performance]]"
  - "[[2026-07-31-contextvars-lost-across-task-boundaries]]"
  - "[[2026-08-27-tracking-go-migration-design]]"
  - "[[ADR-0021-tracking-go-gin-sqlc-stack]]"
  - "[[2026-08-27-a-component-can-be-fully-unit-tested-and-still-never-run-in-production]]"
  - "[[2026-08-27-a-producer-side-test-proves-nothing-about-what-the-consumer-accepts]]"
  - "[[2026-08-27-a-librarys-defaults-encode-assumptions-about-a-generic-service]]"
---

# Tracking Service Design

> [!info] Go cutover complete (2026-08-27) — this note now describes the Go/Gin implementation
> Tracking was ported from Python/FastAPI to Go/Gin per [[2026-08-27-tracking-go-migration-design]]
> (stack decisions: [[ADR-0021-tracking-go-gin-sqlc-stack]]). The migration's four-part closing
> gate is **three-of-four met** (all three test layers PASS, `openapi.yaml` diff PASS, observability
> parity PASS after a fix it found; measured performance is **PARTIALLY met** — resource/startup
> metrics measured and Go wins all four, load-test latency/throughput not measurable on this stack,
> see [[2026-08-27-go-vs-python-performance]]) — the cutover was executed on that basis, by user
> decision. **`services/tracking-go/` is now THE Tracking service.** `services/tracking/` (Python)
> is being removed; where this note still describes Python-only artifacts (Alembic revisions,
> historical FastAPI behaviour) they are marked explicitly as historical. Everything else below —
> the domain rules, the two-identity ownership rule, the state machine, the auth schemes, the
> events contract, TestMode's accepted limitation — is unchanged behaviour, now running on the Go
> service. See `services/tracking-go/CLAUDE.md` for implementation-level detail (architecture,
> commands, the wiring-hazard and wire-contract lessons) this note does not duplicate.
>
> Verified from a destroyed environment, not incrementally: `make clean` (with `./data`
> deleted) → `make bootstrap` completed in **one pass** → **70/70 E2E tests pass** against the
> Python service before the cutover; the Go service separately passed 22/22 internal E2E and
> 17/17 gateway E2E with the **same, unedited** gateway specs (`git diff -- e2e/tests/` empty) —
> see [[2026-08-27-tracking-go-migration-design#Closing gate — what must be true before the Python folder is deleted]].
> See [[tracking/testing/index|Tracking Testing]] for current unit/integration coverage — run
> against a live MySQL rather than mocks, same as the Python service was.
>
> `infra/modules/messaging/` and `infra/modules/docdb/` (renamed from `database/` on 2026-08-04 —
> the old name suggested a generic database module when it only ever created DocumentDB) are no
> longer empty placeholders — the events-pipeline milestone (2026-08-04) built both, and Tracking
> itself uses Aurora MySQL, not DocumentDB, so neither ever blocked this service directly.
> Tracking is now a producer onto the shared queue those modules provision — see
> [Events](#events) and [[events-pipeline-design]].

## Summary

The Tracking service is responsible for recording and updating the delivery status of orders.
**Tracking is REST-only.** Creation happens via `POST /v1/trackings/init-tracking`, authenticated
by a Cognito JWT through the gateway the same as any other user-facing endpoint; the caller's
identity comes from the gateway-injected `x-user-id` header, and Tracking resolves the caller's
internal `usr_` id itself via an **outbound** gRPC call to Users. Reads are also REST, user-scoped —
a caller only ever sees their own trackings (see [Ownership & scoping](#ownership--scoping)). The
REST surface otherwise stays narrow: a status-update endpoint that simulates a third-party carrier
notifying the system of a delivery status change, plus the standard health check. As of the
events-pipeline milestone, Tracking is **also a producer**: every successful status transition
emits `TRACKING_STATUS_CHANGED` — see [Events](#events).

The service exposes **seven** routes (not five — see [API / Endpoints](#api--endpoints) and
[[2026-08-27-tracking-go-migration-design#Surface inventory — SEVEN routes, four auth schemes]]
for the finding that the service's own project memory previously under-documented this by two)
across **four** inbound auth schemes plus one outbound.

> [!note] This design was not the original one
> Creation and both reads originally shipped over gRPC (JE-90, JE-91). See
> [Deltas from the original design (superseded)](#deltas-from-the-original-design-superseded) at
> the bottom of this note for what changed and why.

## Stack & Data Store

| Layer       | Technology                                             |
|-------------|---------------------------------------------------------|
| Runtime     | Go 1.26.7 (via goenv) — Gin                            |
| Data access | sqlc + `database/sql`, `go-sql-driver/mysql` — no ORM  |
| Migrations  | golang-migrate (baseline translated from the Python service's Alembic revisions) |
| Database    | Aurora MySQL (write replica + read replica)            |
| Container   | AWS Fargate (ECS)                                      |
| Auth        | Amazon Cognito (request validation)                    |

Read replicas are used for all reads — `GET /v1/trackings/{orderId}` and
`GET /v1/trackings?order_ids=...`; the write replica receives all mutations
(`POST /v1/trackings/init-tracking` and the REST status-update endpoint). See
[[ADR-0006-read-write-replicas]].

**Architecture: hexagonal / ports and adapters**, chosen over a plain domain-package layout so
the pure domain (`internal/domain`) cannot import Gin, sqlc, or Redis — the compiler, not a
convention someone has to remember, keeps infrastructure out of business rules. This is enforced
by a test, not review alone: `internal/domain/purity_test.go` walks the full transitive import
closure. Ports are declared by their **consumers** (each use case in `internal/app` declares its
own narrow interface, usually one or two methods) — there is no central `ports.go` and no shared
repository interface. Dependency injection is **manual constructor injection** in
`cmd/server/main.go`, a deliberate divergence from this repo's Awilix/DI-container convention
([[ADR-0008-screaming-arch-di]]) for this one service. Full layout and rationale:
[[2026-08-27-tracking-go-migration-design#Folder structure]] and
`services/tracking-go/CLAUDE.md` §3.

## API / Endpoints

Tracking is **REST-only**. Creation happens through `POST /v1/trackings/init-tracking`, behind the
same Cognito JWT gateway authorizer as the reads — see
[gRPC — outbound client to Users](#grpc--outbound-client-to-users) for the one remaining gRPC call
this triggers (outbound, to Users, not a server). All endpoints are versioned under `/v1`. See
[[versioning]].

All REST routes sit behind the **existing** API Gateway (`infra/modules/api-gateway/`) — the same
one fronting Users and Orders. There is no new/dedicated gateway for Tracking; adding these routes
means adding entries to that module's `local.routes` map, per
[Gateway routing](#gateway-routing-existing-module-not-a-new-one) below.

| Method | Gateway path                       | Auth | Description                          |
|--------|-------------------------------------|------|--------------------------------------|
| GET    | `/v1/tracking/health`               | None | Liveness/readiness probe, **as published at the gateway** — see [Gateway-prefixed health path](#gateway-prefixed-health-path-not-bare-v1health) below for why this is prefixed and not the bare `/v1/health` the service itself serves. Returns `200 { "status": "ok" }` when healthy. Used by ALB/Fargate as health check target. |
| POST   | `/v1/trackings/init-tracking`       | Cognito JWT (gateway authorizer) | Creates a tracking record. Body carries `order_id` and `shipping_address` only — the caller's identity comes from the gateway-injected `x-user-id` header, **not** the body. Rejects with `409 Conflict` when the order already has a tracking or any `Tracking_History`. Also accepts an optional `test_mode`, driving [TestMode automatic progression](#testmode-automatic-progression). |
| GET    | `/v1/trackings/{orderId}`           | Cognito JWT (gateway authorizer) | Returns one tracking + its `Tracking_History`, scoped to the caller. Filters by `order_id` **and** the caller's `cognito_sub` (from the gateway-injected `x-user-id` header — see [Ownership & scoping](#ownership--scoping)); a tracking that exists but belongs to another user is indistinguishable from one that does not exist — returns `404`, not `403`. Path param is `{orderId}` (camelCase) at the gateway — see [Gateway path params are camelCase](#gateway-path-params-are-camelcase-not-snake_case) below. |
| GET    | `/v1/trackings?order_ids=<csv>`     | Cognito JWT (gateway authorizer) | Returns many trackings (+ each one's `Tracking_History`), scoped to the caller. `order_ids` is a comma-separated list of order ids, e.g. `?order_ids=ord_a,ord_b,ord_c` — see [Batch read query shape](#batch-read-query-shape) for why. Filters by `order_id` **and** the caller's `cognito_sub`; ids that exist but belong to another user (or don't exist at all) are silently **omitted** from the results, never reported as an error — see [Ownership & scoping](#ownership--scoping). |
| PUT    | `/v1/trackings/{orderId}/status`    | Custom API key (service-validated, **not** Cognito) | Simulates a third-party carrier service notifying Tracking of a delivery status change. `status` must be one of the five enum values defined in [Tracking statuses](#tracking-statuses), and is subject to the guards in [State machine & update guards](#state-machine--update-guards). See [Auth schemes](#auth-schemes) — this endpoint has **no `x-user-id`** and is identified by `order_id` alone. Path param is `{orderId}` (camelCase) — see [Gateway path params are camelCase](#gateway-path-params-are-camelcase-not-snake_case). |
| DELETE | `/v1/trackings/e2e-cleanup`         | None — the route only **exists** under `E2E_TESTING_ENABLED` | The E2E harness's global-teardown route (JE-111). See [E2E cleanup](#e2e-cleanup-delete-v1trackingse2e-cleanup) below. |
| DELETE | `/v1/trackings/by-user`             | Custom internal API key (`GRPC_API_KEY`, service-validated, **not** Cognito) | **Internal.** Not on the API Gateway; the only caller is Users' `DELETE /v1/users/me`. Soft-deletes every live tracking (and its history) belonging to a user, matching `cognito_sub OR user_id`. See [Account-deletion cascade (internal)](#account-deletion-cascade-internal) below. |

> [!warning] Several auth schemes, in both directions — now FOUR inbound, corrected 2026-08-26
> Unlike Users/Orders, where "all endpoints require a Cognito JWT except health" was previously
> true, Tracking has **four inbound** schemes (none for health, Cognito JWT for the reads and
> init-tracking, a custom external key for the carrier PUT, and — as of the account-deletion
> milestone — the internal `GRPC_API_KEY` for `DELETE /v1/trackings/by-user`) **plus one
> outbound** scheme (the same internal `x-api-key` when Tracking itself calls Users). This note
> previously stated the internal key was something Tracking only **sends**, never validates
> inbound; that is **no longer true** — see [Auth schemes](#auth-schemes) below for the corrected,
> full breakdown, with the inbound/outbound direction made explicit for each of the five surfaces.
> Do not assume the PUT endpoint has a Cognito JWT or an `x-user-id` header; it has neither, and
> do not assume the internal-key route has either — it is identified purely by the identities in
> its request body.

> [!note] Gateway path vs internal service path
> The table above documents the **gateway** surface — what a client actually calls through
> `infra/modules/api-gateway/`. The Tracking service's own internal route handlers may spell paths
> differently (e.g. the health check is served unprefixed, see below, and a handler may bind its
> path param under a different name than the gateway's `{orderId}`, since the service reads it
> positionally). Where the two surfaces diverge, this spec calls it out explicitly rather than
> assuming they match.

#### Gateway-prefixed health path, not bare `/v1/health`

The gateway publishes `GET /v1/tracking/health`, **not** a bare `GET /v1/health` — following the
same per-service-prefixed convention already used for `GET /v1/users/health` and
`GET /v1/orders/health` (`infra/modules/api-gateway/main.tf` `local.routes`). The Tracking service
itself still serves the check **unprefixed**, at `/v1/health` internally; nginx rewrites the
prefixed gateway path down to the bare internal one (`infra/modules/compute/nginx/nginx.conf`, a
comment there marks this **HEALTH-ONLY** — the rewrite must not be extended to functional routes).

This prefix is not cosmetic — it is the only thing standing between a green health check and a
silently wrong one. nginx's default `location /` proxies anything unmatched to `users:3000`. A bare
`GET /v1/health` gateway route, with no distinguishing prefix, would fall through to that catch-all
and resolve to **Users**, returning Users' `200`. A Tracking health probe configured that way would
report healthy while never once reaching the Tracking service — worse than a `404`, because nothing
would ever flag it. Any future service added to this gateway must prefix its health route the same
way, for the same reason.

#### Gateway path params are camelCase, not snake_case

Gateway path params — `{orderId}` in the table above — are spelled **camelCase**, not the
snake_case (`{order_id}`) this spec used elsewhere and that earlier drafts of this table showed.
Floci's local API Gateway builds a Java regex named-capturing group from the param name
(`(?<orderId>[^/]+)`), and Java only allows `[A-Za-z0-9]` in capturing-group names — `{order_id}`
produces `(?<order_id>...)`, which throws `PatternSyntaxException` and returns a Floci `500`. This
is verified live in this repo for Orders' `get_order` route
(`infra/modules/api-gateway/main.tf`), and Tracking's `get_tracking` /
`update_tracking_status` routes follow the same constraint.

This is a **gateway-spelling** constraint only — the service reads the param positionally, so its
internal handler signature is free to use a different name (e.g. `order_id`). Document the gateway
spelling accurately here, since that is what a client actually calls; do not assume it matches
whatever name the service-side handler happens to use.

#### E2E cleanup, `DELETE /v1/trackings/e2e-cleanup`

The E2E harness's global-teardown route (JE-111), the Tracking peer of Orders' and Users' own
`e2e-cleanup` endpoints — see [[soft-delete]] for how each of the three implements the same
soft-delete-by-tag shape (Users: Prisma extension; Orders: `ExecuteUpdateAsync`; Tracking: the two
bulk `UPDATE`s below).

> [!important] No auth at all — the route itself is the guard
> This endpoint takes **no caller identity** — no Cognito JWT, no `x-user-id` dependency. The
> harness's teardown runs once, globally, at the end of a suite; there is no user session to run it
> as, so a route requiring a caller would `401` its only real caller (an earlier version did
> exactly that). What protects it instead is that the route **does not exist** unless
> `E2E_TESTING_ENABLED` is on. In the Go service the route is conditionally registered in
> `internal/adapter/http.NewAppRouter`; the Python service (retired) mounted the e2e router
> the same way from `src/main.py`.

- **What it deletes:** every live `Tracking` row tagged `"E2E Source"`, **and its `Tracking_History`
  in cascade** — children first, then the parent, following the FK direction (mirrors
  the tag-scoped soft-delete query (Go: `internal/adapter/mysql`; the retired Python service
  called it `soft_delete_by_tag` in `src/features/tracking/domain/repository.py`). Never a
  physical `DELETE` —
  the audit columns (`deleted_at`, `deleted_by`) are stamped, same as every other soft-delete in this
  service; `deleted_by` is set to `AuditActor.E2E_CLEANUP` so a row removed by the harness stays
  distinguishable from one removed by a real flow.
- **The tag is applied at creation, not here.** A row is tagged `"E2E Source"` only when the
  `init-tracking` request sent `x-e2e-source: true` **and** `E2E_TESTING_ENABLED` was on at that
  moment — **both conditions are mandatory** (Go: `internal/adapter/http/flags.go`; the retired
  Python service enforced it in `src/shared/http/e2e_source.py`). The conjunction is
  what stops an untrusted client tagging its own rows for someone else's teardown to delete; the
  header alone must never be sufficient.
- **Response:** `200 {"deleted": N}` — the count of `Tracking` rows stamped (not history rows).
  `200` even when `N` is `0`: a teardown that matches nothing has still reached the state it asked
  for, so a re-run is not a failure.
- **Flag off → `405`, not `404`.** With `E2E_TESTING_ENABLED` off the route is never registered, and
  `/v1/trackings/e2e-cleanup` still matches `GET /v1/trackings/{order_id}`'s path — only the method
  is unsupported, so the service answers `405 Method Not Allowed`, matching the retired Python
  service's Starlette behaviour. In Go this is **not** the framework default — Gin answers `404`
  for a path that exists under another method unless told otherwise, so
  `router.HandleMethodNotAllowed = true` is set explicitly in
  `internal/adapter/http.NewAppRouter` for exactly this reason (see
  `services/tracking-go/CLAUDE.md` §4). A harness (or a future test) that treats "flag off" as a
  `404` will misdiagnose this endpoint; treat `405` as "flag off; nothing to clean up here."
- **Caller:** the E2E harness's global teardown (`e2e/support/global-teardown.ts`), which calls the
  equivalent route on all three services.

### Auth schemes

> [!warning] Corrected 2026-08-26 — the internal key is validated inbound again
> This section previously stated the gRPC `x-api-key`/`GRPC_API_KEY` scheme was, as of the
> gRPC-removal rewrite, something Tracking only **sends**, never validates inbound — with the
> inbound `x-api-key` interceptor removed entirely (see
> [Deltas from the original design (superseded)](#deltas-from-the-original-design-superseded)).
> The account-deletion milestone (2026-08-26) made that framing **false again**: Tracking now
> validates `GRPC_API_KEY` **inbound**, on `DELETE /v1/trackings/by-user`, a plain REST route.
> [[two-api-keys-two-trust-domains]] carried the same outdated claim and has been corrected there
> too. The tables below reflect the current, actual direction of every surface.

Tracking is REST-only, but its surfaces still span several trust domains — worth documenting
explicitly, and worth being explicit about **direction**, because Tracking is now both a callee
in **two** different ways (its Cognito-authenticated REST surface, and — since account
deletion — a second inbound surface authenticated by the shared internal key) and a caller (its
one remaining gRPC dependency, outbound) using a key-based scheme in more than one direction.

**Inbound** — requests arriving at Tracking:

| Surface | Auth | Caller |
|---|---|---|
| `GET /v1/tracking/health` (gateway) / `/v1/health` (internal) | None | ALB / Fargate health check |
| `POST /v1/trackings/init-tracking` | Cognito JWT via the gateway's JWT authorizer, identity from `x-user-id` | End user |
| `GET /v1/trackings/{orderId}` and the batch read | Cognito JWT via the gateway's JWT authorizer, scoped by `cognito_sub` (from `x-user-id`) | End user |
| `PUT /v1/trackings/{orderId}/status` | Custom API key (`TRACKING_CARRIER_API_KEY`), validated by the service itself | Third-party carrier / webhook |
| `DELETE /v1/trackings/by-user` | Internal API key (`GRPC_API_KEY`), validated by the service itself. **Not** the same trust domain as the row above — see the callout below. Not on the API Gateway. | Users' `DELETE /v1/users/me`, via `CascadeClient` |

**Outbound** — the one call Tracking itself makes:

| Surface | Auth | Callee |
|---|---|---|
| gRPC `users.v1.Users/GetUserById` | `x-api-key` metadata entry (see [[ADR-0003-grpc-inter-service]]) | Users |

> [!important] Three key-based schemes now, across three trust domains — not two
> `TRACKING_CARRIER_API_KEY` (the PUT endpoint) and `GRPC_API_KEY` (both the outbound gRPC call
> *and*, now, the inbound `by-user` cascade route) are **three distinct surfaces sharing two
> secrets**, and the two secrets must never collapse into one:
>
> - `GRPC_API_KEY` is an **internal** service-to-service secret — the same pattern
>   [[users-service-design]] established for inter-service calls, the same one Orders uses for
>   its own `GetUserById` call (see [[grpc-api-key-authorization]]), and now the same one Orders
>   *also* validates inbound on its own `DELETE /v1/orders/by-user` (see
>   [[orders-service-design#Account-deletion cascade (internal)]]). Every holder of `GRPC_API_KEY`
>   is one of **our own services** — Tracking both sends it (to Users) and, as of account
>   deletion, receives and validates it (from Users) on two different routes with two different
>   transports (gRPC metadata outbound, an `x-api-key` HTTP header inbound). Sending and
>   validating the same secret on different surfaces is not a contradiction — it is what an
>   internal, symmetric, multi-service key looks like once more than two services hold it.
> - `TRACKING_CARRIER_API_KEY`'s holder is **not** one of our services — it is issued to an
>   **external** party (the carrier/webhook). These must **not** be the same value or the same
>   env var/secret: reusing the internal service credential as the externally-distributed carrier
>   key would hand an outside vendor the ability to authenticate as an internal service, including
>   against the account-deletion cascade route. Provision them as two separate secrets.
>
> Both should be treated as rotatable secrets in Parameter Store, per
> [[ADR-0007-secrets-parameter-store]], not hardcoded values. Log failed auth attempts against
> both the PUT endpoint and the cascade route (without ever logging the key itself, per
> [[logging-context]]) — a mass soft-delete surface is the widest blast radius in this service,
> and failed-attempt visibility is the cheapest mitigation available.
>
> See [[two-api-keys-two-trust-domains]] for the formal decision record (also corrected
> 2026-08-26).

### Gateway routing (existing module, not a new one)

Tracking's REST routes are added to the API Gateway the repo already has
(`infra/modules/api-gateway/main.tf`), the same one Users and Orders use — not a new gateway, not
direct service exposure. Concretely:

- Each route is a new entry in that module's `local.routes` map, carrying a route `key` (e.g.
  `"GET /v1/trackings/{orderId}"`) and an `auth` boolean, following the existing pattern for
  Users' and Orders' routes.
- `authorization_type` is `"JWT"` when `auth = true` and `"NONE"` when `auth = false`, with
  `authorizer_id` set only in the `true` case (`main.tf` ~line 123) — **per-route auth opt-out is
  already a supported, used pattern**, not something new this spec introduces. The precedent is
  `var.enable_e2e_cleanup_route`, which creates `DELETE /v1/users/e2e-cleanup` with `auth = false`.
- `POST /v1/trackings/init-tracking`, `GET /v1/trackings/{orderId}`, and the batch read are all
  declared `auth = true` (Cognito JWT). `PUT /v1/trackings/{orderId}/status` is declared
  **`auth = false`** — it is not behind the Cognito authorizer at all; the service validates the
  custom API key itself, the gateway only passes the request through. `GET /v1/tracking/health` is
  also `auth = false` — see
  [Gateway-prefixed health path](#gateway-prefixed-health-path-not-bare-v1health) for why it is
  prefixed rather than bare.
- Locally, the module uses **per-route `HTTP_PROXY` integrations** (a Floci workaround, not a
  production concern) — see [[local-gateway-per-route-integrations]]. Each new Tracking route gets
  its own local integration entry the same way Orders' routes did. In production it is a single
  shared integration.
- The `x-user-id` header on the three Cognito-authenticated routes (init-tracking, the single read,
  the batch read) comes from the local nginx+njs JWT decode, since Floci's API Gateway cannot map
  JWT claims to headers — see [[nginx-njs-x-user-id-injection]]. The PUT endpoint receives no such
  header (see below).

### REST reads

Tracking's reads are REST-only, user-scoped, and serve two purposes: letting the end user see their
own shipment, and giving the repo's [[testing]] convention an HTTP path to verify tracking state
from the gateway (see [Gateway E2E verification of TestMode](#gateway-e2e-verification-of-testmode)
below). They used to be paired with a second, unscoped gRPC surface for inter-service callers, which
was later removed — see
[Deltas from the original design (superseded)](#deltas-from-the-original-design-superseded) for why.

| | REST reads (`GET /v1/trackings/...`) |
|---|---|
| Caller | End user, through the gateway |
| Auth | Cognito JWT, validated by the gateway |
| Scope | **User-scoped** — filtered by `order_id` AND the caller's `cognito_sub`; only the caller's own trackings are ever returned — see [[user-id-vs-cognito-sub-ownership-key]] for why `user_id` must never be the filter |
| Purpose | Let the end user see their own shipment; also the only way to verify tracking state from the gateway (see [Gateway E2E verification](#gateway-e2e-verification-of-testmode) below) |

> [!note] Why reads exist on REST at all
> The original design had reads exposed only over gRPC. That left no way to verify tracking state
> **from the gateway** — the repo's [[testing]] convention requires a gateway E2E test with a real
> Cognito JWT for every endpoint, and the gateway speaks HTTP, not gRPC. There was no HTTP path to
> confirm a `TestMode` tracking actually reached `DELIVERED`. Beyond testing, the end user also has
> a legitimate need to see their own shipment. The unscoped gRPC reads for inter-service callers were
> later removed entirely, once the REST reads already served every consumer — see
> [Deltas from the original design (superseded)](#deltas-from-the-original-design-superseded).

### Ownership & scoping

Both REST read endpoints filter by `order_id` **and** `cognito_sub` in the query itself — not
`user_id`, and not fetch-then-compare — so a caller only ever receives trackings that belong to
them. The caller's identity comes from the gateway-injected `x-user-id` header, the same
mechanism [[orders-service-design]] uses (see its nginx+njs local gateway wiring). See
[[user-id-vs-cognito-sub-ownership-key]] for why the two identity columns are not
interchangeable and what breaks if a read is scoped by `user_id` instead.

This matches Orders' existing ownership semantics exactly (see
[[orders-service-design#API / Endpoints|the ownership note on `GET /v1/orders/{order_id}`]]):

- **Single read (`GET /v1/trackings/{orderId}`):** a tracking that exists but belongs to another
  user returns `404 Not Found`, the same response as a tracking that does not exist at all. The
  endpoint never answers `403 Forbidden` — that would leak the fact that *some* tracking exists for
  that `order_id`, just not to this caller.
- **Batch read (`GET /v1/trackings?order_ids=...`):** the equivalent rule is that non-owned ids
  (whether they belong to another user or don't exist) are simply **omitted** from the result list
  — never surfaced as a per-id error or partial-failure entry. A caller who passes ten ids and owns
  three gets back exactly three trackings, with no indication of what happened to the other seven.

> [!info] Erasure-only exception (2026-08-26) — reads are unaffected
> `DELETE /v1/trackings/by-user` (see [Account-deletion cascade
> (internal)](#account-deletion-cascade-internal) below) matches `cognito_sub OR user_id`, wider
> than the `cognito_sub`-only predicate above. **This widening is erasure-only.** Both REST reads
> continue to filter by `cognito_sub` alone, exactly as documented above — nobody should widen
> them to match the cascade's predicate. The cascade's own rationale for the OR (a user who
> deletes and re-registers gets a new sub, while `user_id` is stable; some pre-migration rows
> have a null `cognito_sub` reachable only through `user_id`) is documented in full at
> [[soft-delete#The per-user cascade]].

### Batch read query shape

`GET /v1/trackings?order_ids=ord_a,ord_b,ord_c` — a single query parameter holding a
comma-separated list of order ids — is the chosen shape for the many-trackings read. This is the
natural REST idiom for "give me N resources by id" (no request body on a `GET`, no need for a
non-standard batch-specific HTTP method). It also mirrored the shape of the now-removed gRPC
`GetTrackingsByOrderIds` method (which took `order_ids: [string]`, see
[Deltas from the original design (superseded)](#deltas-from-the-original-design-superseded)) closely
enough that the REST handler is a thin translation over the same repository query. The response is a
list of (`Tracking` + `Tracking_History`) pairs, same shape as the single-read endpoint's payload,
one per **owned** order id found among those requested (see
[Ownership & scoping](#ownership--scoping) for the omission rule).

### Gateway E2E verification of TestMode

`GET /v1/trackings/{orderId}` is what makes it possible to verify
[TestMode automatic progression](#testmode-automatic-progression) from the gateway: a gateway E2E
test (real Cognito JWT, hitting the gateway URL, per [[testing]]) can create an order with
`x-test-mode: true` and then **poll** `GET /v1/trackings/{orderId}` until `status` reaches
`DELIVERED`. Before this endpoint existed, there was no HTTP-reachable way to observe that
progression at all — the only reads were gRPC, which the gateway doesn't speak and which internal
tests would have to fake around, missing exactly the class of gateway-only bug [[testing]] exists
to catch.

## gRPC — outbound client to Users

**Tracking serves no gRPC.** It has no gRPC server, no `.proto` of its own, and no inbound
`x-api-key`. Every operation — creation and both reads — is REST, under
[API / Endpoints](#api--endpoints).

The single gRPC in this service points the other way: an **outbound client** calling
`users.v1.Users/GetUserById`, to turn the caller's Cognito `sub` into the internal `usr_` id.
It exists because the gateway hands Tracking a `sub` while the service also wants the internal
id for reporting and cross-service joins — see [Ownership & scoping](#ownership--scoping). This
is inter-service communication, so it stays gRPC per [[ADR-0003-grpc-inter-service]], and it
carries the internal `x-api-key` the Users surface expects.

| Call                          | Sent                     | Received                                              |
|-------------------------------|--------------------------|-------------------------------------------------------|
| `users.v1.Users/GetUserById`  | `{ id: <cognito sub> }`  | `{ id, email, full_name, cognito_sub, address }`      |

Only `id` is consumed by the identity-resolution path. The response also carries the user's
`address`, which Tracking deliberately ignores there: `init-tracking` receives `shipping_address`
in its body, so nothing on that path reads the profile address, and carrying PII through a path
that never uses it is a liability ([[logging-context]]).

> [!note] `ResolvedUser` was widened to carry `email` (events-pipeline milestone)
> `email` is now carried on the `ResolvedUser` domain value, alongside `address` — the exception
> to "no caller needs it" the original docstring reserved. The `TRACKING_STATUS_CHANGED`
> publisher must put the recipient's email address in the event payload: the pipeline's
> `tracking-status-changed` handler rejects a payload missing `email` as a `PermanentError`, so
> without it the notification would never send. Tracking persists no email of its own — Users is
> the only place that holds one — so this RPC's response is where it has to come from. `email` is
> PII exactly like `address`: never log a `ResolvedUser`; log `email_hash` instead, per
> [[logging-context]].

**`NOT_FOUND` means the user does not exist. Every other status propagates** — a Users outage,
a deadline, a rejected key. Collapsing them into "unknown user" would turn an infrastructure
failure into a wrong answer about identity.

This is the same shape Orders uses for its own caller context; see
[[orders-service-design]] and Orders' `ICurrentCaller`, whose central lesson Tracking copies:
reading the sub costs nothing, while resolving the internal id is an explicit, memoized call.
A property getter that fired gRPC would make the log enricher — which reads identity on every
event — a network dependency.

> [!info] `request_id` correlation
> Tracking seeds `request_id` in the existing ASGI `LogContextMiddleware`, the same hook that
> already calls `set_log_context`. It propagates the value onward on this outbound `GetUserById`
> call as `x-request-id` gRPC metadata, and as a root field on the `TRACKING_STATUS_CHANGED`
> envelope. `request_id` must be added to `_ALLOWED_KEYS` for `_clean` to keep it — an omission
> there drops the field silently, with no error — and the middleware's header-reading loop must
> not `break` on the first header match, or a second header (e.g. `x-user-id`) is lost. Full
> design: [[2026-08-15-request-id-correlation-design]].

## Response caching

> [!info] Shipped 2026-08-25 — Response Caching Layer milestone
> Full cross-service design: [[2026-08-25-response-caching-layer-design]]. Header contract:
> [[x-cache-response-header]]. Tracking runs the full four-component shape — response cache,
> identity-mapping cache, invalidation, and the kill switch — and is the one service with a
> service-local `cache_timeout_ms` setting.
>
> **Behaviour below is unchanged by the Go cutover; file paths below are the retired Python
> implementation.** The Go equivalents live in `internal/adapter/redis/` (`gateway.go`,
> `keys.go`, `identity.go`, `invalidation.go`) — the response-key shapes, TTLs, the
> normalized-then-hashed list key, the identity cache, and the fail-open kill switch are the
> same contract, reimplemented. The identity-cache-hit-must-stamp-the-resolved-id trap below
> has a direct Go analogue: `StampResolvedUserID` on the reads' route group, documented in
> `services/tracking-go/CLAUDE.md` §9 ("The identity stamp is on a GROUP, not global") as one
> of the four wiring-hazard bugs this migration's closing gate caught — see
> [[2026-08-27-tracking-go-migration-design]] and
> [[2026-08-27-a-component-can-be-fully-unit-tested-and-still-never-run-in-production]].

### Cached reads and their TTL

Both REST reads are cached, 60s TTL each, matching the delivery-status update cadence:

| Route | Key | Notes |
|---|---|---|
| `GET /v1/trackings/{orderId}` | `tracking:order:v1:{sub}:{user_id}:{order_id}` | `CacheKeys.tracking_order` |
| `GET /v1/trackings?order_ids=...` | `tracking:list:v1:{sub}:{user_id}:{hash}` | see [Normalized-then-hashed list key](#normalized-then-hashed-list-key) below |

`_serve_cached`/`_store_cached` (`api/trackings_router.py`) are the shared helper pair both routes
call. A key builder that returns `None` — because `user_id` could not be resolved this request
(see [The identity cache](#the-identity-cache-and-seed_resolved_internal_user_id) below) — makes
the route skip caching entirely: a `MISS` with no Redis write, served correctly from MySQL. With
`CACHE_ENABLED=false` (`CacheEnabledDep`) `_serve_cached` stamps **no** `X-Cache` header at all,
the same "invisible, not a permanent BYPASS" contract every service in this design follows.

### Normalized-then-hashed list key

`order_ids` on the batch read is an arbitrary, caller-supplied list up to `MAX_BATCH_ORDER_IDS`
(100). `CacheKeys.tracking_list` sorts and deduplicates the list **before** hashing it
(`_hash_order_ids`, `shared/cache/keys.py`), so `?order_ids=b,a` and `?order_ids=a,b,a` collapse to
one key — both a cardinality bound (raw-list keying would make the key space combinatorial) and a
hit-rate improvement, since two callers asking for the same set in different orders now share an
entry. sha256, not Python's built-in `hash()` — the latter is salted per process
(`PYTHONHASHSEED`), so two replicas would compute *different* keys for the same request and the
cache would never hit across them. Truncated to 16 hex characters (64 bits), negligible collision
risk for this keyspace, short enough to read in `redis-cli`.

### `tracking:index:v1:{sub}:{user_id}` — the per-user key index

Required because the list key embeds a hash of an arbitrary id set and therefore cannot be
reconstructed at invalidation time. `CacheKeys.user_index` builds it; the read path adds every list
key to it as it writes (`gateway.set(..., index_key=...)`); invalidation deletes every member and
then the index itself (`invalidate_index`). Deliberately **not** `KEYS`/`SCAN` — both are O(N) over
the whole keyspace, and `KEYS` blocks the server for the duration of the sweep, which is
unacceptable on a write path a carrier webhook or an account-deletion cascade can trigger.

### The identity cache, and `seed_resolved_internal_user_id`

Tracking's identity-mapping cache (`IdentityCache`, `shared/cache/identity_cache.py`) is the
Tracking half of
[[2026-08-25-response-caching-layer-design#Fourth component — the identity-mapping cache (Orders and Tracking only)]]:
key `identity:sub-to-user:v1:{cognito_sub}`, 1h TTL, consulted before a response key can even be
built, since every response key carries `user_id` and Tracking only learns it from an outbound
gRPC call to Users. TTL-only invalidation is correct here, not a gap: a `cognito_sub` never
resolves to a different `user_id` while the account exists, so a stale entry can only be *late*,
never *wrong* — see `shared/cache/identity_cache.py`'s module docstring for the full argument, and
[Account-deletion cascade (internal)](#account-deletion-cascade-internal) below for the one case
(a deleted account) that is no longer left to the TTL alone.

> [!important] `seed_resolved_internal_user_id` — the single line the whole response cache depends
> on
> `caller.py`'s `CurrentCaller` memoizes `user_id` per request, filled one of two ways: a real gRPC
> call (`resolve_internal_user_id`), or a value already known from elsewhere via
> `seed_resolved_internal_user_id` (`caller.py:121-133`) — **no I/O**, just populating the memo. The
> load-bearing call site is `log_identity.py:218-220`: on an identity-cache **hit**,
> `IdentityCache.resolve` returns the `user_id` *without running its loader* — correctly, that is
> the entire point of a cache hit — but the loader is the only thing that would otherwise call
> `caller.seed_resolved_internal_user_id`. Without this line, a hit leaves `_resolved` at `None`,
> `resolved_internal_user_id` (the property both cached-read handlers consult to build their
> response key) answers `None`, `CacheKeys` refuses to build a key for a `None` `user_id`, and the
> response cache **silently does nothing at all from the second request onward**, for the full hour
> the identity entry lives — this is exactly what happened in production before the line was added.
> The two caches are connected through this one call.

### `cache_timeout_ms` — a settings field that exists only in this service

`Settings.cache_timeout_ms` (`shared/config/settings.py`, default `50`, `Field(gt=0)`) is a
**Pydantic settings field**, unlike Orders and Tracking's siblings: Orders hardcodes `50` ms as a
`TimeSpan.FromMilliseconds(50)` literal in `Program.cs`, and Users hardcodes `TIMEOUT_MS = 50` as a
module constant in `cache-gateway.ts`. Both the connect and the socket timeout use this one budget
— a connect slower than the whole operation budget has already blown it. The behavior is identical
across all three services (fail open on timeout); only Tracking's is externally configurable
without a code change.

### `NullCacheGateway` — the kill switch

`shared/cache/gateway.py`'s `NullCacheGateway` is the binding used when `CACHE_ENABLED=false`, and
it is a **null object**, not a gateway with an `if` inside it: every route has exactly one code
path, and "the cache is off" is expressed by *which object is bound* rather than a branch in every
handler. `get_cache_gateway` (`shared/http/cache_dependencies.py`) also degrades to it when a real
gateway cannot even be constructed (an incomplete environment) — the same object a disabled cache
binds, so an unbuildable cache behaves precisely like a deliberately-disabled one. Its `get` answers
a plain `MISS`; the routes read `cache_is_enabled` separately to decide whether to emit an
`X-Cache` header at all, so a disabled cache emits **no** header — never `MISS`, never `BYPASS`.

### `cache_result` is captured by middleware off the response header — not set by the handler

`_serve_cached`/`_store_cached` stamp `X-Cache` on the **response object**, not on the log context,
and deliberately so: the cached-read handlers in `trackings_router.py` are plain `def` functions
(pymysql is a blocking driver), which FastAPI runs in its threadpool — and a threadpool worker holds
only a **copy** of the request's context. A `merge_log_context` call made from inside one of those
handlers would set the copy and be silently discarded on return, the same `asyncio.to_thread`
context-loss trap [[2026-07-31-contextvars-lost-across-task-boundaries]] documents for
`LogContextMiddleware`. `LogContextMiddleware._capture_cache_result` reads the `X-Cache` header back
off the **response**, on the request's own async context, after the handler has already run —
sidestepping the trap entirely rather than requiring every cached handler to remember it.

### Invalidation

Two shapes, both in `shared/cache/invalidation.py`, both scheduled as a `BackgroundTask` — never
called inline — because they must run **strictly after** their triggering transaction commits (see
the long comment in `carrier_router.py` for why this is a property of the ASGI response cycle, not
a timing hope):

- **`invalidate_tracking`** — the carrier-webhook leg (`PUT /v1/trackings/{orderId}/status`,
  `api/carrier_router.py`). The webhook carries no `x-user-id` at all (it is authenticated by
  `TRACKING_CARRIER_API_KEY`, not a Cognito JWT), so the owner comes off the **persisted row**
  `update_tracking_status` already returned: `Tracking.cognito_sub` and `Tracking.user_id`, the
  same identity the reads' ownership filter compares against. Deletes the single-read key by name
  (reconstructible, since the webhook holds the order it just wrote) and invalidates the caller's
  index (covering the unreconstructible list-key hashes). A `NULL cognito_sub` is a deliberate
  no-op: a row with no owner sub is unreachable over the user-scoped reads in the first place, so
  it was never cached and there is nothing to evict.
- **`invalidate_user`** — the account-deletion cascade leg (`DELETE /v1/trackings/by-user`,
  `api/internal_router.py`, guarded by `InternalAuth`/`GRPC_API_KEY`). Sweeps **both** namespaces
  under **both** of the deleted person's identifiers — the response-entry index and the identity
  mapping — for the same raw-header reason documented in
  [[2026-08-26-cache-keys-built-from-a-raw-identity-header]]: a response key is built from
  whichever identifier the *client* authenticated with, while the cascade's body carries only the
  canonical `cognito_sub`/`user_id` pair, so sweeping the canonical pair alone leaves a
  `usr_`-id-keyed entry resolving a deleted account for up to an hour. `BackgroundTask` scheduling
  applies here too — the deletion has already committed by the time this runs, so a Redis failure
  must never surface as a failed account deletion.

## Account-deletion cascade (internal)

> [!info] Shipped 2026-08-26 — Account Deletion milestone
> Full design: [[2026-08-25-account-deletion-design]]. `DELETE /v1/trackings/by-user` is one of
> two internal cascade legs `DELETE /v1/users/me` calls synchronously; see
> [[users-service-design#Account deletion]] for the caller side and
> [[orders-service-design#Account-deletion cascade (internal)]] for the sibling route.

The route is guarded by `InternalAuth`/`RequireInternalKey`
(the same `GRPC_API_KEY` comparison Tracking's outbound gRPC client already presents, now
validated the other direction too — see [Auth schemes](#auth-schemes) above). Not on the API
Gateway; the only caller is Users' `CascadeClient`.

### Route-ordering trap — a Python-specific failure mode the Go port does not inherit

> [!note] Historical (Python implementation, retired) — the Go service has a related but different trap
> The Python service (`services/tracking/`, retired) matched routes via Starlette, which resolves
> by **declaration order**, not specificity: `/v1/trackings/by-user` is a literal path segment
> sitting exactly where `GET /v1/trackings/{order_id}`'s path parameter also matches, so
> `main.py` had to register `internal_router` **before** `trackings_router` or a request to
> `/v1/trackings/by-user` would be captured by `{order_id}` — with `order_id` literally bound to
> the string `"by-user"`. A regression test pinned that ordering.
>
> **Gin (the Go service) does not have this failure mode, but has a related one that is arguably
> worse: it panics at startup instead of misrouting silently.** Gin builds one radix route tree
> **per HTTP method**, so `POST /init-tracking`, `DELETE /by-user`, and `DELETE /e2e-cleanup`
> coexist with `GET /v1/trackings/:order_id` today only because their **methods differ** —
> registration order is irrelevant. Adding any **GET literal** under `/v1/trackings/` (e.g.
> `GET /v1/trackings/summary`) would land in the wildcard's tree and **panic the process at
> boot**, rather than silently misrouting a request the way Starlette could have. Whoever adds
> such a route must restructure the prefix. Full detail:
> `services/tracking-go/CLAUDE.md` §4 ("Gin panics at startup on a route conflict").

### `soft_delete_by_user` — children before parents, and one deliberate non-guard

The route delegates to the per-user soft-delete query (Go: `internal/adapter/mysql`; the retired
Python service called it `TrackingRepository.soft_delete_by_user`,
`src/features/tracking/domain/repository.py`), the per-user sibling of the tag-scoped
soft-delete (see [E2E cleanup](#e2e-cleanup-delete-v1trackingse2e-cleanup) above for that
method) — same never-a-SQL-DELETE shape, same FK-following order, different selector:

- **Children (`Tracking_History`) before parents (`Tracking`)**, mirroring the FK direction, so
  an interrupted run can never leave a live history row under an already-deleted tracking.
- Both statements are bulk `UPDATE`s guarded per-row by `deleted_at IS NULL`, keeping the whole
  operation idempotent — a retry after a partial cascade failure re-stamps only what is still
  live.
- **The parent-id selection is deliberately NOT filtered on `deleted_at IS NULL`.** An
  already-soft-deleted tracking may still have **live** history under it from a partial previous
  run (e.g. the history leg of a prior cascade attempt failed after the parent had already been
  stamped), and that live history must still be swept on retry. Filtering the parent selection
  by `deleted_at IS NULL` would make that history permanently unreachable through this method —
  the per-statement `deleted_at IS NULL` guards on each `UPDATE` are what keep the operation
  idempotent, not a filter on which parents are considered.
- Matches `cognito_sub OR user_id`, same predicate and same rationale as the reads' erasure-only
  exception above and [[soft-delete#The per-user cascade]] — an empty identity on either side is
  refused (the retired Python service raised `ValueError`; Go returns a validation error), a
  second gate behind the request schema's minimum-length check (see
  [[2026-08-25-account-deletion-design#Empty-identity guards (four layers)]] for the full
  four-layer table).

### Audit actor and observability

Every row this route stamps carries `deleted_by = "tracking_api:delete_by_user"`
(`internal/domain/audit`; the retired Python service defined the same value as
`AuditActor.DELETE_BY_USER` in `src/shared/audit/audit_actor.py`), the Tracking peer of Orders'
`"orders_api:delete_by_user"`.

The route is wrapped in one workflow span (`internal_delete_by_user`, via `otelgin`/the Go OTel
wiring — the retired Python service used `workflow_span("internal_delete_by_user", …)`),
emitting:

| `app_event` | When | `reason` |
|---|---|---|
| `internal_delete_by_user_started` | Once `InternalAuth` has passed | — |
| `internal_delete_by_user_succeeded` | With `deleted_count` | — |
| `internal_delete_by_user_failed` | A database fault mid-cascade | `db_error` |

Unlike Orders' sibling route, an invalid API key here is rejected by the `InternalAuth`
**dependency** before the route body — and therefore before the workflow span — ever runs, so
there is no `internal_delete_by_user_failed` line for that case; it never reaches this handler at
all. Full cross-service event contract:
[[2026-08-25-account-deletion-design#Observability]].

### The "nothing on the default surface removes a tracking" invariant, narrowed

Tracking's test suite previously asserted — only in a test docstring, not in this spec — that
**nothing on the default (non-E2E) surface ever deletes a tracking**. `DELETE
/v1/trackings/by-user` is the **one deliberate exception**: the invariant is now "nothing on the
default surface removes a tracking, **except the single, internally-authenticated,
non-gateway-exposed erasure route**" — an allowlist of exactly one route, not a blanket rule any
more. Recorded here so the exception is documented where a reader of this spec would look for it,
not only in `services/tracking/tests/test_app_factory.py`'s docstring.

All IDs use prefixed nano-IDs ([[nano-id]]). All tables apply soft-delete ([[soft-delete]]), audit fields ([[audit-fields]]), and follow naming conventions ([[db-naming]]).

> [!note] Every id-bearing column is `VARCHAR(28)`, not `VARCHAR(21)`
> This table previously listed id columns as `VARCHAR(21)` — that was wrong from the start, not a
> regression from a prior-correct value: it recorded only the nanoid portion's length and omitted
> the 4-character prefix (`trk_`, `usr_`, `ord_`), so it was never actually 26 either. The real
> stored width is `PREFIX_LENGTH + LENGTH` = 4 + 24 = **28**, per [[nano-id]]. Getting this wrong
> matters because MySQL truncates a too-long `varchar` silently rather than erroring — a
> too-narrow column would corrupt every id written to it with nothing surfacing anywhere. Verified
> live against `tracking`'s MySQL schema (2026-08-16): `id`, `user_id`, `order_id` on `Tracking`,
> and `tracking_id`, `user_id`, `order_id` on `Tracking_History` are all `varchar(28)`.
> `created_by`/`updated_by`/`deleted_by` on both tables are a separate, unrelated `varchar(64)` —
> free-text audit-actor labels ([[audit-fields]]), not nano-ids, and out of scope here.

### `Tracking`

| Column       | Type         | Notes                              |
|--------------|--------------|------------------------------------|
| `id`         | VARCHAR(28)  | Prefixed nano-ID, PK               |
| `user_id`    | VARCHAR(28)  | The internal `usr_` id, as Orders resolved it from Users. For reporting/joins only — **not** the ownership key reads filter by (see `cognito_sub` below). |
| `cognito_sub` | VARCHAR(255), nullable | **The ownership key every user-scoped REST read filters by** — see [[user-id-vs-cognito-sub-ownership-key]] and [Ownership & scoping](#ownership--scoping). Nullable: a row created before this field existed, or by a caller that omitted it, is simply unreachable over the user-scoped reads rather than mis-attributed to someone else. |
| `order_id`   | VARCHAR(28)  | Reference to order, unique         |
| `status`     | VARCHAR(50)  | Current delivery status — enum: `PLACED`, `PROCESSING`, `SHIPPED`, `OUT_FOR_DELIVERY`, `DELIVERED` (see [Tracking statuses](#tracking-statuses)) |
| `shipping_address` | JSON  | Snapshot of the delivery address, received as-is in the `init-tracking` request body — see [Delivery address snapshot](#delivery-address-snapshot) below. |
| `tags`       | JSON, `NOT NULL DEFAULT (JSON_ARRAY())` | Free-form labels; today only `"E2E Source"` is ever written, by [`init-tracking`](#api--endpoints) when the request carries `x-e2e-source: true` under `E2E_TESTING_ENABLED` — see [E2E cleanup](#e2e-cleanup-delete-v1trackingse2e-cleanup). MySQL has no array type, so this is a JSON array queried with `JSON_CONTAINS` rather than a Postgres-style `text[]`. |
| `datetime`   | DATETIME     | Timestamp of the current status    |
| `created_at` | DATETIME     | Audit — see [[audit-fields]]       |
| `updated_at` | DATETIME     | Audit — see [[audit-fields]]       |
| `deleted_at` | DATETIME     | Soft-delete — see [[soft-delete]]  |

#### Delivery address snapshot

`shipping_address` arrives in the `init-tracking` request body (see
[API / Endpoints](#api--endpoints)) and is persisted once, at tracking-creation time — Tracking
does not re-fetch or refresh it, and does not read the address Users returns on its own identity
lookup. It originates in Users and is resolved by Orders during order creation; the full chain is
documented in [[orders-service-design#Delivery address flow (Users → Orders → Tracking)]].

> [!note] Snapshot, not a live reference — deliberately
> This is a point-in-time copy, same as `Order.shipping_address` in Orders (see
> [[orders-service-design]]). If the user's profile address later changes, this record must
> continue to reflect the address the shipment was actually sent to. Do not replace it with a live
> lookup back to Users.

> [!warning] `Tracking_History` does NOT get this column
> The delivery address does not change per status transition — it is fixed for the lifetime of a
> given tracking record. Only `Tracking` carries `shipping_address`; do not add it to
> `Tracking_History` below.

### `Tracking_History`

Immutable log of every status transition.

| Column        | Type         | Notes                                   |
|---------------|--------------|-----------------------------------------|
| `tracking_id` | VARCHAR(28)  | FK → `Tracking.id` (part of PK)         |
| `user_id`     | VARCHAR(28)  | Reference to user                       |
| `order_id`    | VARCHAR(28)  | Reference to order                      |
| `cognito_sub` | VARCHAR(255), nullable | Denormalized off the parent `Tracking`, same as `user_id`/`order_id` above — a transition row needs its own ownership context to stay self-describing, and the read-scoping index below keys on it. |
| `status`      | VARCHAR(50)  | Status at the time of the event — enum: `PLACED \| PROCESSING \| SHIPPED \| OUT_FOR_DELIVERY \| DELIVERED` (part of PK) |
| `datetime`    | DATETIME     | Timestamp of this status transition     |
| `created_at`  | DATETIME     | Audit — see [[audit-fields]]            |
| `updated_at`  | DATETIME     | Audit — see [[audit-fields]]            |
| `deleted_at`  | DATETIME     | Soft-delete — see [[soft-delete]]       |

**Composite PK:** `(tracking_id, status)`.

> [!note] No `tags` column here — deliberately
> Unlike `cognito_sub`, `tags` is **not** denormalized onto `Tracking_History`. History rows are
> reached through their parent's FK, so "the children of every tagged tracking" is already
> expressible without copying the tag down — see [E2E cleanup](#e2e-cleanup-delete-v1trackingse2e-cleanup).
> Copying it would give the tag two sources of truth that a partial update could put out of step.

### Tracking statuses

The `status` field is a fixed enum shared by `Tracking` and `Tracking_History`. Only these five values are valid:

| Value                | Meaning                                           |
|----------------------|---------------------------------------------------|
| `PLACED`             | The order has been placed; this is the initial status a tracking is created at. |
| `PROCESSING`         | The order is being prepared/picked at the warehouse, not yet handed to a carrier. |
| `SHIPPED`            | Handed to the carrier and on its way to the destination — absorbs what the former `ON_THE_WAY` status meant; there is no separate "in transit" status. |
| `OUT_FOR_DELIVERY`   | The shipment is out for final-mile delivery.      |
| `DELIVERED`          | The shipment has been delivered to the recipient. |

**State machine — allowed progression (forward only):**

```
PLACED → PROCESSING → SHIPPED → OUT_FOR_DELIVERY → DELIVERED
```

This progression is enforced in two places: automatically, during
[TestMode automatic progression](#testmode-automatic-progression); and on every real update, via
the [State machine & update guards](#state-machine--update-guards) below.

### TestMode automatic progression

The `init-tracking` endpoint accepts a `test_mode` boolean. When it is true, the created tracking
starts at `PLACED` and then advances one status automatically every **10 seconds**, following the
forward-only progression above, until it reaches `DELIVERED`:

| Elapsed | Status              |
|---------|----------------------|
| t=0s    | `PLACED` (record created) |
| t=10s   | `PROCESSING`          |
| t=20s   | `SHIPPED`             |
| t=30s   | `OUT_FOR_DELIVERY`    |
| t=40s   | `DELIVERED`           |

Each automatic transition writes a `Tracking_History` row, so a completed `TestMode` run leaves 5
history entries in total. When `TestMode` is false or absent, no automatic progression happens —
status only advances through the `PUT /v1/trackings/{orderId}/status` endpoint below.

Scheduling mechanism, and the accepted limitation if the process restarts mid-progression:
[[testmode-in-process-no-durable-scheduler]] (the ADR's decision — in-process, no durable scheduler —
was carried into the Go port unchanged; the retired Python service scheduled it as an
`asyncio` task, the Go service as a goroutine holding the **process-lifetime** context, never
the request's — see `services/tracking-go/CLAUDE.md` §10 for the Go-specific trap of a
goroutine accidentally inheriting a request context that `net/http` cancels the instant the
response is written, which is invisible-looking because it produces the *exact same symptom*
as the accepted restart limitation).

#### End-to-end origin: a client header on Orders, not an Orders-side decision

`test_mode` is not a value Orders decides on its own — it originates as an **optional HTTP header
on the client's `POST /v1/orders` request** (see [[orders-service-design]]), so the whole flow can
be exercised end to end from the gateway without special-casing Orders. Tracking's contract stays
exactly the `test_mode` field on `init-tracking` above; Tracking has no knowledge of the header —
this section documents the path leading up to that field for the reader tracing the flow.

1. **Header:** `x-test-mode: true` on `POST /v1/orders` (the Orders endpoint) — kebab-case with the
   `x-` prefix, consistent with the repo's existing `x-user-id` and `x-api-key`.
2. **Activation:** only the exact string value `"true"` activates it. Absent, empty, or any other
   value means false.
3. **Guard:** the header only takes effect when the `E2E_TESTING_ENABLED` environment flag is on —
   the same protection Orders already uses for its flag-guarded e2e-cleanup endpoint (JE-54). In
   production the flag is off, so the header is ignored and the simulation can never be triggered
   there; when the flag is off, `test_mode` is always false regardless of the header.
4. **Propagation:** Orders reads the header, applies the guard, and passes the resulting boolean as
   `test_mode` on its HTTP call to `init-tracking` — forwarding the `x-user-id` it received from
   the gateway, so Tracking resolves the caller itself rather than being told who they are.

This is the same context-propagation shape the repo already uses for `x-user-id` (gateway →
service) and W3C `traceparent` (service → service).

```
client → POST /v1/orders (x-test-mode: true)
       → Orders: E2E_TESTING_ENABLED ? header=="true" : false
       → POST /v1/trackings/init-tracking
           { order_id, shipping_address, test_mode }   x-user-id forwarded
       → Tracking: PLACED, then +10s each → DELIVERED
```

> [!warning] Orders carries a small but load-bearing responsibility here
> This decision spans two services. Orders owns reading the header, applying the
> `E2E_TESTING_ENABLED` guard, and propagating both the resulting boolean and the caller's
> `x-user-id` to `init-tracking` — a future change to Orders' order-creation flow must not drop
> either, or `test_mode` silently goes permanently false and the tracking loses its owner. See
> [[orders-service-design]] for the Orders-side contract.

### State machine & update guards

`PUT /v1/trackings/{orderId}/status` exists to **simulate a third-party carrier service**
notifying Tracking of a delivery status change. It is subject to the following guards:

> [!important] No JWT, no `x-user-id` — identified by `orderId` alone
> Unlike the two REST read endpoints, this endpoint is **not** called by an end user through the
> Cognito authorizer — it is called by an external carrier/webhook authenticated with a custom API
> key (see [Auth schemes](#auth-schemes)). Its gateway route carries no JWT authorizer, so there is
> no gateway-injected `x-user-id` header on this request at all. Consequently the handler cannot
> scope or verify the caller by identity the way the GET reads do (see
> [Ownership & scoping](#ownership--scoping)) — it identifies the tracking to update purely by the
> `orderId` path parameter (see [Gateway path params are camelCase](#gateway-path-params-are-camelcase-not-snake_case)).
> An implementer who assumes `x-user-id` is present here will write broken code; do not reuse the
> read endpoints' ownership-filter logic on this handler.

> [!warning] No updates once delivered
> A tracking whose status is already `DELIVERED` (terminal) cannot be updated at all — any
> `PUT /v1/trackings/{orderId}/status` request against it must be rejected with `400 Bad Request`.

> [!warning] No backward transitions
> A `DELIVERED` (or any later-status) tracking cannot move back to an earlier status — e.g.
> `DELIVERED` → `SHIPPED` is rejected with `400 Bad Request`.

> [!warning] Forward-only, strictly ahead
> Status updates must otherwise follow the progression above. A request with a status that is
> equal to or earlier than the current status must be rejected with `400 Bad Request`.

## Events

> [!info] Reversal — Tracking now publishes (events-pipeline milestone, 2026-08-04)
> This note previously stated Tracking emits no domain events and is a pure consumer/updater.
> That was accurate before the events-pipeline milestone; it is no longer true. Tracking is now
> a **third producer** alongside Users and Orders, publishing to the same shared SQS queue
> [[events-pipeline-design]] consumes. See [[2026-08-03-events-pipeline-milestone-design]] for the
> full design.

Tracking publishes `TRACKING_STATUS_CHANGED` from `update_tracking_status`
(`src/features/tracking/commands/update_status.py`) — the **single write path** shared by both
the carrier webhook (`PUT /v1/trackings/{orderId}/status`) and TestMode's automatic progression
(see [TestMode automatic progression](#testmode-automatic-progression)). Emitting from this one
call site, rather than from each caller separately, is what guarantees both paths notify the same
way instead of drifting apart.

- **Every successful transition emits, `DELIVERED` included — no suppression. But the event count
  is one less than the status count.** `PLACED` is not a transition: it is the status written by
  `create_tracking` at the moment the tracking is created, and `create_tracking.py` never calls
  `_emit_status_changed` — only `update_tracking_status` does. A TestMode run that walks a
  tracking through `PLACED → PROCESSING → SHIPPED → OUT_FOR_DELIVERY → DELIVERED` in ~40 seconds
  therefore makes exactly **four** calls into `update_tracking_status` (the four automatic
  advances) and produces **four emails in Mailpit** for that one tracking, not five. This is
  expected, not a bug; E2E assertions for Tracking must account for the four *transitions*
  (`PROCESSING`, `SHIPPED`, `OUT_FOR_DELIVERY`, `DELIVERED`), not the five *statuses* — and not
  just the final `DELIVERED` state either.
  >
  > The off-by-one here has been got wrong twice, in both directions, so it is worth stating
  > plainly: **five history rows, four events.** Verified empirically (2026-08-06) by a live
  > gateway E2E run for the realtime WebSocket fan-out (see
  > [[2026-08-05-realtime-tracking-events-websocket-design#Gateway E2E — the test that matters]]):
  > the client received one push per transition and never one for the creation status, matching
  > `TRACKING_STATUS_CHANGED` firing from `update_status.py` alone.
- **`user_id` on the envelope comes from the persisted tracking row, not the request.** The
  carrier webhook carries **no** `x-user-id` at all — it is authenticated by an API key, not a
  Cognito JWT, and its repository lookup is deliberately unscoped (see
  [State machine & update guards](#state-machine--update-guards)). `_emit_status_changed` reads
  `updated.user_id` off the entity `update_tracking_status` already loaded and returned — the
  only source of an owner for this event.
- **`author.cognito_sub` also comes from the persisted row, not the request — added for the
  realtime WebSocket fan-out (2026-08-06).** The publisher now additionally reads
  `updated.cognito_sub` off that same already-loaded entity and sets it on the envelope's
  `author.cognito_sub` (see [[events-pipeline-design#The envelope's author object]]). Same
  reasoning as `user_id` above, for the same reason: the carrier webhook has no `x-user-id`, so
  the persisted row is the only source of identity available at this call site — there is no
  request-side value to prefer over it even by convention.
  - **Why the pipeline needs it:** [[events-pipeline-design#Realtime WebSocket fan-out (second output of TRACKING_STATUS_CHANGED)]]
    queries its DynamoDB connections table by `cognito_sub`, not by `user_id` — the connections
    table only ever learns a caller's Cognito `sub` (from the WebSocket `$connect` JWT), never
    their internal `usr_` id. Querying that GSI with the internal id `Tracking.user_id` carries
    would return an **empty list with no error at all** — indistinguishable from "user has no
    open connections." See [[user-id-vs-cognito-sub-ownership-key]] for the same trap already
    documented on this service's own REST reads.
  - **Omitted, never null, when absent** — `Tracking.cognito_sub` is nullable (see
    [Data Model](#tracking) below: a row created before the column existed, or by a caller that
    omitted it). The publisher only sets `author.cognito_sub` `if cognito_sub:` (a falsy check
    that also excludes an empty string), so a legacy row with no `cognito_sub` produces an
    envelope where the field is simply absent — never `author.cognito_sub: null`. This matches
    the omit-not-null convention already established for `author.user_id`
    (see [[events-pipeline-design#The envelope's author object]]) and means the realtime fan-out
    is silently skipped for that event (the email still sends); it is not an error condition on
    either side.
- **`event_id` is derived from `(order_id, status)`, not generated fresh per attempt.** Given the
  forward-only state machine, this pair is a natural key for a transition. This matters because
  of TestMode: if `event_id` were regenerated on every send attempt, a retry of the same
  transition (e.g. after a transient SQS error) would mint a new id, miss the events-pipeline's
  unique-index dedupe, and send a duplicate notification email for a transition that had already
  succeeded. Deriving from `(order_id, status)` means a retry of the same transition always
  collides on the same id.
- **Publish failures are logged and swallowed, never re-raised.** A `500` here would make the
  carrier's webhook retry a status change that is **already recorded**; the forward-only guard
  would then reject that retry as `400 not_strictly_forward` for a transition that genuinely
  happened — turning a notification failure into a spurious rejection of a legitimate carrier
  update. `SqsEventPublisher`/the publisher-resolution path swallows both send failures and
  publisher-construction failures for this reason; see `_emit_status_changed`'s docstring in
  `update_status.py`.
- **The queue URL is generated, never hardcoded** — `EVENTS_QUEUE_URL` is written into
  `.env.local.tracking` by `make env-file`, the same generated-env-file pattern Users and Orders
  use. See [[env-files]].

Tracking's publisher is a Go `aws-sdk-go-v2` SQS client (`internal/adapter/sqs`, `SendMessage`),
setting `type` and `source` (`"tracking"`) as message attributes, matching the shape of the
Users and Orders publishers. The retired Python service published the same envelope shape via
`boto3`'s `send_message`. A nil/noop publisher is retained for tests that must not emit,
mirroring `NoopEventPublisher` in Users and Orders — in Go this is the composition root binding
a nil `EventPublisher` when `EVENTS_QUEUE_URL` is absent (see `services/tracking-go/CLAUDE.md`
§3, "Flags are decided in the composition root and nowhere else").

See [[events-pipeline-design]] for the consuming side: the shared queue, the dispatch map, the
error taxonomy that decides whether a publish-side failure downstream gets retried, and the
`tracking-status-changed` email template family (one event type, five rendered variants selected
by `payload.status`).

## Metrics

> [!info] Shipped 2026-08-12 — Custom Business Metrics milestone
> Full design and the Floci/OpenObserve gotchas that constrain this metric:
> [[2026-08-12-custom-business-metrics-cloudwatch-design]]; the CloudWatch-not-OTLP pipeline and
> the shared query gotchas are in [[logging-context#Metrics — the third pillar, and why it does
> NOT go over OTLP]].

| Metric | Type | Dimensions |
|---|---|---|
| `orders_by_tracking_status_total` | gauge | `Service=tracking`, `Status=DELIVERED\|IN_PROGRESS` |

A gauge, split into `DELIVERED` (finished) and `IN_PROGRESS` (everything else — `PLACED`,
`PROCESSING`, `SHIPPED`, `OUT_FOR_DELIVERY`), published by a periodic task that `GROUP BY`s
`Tracking.status` on Tracking's own database.

**`DELIVERED` is the state machine's terminal status ([Tracking statuses](#tracking-statuses)),
so "finished" is the domain's own invariant, not a convention invented for this metric.** Nothing
follows `DELIVERED` and no update is accepted against it (see [State machine & update
guards](#state-machine--update-guards)).

**Counting trackings is counting orders, without double-counting.** `Tracking.order_id` carries
`UniqueConstraint("order_id", name="uq_tracking_order_id")` — strictly one tracking per order, so
a `GROUP BY status` over `Tracking` is exactly a count of orders by their tracking status, with no
join or dedup needed.

Together with Orders' `orders_total` ([[orders-service-design#Metrics]]), this metric is one half
of the Orders→Tracking integration health indicator: `orders_total − (DELIVERED + IN_PROGRESS)`
should be 0 in normal operation. See [[orders-service-design#Metrics]] for the full reasoning and
the deliberately-accepted failure mode it surfaces.

> [!note] Historical (Python implementation, retired)
> The retired Python service started this periodic gauge-publishing task from a FastAPI
> `lifespan` added to `src/main.py`, gated on `METRICS_ENABLED` so the test app factory
> (`tests/conftest.py`, called for every REST test) never opened a real database session or
> reached for CloudWatch on a test run. The Go service composes the equivalent ticker in
> `cmd/server/main.go`, gated the same way — flags are decided once, in the composition root,
> and turned into a dependency (a real ticker or none), never branched on inside a handler; see
> `services/tracking-go/CLAUDE.md` §3.

## Change impact — renaming a delivery status

Renaming a value in the delivery-status enum ([Tracking statuses](#tracking-statuses)) touches
**11 files across 4 components**, crossing a service boundary over SQS — it is not a Tracking-local
change, even though Tracking owns the enum. The same shape of surprise applies to
[[users-service-design#Change impact — editing `proto/users.proto`|editing `proto/users.proto`]]:
in both cases the owning service can change its contract without anything forcing the downstream
consumer to notice.

> [!note] File list below reflects the Go service — historical Python paths retired
> This list was originally written against the Python implementation; the file set below is the
> Go equivalent (`services/tracking-go/`). The Python originals (`src/features/tracking/domain/status.py`,
> `src/features/tracking/commands/update_status.py`, `src/features/tracking/commands/test_mode_progression.py`,
> `src/features/tracking/api/schemas.py`, `src/shared/audit/audit_actor.py`, and the
> `test_*.py` suite) are retired along with `services/tracking/`. The cross-service shape of the
> risk — an owning service can change an enum crossing SQS with nothing forcing the downstream
> consumer to notice — is unchanged by the language the owner is written in.

- **Tracking (owner):** `internal/domain/status.go`, `internal/domain/tracking.go`,
  `internal/app/update_status.go` (the carrier PUT and TestMode's shared transition function —
  see [[testmode-in-process-no-durable-scheduler]]), `internal/adapter/http` request/response DTOs for
  the status field, `internal/domain/audit/actor.go`
- **events-pipeline (consumer):** `src/handlers/tracking-status-changed.ts`,
  `src/handlers/index.ts`, `src/email/catalog.ts`, `emails/tracking-status-changed.tsx`
- **Orders (consumer):** `services/orders/tests/Orders.Tests/Infrastructure/TrackingContractTests.cs`
  hardcodes status literals in its contract-test fixtures and assertions. `TrackingDto.Status`
  (`services/orders/src/Orders.Application/Tracking/TrackingDto.cs`) is a plain `string`, not an
  enum, so Orders has no compile-time protection — a rename breaks this test at test time, in a
  different service and language from the one that owns the enum.
- **E2E:** `e2e/support/mailpit-client.ts`
- Plus the Go test files that assert on status values under `internal/domain` and `internal/app`
  (the retired Python suite covered the same surface as `test_test_mode_progression.py`,
  `test_rest_carrier_status.py`, `test_repository.py`, `test_status_state_machine.py`,
  `test_rest_init_tracking.py`, `test_sqs_event_publisher.py`, `test_status_changed_emission.py`,
  `test_rest_reads.py`, `test_log_identity.py`, `test_rest_e2e_cleanup.py`)

> [!note] How the Orders gap was found
> A repo-wide grep during a benchmark run, after this checklist was first written, turned up the
> Orders coupling. `TrackingDto.cs`'s own docstring already documented "Mirrors `TrackingResponse`
> in `services/tracking/src/features/tracking/api/schemas.py` [retired]. Change them together." —
> the coupling was recorded at the source, just not aggregated here. The Go equivalent is the
> response DTO in `internal/adapter/http`.

> [!danger] The silent failure — `catalog.ts` maps status to email template, with no compiler and no test to catch a miss
> `functions/events-pipeline/src/email/catalog.ts` maps each status value to the email template
> rendered for it. Rename a status in Tracking without updating this map and the mapping simply
> stops matching — there is no compile error (TypeScript sees a string, not the Tracking enum) and
> no failing Tracking test (Tracking's own suite has no visibility into events-pipeline). Users
> stop receiving the right delivery notification, and the break surfaces only as production
> behavior — an email that never arrives, or arrives with the wrong content — not as a red build.
> This is the same class of gap [[events-pipeline-design]] documents for the envelope contract
> generally: a string crossing a service boundary over SQS carries none of the guarantees a
> shared type would.

The status values also **persist in the database as strings** (`Tracking.status`,
`Tracking_History.status` — see [Data Model](#tracking)). A rename is therefore not just a code
change: existing rows still hold the old string, so renaming implies a data-migration question for
every already-persisted tracking, not only for code going forward.

## Cross-cutting rules

| Rule            | Convention               |
|-----------------|--------------------------|
| Soft delete     | [[soft-delete]]          |
| ID generation   | [[nano-id]]              |
| Audit columns   | [[audit-fields]]         |
| Column naming   | [[db-naming]]            |
| API versioning  | [[versioning]]           |
| gRPC transport  | [[ADR-0003-grpc-inter-service]] |
| DB replicas     | [[ADR-0006-read-write-replicas]] |
| Endpoint test coverage | [[testing]]       |
| Secrets (carrier API key, gRPC `x-api-key`) | [[ADR-0007-secrets-parameter-store]] |
| Gateway routing (existing module, per-route local integrations) | [[local-gateway-per-route-integrations]] |
| Event publishing (SQS, generated queue URL) | [[env-files]], [[events-pipeline-design]] |
| `x-user-id` injection (local) | [[nginx-njs-x-user-id-injection]] |
| Structured logging context, incl. `request_id` | [[logging-context]] |
| Distributed tracing backend | [[ADR-0019-distributed-tracing-opentelemetry]] |
| Response caching (`X-Cache` header contract, `CACHE_ENABLED` kill switch) | [[2026-08-25-response-caching-layer-design]], [[x-cache-response-header]] |

## Observability — workflow spans

> [!info] Go cutover — instrumentation moved into code; behaviour and flow names unchanged
> The Go service instruments the same four flows — `init_tracking`, `carrier_status_update`,
> `test_mode_progression`, `internal_delete_by_user` — but the mechanism differs, and the
> difference is deliberate, not a gap: the retired Python service auto-instrumented via
> `opentelemetry-instrument` wrapping uvicorn (no code, all `OTEL_*` env vars); Go has no
> equivalent auto-instrumentation agent, so wiring necessarily moves into code (`otelgin` for
> inbound HTTP, `otelsql` for the database, `otelgrpc` for the outbound Users client, the SQS
> producer instrumented by hand). What still comes from the environment, in both languages, is
> the endpoint/protocol/exporter selection — see
> [[2026-08-27-tracking-go-migration-design#Observability and event parity]] for the full
> scoping argument, and [[ADR-0019-distributed-tracing-opentelemetry]] for the backend decision
> this does not violate.
>
> The paragraphs below describe the **retired Python implementation** (`workflow_span`, the
> ASGI double-span bug, `mark_phase`) as historical record — the bugs and fixes are real and
> worth keeping, but the file paths and library names are Python-specific and gone from the
> running service. The equivalent Go wiring lives in `internal/adapter/otel/` (`provider.go`,
> `workflow.go`, `loghandler.go`).
>
> **The Go database instrumentation (`otelsql`) needed two of its own defaults overridden** —
> unrelated to the ASGI bug above, and specific to the Go driver stack: it records the literal
> SQL text on spans by default (a PII leak, since write paths carry `shipping_address`), and it
> records the `database/sql` sentinel `driver.ErrSkip` as an ERROR on spans and metrics by
> default, even though `go-sql-driver/mysql` returns it on essentially every ordinary
> parameterized query. Both are disabled in `cmd/server/main.go`'s `poolTracingOptions`. See
> [services/tracking-go/CLAUDE.md §11](../../../../services/tracking-go/CLAUDE.md) and
> [[2026-08-27-a-librarys-defaults-encode-assumptions-about-a-generic-service]] for the full
> write-up and the generalised lesson.

**Four** Tracking flows carried a full `app_event` triad — `init_tracking`,
`carrier_status_update`, `test_mode_progression`, and (added 2026-08-26)
`internal_delete_by_user` (see [Account-deletion cascade
(internal)](#account-deletion-cascade-internal) above) — wrapped in a manual `INTERNAL` span via
`workflow_span`, a
synchronous `@contextmanager` in `src/shared/observability/workflow_tracing.py` (Tracking's flows
ran inside sync command handlers or `asyncio.to_thread`-wrapped sync functions, so a sync context
manager matched every call site — no `@asynccontextmanager` needed). Same shape as Users'
`withWorkflowSpan` and Orders' `IWorkflowTracer`: `OK` on success, `ERROR` + the same `reason` the
log line carries on failure, closed on Python's own `with`-block `finally`. `test_mode_progression`
spanned the **whole** ~40-second, four-transition run as one span — the workflow's natural unit, the
same granularity its log already uses (one `_started`, one `_succeeded`/`_failed` for the whole
run), not one span per tick. The Go port keeps this granularity.

Tracking also gained `opentelemetry-instrumentation-boto3sqs`, scoped deliberately to the one
boto3 client it covered — `sqs_event_publisher.py`'s SQS client, which produced a CLIENT span
on publish and injected a `traceparent` `MessageAttribute` for events-pipeline's consumer to link
back to. It did **not** cover Tracking's separate CloudWatch client
(`shared/metrics/cloudwatch_metrics.py`) — `PutMetricData` calls stayed unspanned, a deliberate
scope limit, not a gap; the Go service preserves the same scope limit by hand. Full design and
implementation: [[2026-08-18-distributed-tracing-spans-design]] / [[2026-08-18-distributed-tracing-spans]].

> [!important] Amendment (2026-08-21) — historical (Python implementation, retired). This ASGI-specific bug has no Go equivalent; `otelgin` does not double-span.
> **ASGI double-span, dropped in the collector.** `opentelemetry-instrumentation-asgi` opens a
> span per ASGI transport message, and a normal HTTP response is two messages
> (`http.response.start`, `http.response.body`) — so every Tracking endpoint drew a `<route>
> http send` span **twice**, and a waterfall read as a duplicated request. Measured on
> init-tracking: 27µs and 6µs — real spans, real durations, just not a real second request. The
> fix is a `filter/drop_asgi_transport_spans` processor in the collector's traces pipeline
> (`observability/otel-collector-config.yaml`), scoped by the two literal name suffixes rather
> than by service, so it drops the same noise from any future ASGI service.
>
> **Why filtered in the collector, not at the source.** The library exposes `exclude_spans` only
> as a Python **kwarg** to `instrument_app()` — no `OTEL_*` environment variable exists for it in
> the installed `0.65b0`. Using it would mean calling `instrument_app()` explicitly in
> `src/main.py`, which does two things this repo's OTel convention forbids: it puts OTel
> configuration in the source tree instead of the environment (see
> [[logging-context#OTel configuration belongs in the environment, not in code]]), and it
> instruments **after** import — silently producing **no spans at all**, the same failure shape
> that convention exists to prevent.
>
> **`init_tracking` gained lifecycle milestones.** A new `mark_phase` helper in
> `src/shared/observability/workflow_tracing.py` records named EVENTs on the active workflow
> span, mirroring the events-pipeline's `markPhase` (`process-record.ts`) by name and shape so a
> reader moving between the two services meets one vocabulary. `init_tracking` now marks
> `resolution_started` → `tracking_created` → `init_tracking_completed` on the happy path, and
> `resolution_failed` / `creation_conflicted` on its two error branches
> (`init_tracking_router.py`). Emitted **around** the `asyncio.to_thread` boundary, never inside
> it: `asyncio.to_thread` **copies** the context, so an event added inside the thread attaches to
> the copy and is silently discarded — the same trap [[2026-07-31-contextvars-lost-across-task-boundaries]]
> already documents for merging log context across that same boundary.
>
> Full write-up of the ASGI trap: [[2026-08-21-asgi-instrumentation-double-spans-every-response]].

Neither fix was part of the original [[2026-08-18-distributed-tracing-spans-design]] scope
(Decision 3 covers only which flows get a workflow span, not the ASGI transport or phase
milestones within one) — both landed later in the same milestone; see that spec's own
2026-08-21 correction note and [[ADR-0019-distributed-tracing-opentelemetry]]'s amendment log.

## Deltas from the original design (superseded)

This service was first designed and **built** around gRPC, and shipped that way. Someone reading
git history will find a `proto/tracking.proto`, a gRPC server, an inbound `x-api-key` interceptor,
and generated stubs, all removed later. They were not a false start — they worked and were tested.
This section records why they are gone.

**Creation was `CreateTracking`, a gRPC RPC** ([JE-90](https://linear.app/je-martinez/issue/JE-90)).
Orders called it when confirming an order, passing `user_id` and `cognito_sub` explicitly in the
request. It is now `POST /v1/trackings/init-tracking`.

**Reads were exposed twice**: over gRPC, unscoped, for inter-service callers
([JE-91](https://linear.app/je-martinez/issue/JE-91)), and over REST, user-scoped, for end users.
The gRPC pair is gone; the REST reads already served every consumer.

**Why it changed.** A whole gRPC server — contract, codegen, an authentication interceptor, and a
second transport to keep working — existed to carry two operations that HTTP already carried. The
service was paying the cost of being a gRPC server without the traffic or the cross-language
pressure that justifies one. gRPC remains where it earns its place: as an **outbound client**, for
identity resolution against Users, which is genuinely inter-service and which Orders already does
the same way. See [gRPC — outbound client to Users](#grpc--outbound-client-to-users).

**What this removed along the way**, worth knowing because each was load-bearing at the time:

- The inbound `x-api-key` trust domain. Tracking no longer authenticates any inbound service
  caller; the key it holds now points outward, at Users. Two key-based schemes still exist and are
  still deliberately distinct — see [Auth schemes](#auth-schemes).
- A sync→async bridge. `CreateTracking` ran on a gRPC thread pool with no event loop, so scheduling
  TestMode required registering uvicorn's loop and submitting through `run_coroutine_threadsafe`.
  Creation is now an ordinary async handler, so the progression is scheduled directly and that
  machinery is unnecessary.
- `cognito_sub` as a wire field. Orders used to send it; the gateway now supplies it as `x-user-id`
  on the request itself. It remains a **column**, and remains the ownership key every user-scoped
  read filters by — see [Ownership & scoping](#ownership--scoping). Only its transport changed.

## Related

- [[2026-08-27-tracking-go-migration-design]] — design for the completed port of this service
  from Python/FastAPI to Go/Gin (faithful layer-by-layer port, coexisting `services/tracking-go/`
  during the migration, wave-based agent team, and the four-part closing gate — three of four
  criteria met — that this cutover was executed against). See
  [[ADR-0021-tracking-go-gin-sqlc-stack]] for the Go stack decisions (Gin, sqlc, golang-migrate,
  goenv).
- [[2026-08-27-go-vs-python-performance]] — the measured performance comparison satisfying the
  migration's closing-gate criterion 3 (partially): Go wins all four measurable resource/startup
  dimensions, latency/throughput under load unmeasurable on this stack (Floci-bound, not
  code-bound).
- [[2026-08-27-a-component-can-be-fully-unit-tested-and-still-never-run-in-production]] — the
  wiring-hazard lesson: five instances of correct, unit-tested Go code never reached from
  `main()`, why hexagonal architecture and `golangci-lint`'s `unused` both structurally miss it,
  and the call-graph reachability gate that now guards it.
- [[2026-08-27-a-producer-side-test-proves-nothing-about-what-the-consumer-accepts]] — the
  wire-contract lesson: a `shipping_address` emitted as a JSON string against a consumer schema
  requiring an object, silently dropped with no retry, and why the fix has to parse the
  consumer's actual Zod schema rather than a redescription of it.
- [[2026-08-27-a-librarys-defaults-encode-assumptions-about-a-generic-service]] — `otelsql`'s
  `db.query.text` (PII leak) and `driver.ErrSkip` (false error on every ordinary query) defaults,
  both wrong for this service and both overridden in `poolTracingOptions`; see the Observability
  section above and `services/tracking-go/CLAUDE.md` §11.
- [[2026-08-25-account-deletion-design]] — full design for the internal
  `DELETE /v1/trackings/by-user` cascade: the route-ordering trap, `soft_delete_by_user`, the
  `cognito_sub OR user_id` predicate, and the four-layer empty-identity guards.
- [[2026-08-15-request-id-correlation-design]] — the cross-service `request_id` correlation
  field: Tracking seeds it in `LogContextMiddleware`, propagates via gRPC metadata to Users and
  as a root field on `TRACKING_STATUS_CHANGED`, and must list it in `_ALLOWED_KEYS`.
- [[ADR-0019-distributed-tracing-opentelemetry]]
- [[2026-07-31-contextvars-lost-across-task-boundaries]] — the same `asyncio.to_thread`-copies-context
  trap `mark_phase` placement above avoids, first documented for `LogContextMiddleware`.
- [[2026-08-21-asgi-instrumentation-double-spans-every-response]] — the ASGI transport
  double-span lesson: why it looked like a bug, why the fix lives in the collector, and how to
  recognize the same trap in other transport-level instrumentation.
- [[2026-08-18-distributed-tracing-spans-design]] — the `workflow_span` context manager, the 3
  Tracking flow spans, and the boto3sqs instrumentation this note's Observability section
  documents.
- [[2026-08-18-distributed-tracing-spans]] — implementation plan.
- [[soft-delete]]
- [[nano-id]]
- [[audit-fields]]
- [[db-naming]]
- [[versioning]]
- [[ADR-0003-grpc-inter-service]]
- [[ADR-0006-read-write-replicas]]
- [[orders-service-design]] — `POST /v1/orders` is where `test_mode` originates (`x-test-mode`
  header, guarded by `E2E_TESTING_ENABLED`) before Orders propagates it to `init-tracking`; also
  where the `shipping_address` forwarded in that request is resolved and persisted;
  also the source of the `404`-not-`403` ownership pattern the REST reads reuse (see
  [Ownership & scoping](#ownership--scoping)) and the `x-user-id` gateway-injection mechanism both
  services rely on.
- [[users-service-design]] — the origin of the delivery address, resolved by Orders via
  `GetUserById` before it reaches Tracking.
- [[logging-context]] — the address must never be logged, the same way plaintext email never is.
- [[testing]] — the three-layer test convention (unit/integration, internal E2E, gateway E2E with a
  real Cognito JWT) that the REST read endpoints exist to satisfy for Tracking's reads.
- [[ADR-0007-secrets-parameter-store]] — both the carrier's PUT-endpoint API key and the internal
  gRPC `x-api-key` should be rotatable secrets in Parameter Store, not hardcoded values; see
  [Auth schemes](#auth-schemes).
- [[local-gateway-per-route-integrations]] — Tracking's routes are added to the existing API
  Gateway module's `local.routes` map, and locally get per-route `HTTP_PROXY` integrations the same
  way Orders' routes did; see [Gateway routing](#gateway-routing-existing-module-not-a-new-one).
- [[nginx-njs-x-user-id-injection]] — where the `x-user-id` header on Tracking's two
  Cognito-authenticated REST reads comes from locally; explicitly absent on the PUT endpoint.
- [[grpc-api-key-authorization]] — the shared `x-api-key` scheme Tracking's outbound
  `GetUserById` call presents to Users, the same mechanism Orders already uses.
- [[user-id-vs-cognito-sub-ownership-key]] — the ADR formalizing why user-scoped reads filter
  by `cognito_sub`, never `user_id`, and the incident that motivated it.
- [[two-api-keys-two-trust-domains]] — the ADR formalizing why `GRPC_API_KEY` and
  `TRACKING_CARRIER_API_KEY` must never collapse into one secret.
- [[testmode-in-process-no-durable-scheduler]] — the ADR formalizing the in-process scheduling
  choice for TestMode (a goroutine, not a durable scheduler) and its accepted
  restart-loses-progress limitation.
- [[events-pipeline-design]] — the consuming side of `TRACKING_STATUS_CHANGED`: the shared SQS
  queue, the dispatch map, the error taxonomy, and the `tracking-status-changed` email template
  family (one event type, five rendered variants).
- [[env-files]] — `EVENTS_QUEUE_URL` is generated into `.env.local.tracking`, never hardcoded.
- [[2026-08-03-events-pipeline-milestone-design]] — the full design for Tracking joining as a
  third producer, including the `event_id` derivation and the `user_id`-from-persisted-row trap.
- [[2026-08-05-realtime-tracking-events-websocket-design]] — the design that added
  `author.cognito_sub` to this publisher's envelope, and the DynamoDB GSI it exists to serve.
- [[2026-08-05-realtime-tracking-events-websocket]] — the implementation plan that shipped it.
- [[2026-08-12-custom-business-metrics-cloudwatch-design]] — the design for
  `orders_by_tracking_status_total`, the DELIVERED/IN_PROGRESS split, and the `main.py` lifespan
  it added.
- [[2026-08-25-response-caching-layer-design]] — the full cross-service response-caching
  design: the two cached reads and their TTL, the normalized-then-hashed list key, the
  identity-mapping cache, and the fail-open 50ms budget. See
  [Response caching](#response-caching) above.
- [[x-cache-response-header]] — the `X-Cache`/`X-Cache-TTL` response-header contract Tracking's
  `_serve_cached`/`_store_cached` helpers implement.
- [[2026-08-26-cache-keys-built-from-a-raw-identity-header]] — the data leak this service's
  account-deletion cascade (`invalidate_user`) exists to close: a response key built from the
  raw `x-user-id` header, not the canonical identity pair the cascade receives.
