# CLAUDE.md — Tracking service

Nested project memory for the **Tracking** microservice. Source of truth for
this service's stack and conventions. The global `tracking-impl` agent reads
this first, every time. Cross-cutting rules are **referenced**, never duplicated.

## 1. Stack & versions
- Framework: FastAPI (Python 3.12+).
- Database: Aurora MySQL (read + write replicas).
- ORM: SQLAlchemy (migrations via Alembic).
- Env validation: Pydantic settings (parity with the Zod convention).

## 2. Commands
- Install: `pip install -r requirements.txt`
- Run/build: `uvicorn src.main:app`
- Test: `pytest`
- Lint: `ruff check .`
- Run local (docker-watch): `docker compose up tracking --watch` (from repo root)
- Migrate: `alembic upgrade head`

> These commands are the intended contract; the project files themselves are
> created in the Tracking implementation milestone.

## 3. Folder structure (screaming architecture)
```
services/tracking/
├── src/features/tracking/{commands,queries,domain,grpc}/
├── src/shared/{config,db,di,audit}/
└── tests/
```

## 4. Conventions (referenced, never duplicated)
- Screaming architecture + DI: [../../docs/shared/patterns/screaming-architecture.md](../../docs/shared/patterns/screaming-architecture.md), [../../docs/shared/patterns/dependency-injection.md](../../docs/shared/patterns/dependency-injection.md)
- CQRS: [../../docs/shared/patterns/cqrs.md](../../docs/shared/patterns/cqrs.md)
- Soft delete only: [../../docs/shared/conventions/soft-delete.md](../../docs/shared/conventions/soft-delete.md)
- Prefixed nano IDs: [../../docs/shared/conventions/nano-id.md](../../docs/shared/conventions/nano-id.md)
- Audit fields: [../../docs/shared/conventions/audit-fields.md](../../docs/shared/conventions/audit-fields.md)
- API versioning: [../../docs/shared/conventions/versioning.md](../../docs/shared/conventions/versioning.md)
- DB naming (snake_case ↔ PascalCase aliases): [../../docs/shared/conventions/db-naming.md](../../docs/shared/conventions/db-naming.md)

## 5. Agent rules
- Converse with the user in **Spanish**; write code and comments in **English**.
- `tracking-impl` writes **only source code** — never runs git or touches Linear.
- Leave finished work in the working tree for the **main session** to commit
  (`github-ops` is an optional helper for complex git batches — see [[git-workflow]]).
- Stay within the single task handed to you (YAGNI).

## 5a. Two identities per tracking — `user_id` vs `cognito_sub`

A tracking stores **both**, and they are not interchangeable:

- **`user_id`** — the internal `usr_` id. Tracking resolves it itself, from the sub,
  through its outbound gRPC client to Users (§6) while handling the request. Used for
  reporting and cross-service joins.
- **`cognito_sub`** — the Cognito `sub`, and **the ownership key every user-scoped
  REST read filters by**.

The gateway injects the caller's identity as the `x-user-id` header, but that header
carries the JWT's **`sub`** (`proxy_set_header x-user-id $jwt_sub` in
`infra/modules/compute/nginx/nginx.conf`) — never the `usr_` id. Scoping a read by
`user_id` therefore compares a sub against a `usr_` id, matches nothing, and answers
**404 for every caller including the rightful owner**, while looking correctly
implemented. This shipped once and was invisible to 253 tests because they created
and read with the same value.

Rules:
- User-scoped reads scope by `cognito_sub`. The gRPC reads stay **unscoped**.
- The HTTP dependency is `CallerSub` / `require_caller_sub` (`shared/http/identity.py`),
  named so a handler cannot read it as "the user id".
- `cognito_sub` is **optional on the wire** and nullable in the schema: a caller that
  predates the field still creates successfully. `""` is normalized to NULL, which
  matches nobody — a row is unreachable rather than mis-attributed.
- Any test asserting ownership must use **two different values** for the two
  identities, or it cannot fail on this bug.

Orders solves the identical problem the same way (`order` and `order_details` both
carry `user_id` + `cognito_sub`; reads filter by `cognito_sub`).

## 5b. TestMode progression — KNOWN LIMITATION, accepted

`CreateTracking(test_mode=true)` advances the tracking one status every 10s
(`SHIPPED → ON_THE_WAY → OUT_FOR_DELIVERY → DELIVERED`, 4 history rows) using an
**in-process `asyncio` task** — deliberately chosen over APScheduler/Celery/a
durable queue. Do not "fix" this by adding a persistent scheduler.

> **If the process restarts mid-progression — docker-watch rebuild, redeploy, crash
> — the pending task is LOST and the tracking stays frozen at whatever status it
> reached.** There is no recovery, no retry, and no error logged anywhere. A TestMode
> tracking stuck at `ON_THE_WAY` after a rebuild is **expected**, not a bug to
> investigate. Recover by creating a new TestMode tracking, or by driving the
> remaining transitions through `PUT /v1/trackings/{orderId}/status`.

This is acceptable because TestMode is a 30-second E2E fixture: nothing downstream
depends on it completing, and real carrier updates arrive through the (persistent)
PUT endpoint.

Implementation notes:
- **Scheduled from an async handler.** Creation is `POST /v1/trackings/init-tracking`,
  an ordinary async FastAPI route, so the progression is scheduled directly on the
  running loop — no thread-pool handoff. The `run_coroutine_threadsafe` bridge that
  used to be needed existed only because creation ran on the gRPC thread pool, which
  has no event loop; with the gRPC server gone, so is that constraint.
- Each transition reuses `update_tracking_status` — the same handler behind the
  carrier PUT — differing only in `AuditActor.TEST_MODE_PROGRESSION`. Never write a
  parallel transition path.
- Each transition opens its **own** write session; the creating request's is closed.
- A rejected transition (a carrier delivered it first) or a deleted tracking **ends
  the run cleanly** — never retried, never raised out of the background task.
- The interval is **injectable** (`progression_interval`); production default 10s,
  tests pass ~0 so the suite never sleeps for 30 seconds.

## 6. Design reference
- Service spec (vault, source of truth): [../../docs/domains/tracking/specs/tracking-service-design.md](../../docs/domains/tracking/specs/tracking-service-design.md)
- **Tracking is REST-only.** It serves no gRPC; the single gRPC in this service is an
  OUTBOUND client to Users (below).
- REST:
  - `[GET] /v1/health` — unauthenticated. Served unprefixed; the gateway publishes it as
    `/v1/tracking/health` and nginx rewrites.
  - `[POST] /v1/trackings/init-tracking` — creation. Body carries `order_id` and
    `shipping_address`; the caller's identity comes from the `x-user-id` header, never
    the body. Guarded for idempotency: an order that already has a tracking or any
    history is rejected with `409`, so a retry cannot duplicate a shipment. Accepts
    `test_mode`, driving the automatic progression in §5b.
  - `[GET] /v1/trackings/{orderId}` and `[GET] /v1/trackings?order_ids=<csv>` —
    user-scoped reads, filtered by `cognito_sub` (see §5a). Both return the tracking
    **together with its history**.
  - `[PUT] /v1/trackings/{orderId}/status` — carrier-simulation endpoint, authenticated
    by its own external API key rather than a Cognito JWT, so it receives no
    `x-user-id`. Guarded: terminal `DELIVERED` rejects any update, and backward or
    same-status transitions are rejected.
- gRPC (client only): `users.v1.Users/GetUserById`, to resolve the caller's `usr_` id
  from the Cognito sub — the same shape as Orders' `ICurrentCaller`. `NOT_FOUND` means
  the user does not exist; every other status propagates, so a Users outage is never
  mistaken for an unknown caller.
- Entities: Tracking, Tracking_History.
