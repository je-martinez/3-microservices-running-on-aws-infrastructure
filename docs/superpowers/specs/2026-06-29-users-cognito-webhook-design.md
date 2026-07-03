---
title: Users Cognito Identity Webhook + Identity Tables — Design
type: spec
area: users
status: active
created: 2026-06-29
updated: 2026-07-02
tags:
  - type/spec
  - area/users
  - status/active
  - issue/JE-38
  - issue/JE-37
related:
  - "[[2026-06-28-users-service-design]]"
  - "[[floci-vs-ministack-spike-findings]]"
  - "[[ADR-0017-floci-local]]"
  - "[[ADR-0010-cognito-auth]]"
  - "[[nano-id]]"
  - "[[audit-fields]]"
  - "[[soft-delete]]"
  - "[[db-naming]]"
  - "[[cqrs]]"
---

# Users Cognito Identity Webhook + Identity Tables — Design

## Context

AWS Cognito Lambda triggers (PostConfirmation, etc.) are **stored but never invoked** by the local emulators (Ministack and Floci) — confirmed in the Floci spike (see [[floci-vs-ministack-spike-findings]] and [[ADR-0017-floci-local]]). This means the PostConfirmation trigger cannot fire locally to capture user identity data.

We need to persist the Cognito identity data (`sub`, email, attributes, raw payload) into the Users service, linked to the internal `usr_…` user ID.

### Superseded idea

An earlier idea routed Cognito capture through SQS → events-pipeline → DocumentDB. That approach is **superseded by this design**. The decision: **Users owns this end-to-end via a webhook**. No SQS or events-pipeline involvement for this flow. The existing `USER_CREATED` → SQS event may remain for other consumers but is not the Cognito capture path.

---

## DECIDED — Architecture

### Core principle

One endpoint, one persistence handler — identical in local and prod. Only the **trigger** differs by environment.

- New endpoint `POST /v1/webhooks/cognito` on the Users service (Fastify).
- **PROD:** Cognito fires a PostConfirmation Lambda shim → shim POSTs the Cognito event to `/v1/webhooks/cognito`.
- **LOCAL:** The register/confirm flow already calls Cognito SDK. It reads the `sub` from the Cognito SDK response and POSTs to its own `/v1/webhooks/cognito` (env-gated via a flag such as `LOCAL_COGNITO_WEBHOOK=true`). The same handler and persistence execute in both environments.

### Flow diagrams

**PROD flow**

```
User → POST /v1/users/register
     → Cognito (creates user, returns sub)
     → Cognito fires PostConfirmation trigger
          → Lambda shim receives Cognito event
          → Lambda shim POSTs to /v1/webhooks/cognito
               → Users service: persist to users_cognito_data + users_cognito_events
```

**LOCAL flow**

```
User → POST /v1/users/register
     → Cognito SDK (local Floci / Ministack — trigger does NOT fire)
     → SDK response contains sub
     → Users service register handler (env-gated, LOCAL_COGNITO_WEBHOOK=true)
          → self-POST to /v1/webhooks/cognito
               → Users service: persist to users_cognito_data + users_cognito_events
```

Both environments converge at the same `/v1/webhooks/cognito` handler and run the same database writes.

---

## DECIDED — Data Model

Two new Postgres tables, **owned by the Users service**. Migrations live in `services/users/prisma`. Foreign key to `users.id` is native — same database.

All tables follow standard conventions: [[nano-id]] prefixes, [[audit-fields]] (full set), [[soft-delete]], [[db-naming]] (snake_case DB ↔ PascalCase app), all datetimes as `timestamptz`. Audit fields replace any dedicated `synced_at` / `received_at` columns — no redundant timestamps.

### Table: `users_cognito_data` — 1:1 snapshot

Current Cognito state per user. Upserted on each event received.

| Column | Type | Notes |
|---|---|---|
| id | varchar | [[nano-id]] prefix `ucd_…` |
| user_id | varchar | FK → `users.id` (`usr_…`); `UNIQUE` — enforces 1:1 |
| cognito_sub | varchar | `UNIQUE`; the Cognito `sub` — the bridge between our internal ID and Cognito |
| email | varchar | Latest email from Cognito |
| client_id | varchar | Cognito app client ID |
| last_event_type | varchar | e.g. `PostConfirmation_ConfirmSignUp` |
| raw_payload | jsonb | Latest full Cognito payload |
| (audit fields) | — | `created_by/at`, `updated_by/at` (`updated_at` = last sync), `deleted_by/at`; `isDeleted` derived — see [[audit-fields]] |

### Table: `users_cognito_events` — 1:N event log

Append-only history of every Cognito event received.

| Column | Type | Notes |
|---|---|---|
| id | varchar | [[nano-id]] prefix `cge_…` |
| cognito_sub | varchar | Indexed, join natural — **NOT a hard FK** (events can precede their data row when the internal user is not yet linked; see idempotency/error-handling below) |
| event_type | varchar | `triggerSource` / event type string |
| message_id | varchar | `UNIQUE` — idempotency key; duplicate POST = no-op |
| raw_payload | jsonb | Full Cognito payload for this specific event |
| (audit fields) | — | `created_at` = time received; see [[audit-fields]] |

### Relationship chain

```
users ──(user_id, hard FK)──► users_cognito_data ──(cognito_sub, indexed — no hard FK)──► users_cognito_events
```

Join key events ↔ data is the **natural key** `cognito_sub`, indexed on both tables but **not FK-constrained** between them — `users_cognito_events` rows may exist before their matching `users_cognito_data` row (see the 202 case below). The only hard FK is `users_cognito_data.user_id → users.id`.

---

## DECIDED — Ownership

The **Users service** owns all of this:

- Tables in the Users Postgres database.
- Prisma migrations in `services/users/prisma/`.
- Webhook handler in the Users Fastify application.
- FK to `users.id` is a native Postgres FK (same DB — no cross-service join).

This is consistent with the Users service design ([[2026-06-28-users-service-design]]) and the Cognito auth decision ([[ADR-0010-cognito-auth]]).

---

## DECIDED — Scope Boundary

[JE-38](https://linear.app/je-martinez/issue/JE-38) (area/users, implemented by `users-impl`) delivers:

- The `POST /v1/webhooks/cognito` endpoint (handler + persistence).
- Both new Postgres tables (Prisma migration in `services/users/prisma/`).
- The `cognito_sub ↔ usr_…` link, established by the register handler.
- The env-gated self-POST in the local register flow.
- Webhook auth (shared secret in a header).
- Unit tests (Vitest).

Out of scope for JE-38:

- The **prod PostConfirmation Lambda shim** is a separate `area/infra` issue (implemented by `infra-impl`). The shim only forwards the raw Cognito event without transforming it.
- The **E2E suite rework** stays in [JE-37](https://linear.app/je-martinez/issue/JE-37), which becomes **blocked by JE-38**.

## DECIDED — Webhook Payload Contract

The body of `POST /v1/webhooks/cognito` is the **raw Cognito PostConfirmation event** (not a custom DTO). A Zod schema validates only the fields we consume and preserves the rest in `raw_payload`.

Event → column mapping:

| Event field | Column |
|---|---|
| `triggerSource` (string) | `event_type` (events) / `last_event_type` (data) |
| `request.userAttributes.sub` | `cognito_sub` |
| `request.userAttributes.email` | `email` |
| `callerContext.clientId` | `client_id` |
| full event object | `raw_payload` |

Missing required fields → HTTP 422. Extra fields → ignored but preserved in `raw_payload`. This keeps the prod shim a pure forwarder, with a single extraction point living in the handler.

## DECIDED — Webhook Security / Auth

A shared secret in the `X-Webhook-Secret` header, validated by a **Fastify preHandler** against a secret from env/config (Zod). **Identical in local and prod**, consistent with the "one handler, only the trigger changes" principle. Missing/mismatched secret → HTTP 401.

Not HMAC (YAGNI over a private network) and not network-only (the handler must have its own defense).

## DECIDED — Idempotency / message_id

The PostConfirmation event has **no native messageId**. We derive `message_id = sha256` of a canonical serialization (sorted keys) of the raw event. Exact retries → same hash → no-op. This doesn't depend on Cognito populating any particular field, so it's robust in both Floci and prod.

## DECIDED — cognito_sub ↔ users.id Link + Error Handling

The **register handler** (which creates `usr_…` and knows the `sub` from the SDK) owns establishing the `cognito_sub ↔ usr_…` link. The webhook performs an **idempotent upsert by `cognito_sub`**.

If a webhook arrives for a `sub` with **no internal user yet** (the async case in prod): the raw event is **always inserted into `users_cognito_events`** (never lost) and the response is **HTTP 202**; `users_cognito_data` is left without a row (deferred).

**Data-model implication:** because events can arrive before their `users_cognito_data` row, `users_cognito_events.cognito_sub` is **not a hard FK** — it's an **indexed** column for the natural join, with no constraint. The only hard FK is `users_cognito_data.user_id → users.id`. Reflected above in [[#DECIDED — Data Model]].

## DECIDED — Upsert Semantics for users_cognito_data

**Last-write-wins.** Insert if no row exists for the `cognito_sub`; on update, `email`, `client_id`, `last_event_type`, and `raw_payload` are overwritten with the latest event. `user_id` and `cognito_sub` are immutable. `updated_at`/`updated_by` (audit fields) reflect the last sync — no redundant `synced_at` column. Full history is preserved in `users_cognito_events` (append-only).

## DECIDED — Handler Logic (Transactional)

1. `message_id = sha256(canonicalJSON(event))`.
2. Insert into `users_cognito_events` with `ON CONFLICT (message_id) DO NOTHING` (idempotent).
3. Resolve `cognito_sub → user_id`: if the link exists → upsert `users_cognito_data` last-write-wins → HTTP 200. If it doesn't exist → event already recorded, snapshot untouched → HTTP 202.

### Response matrix

| Situation | Code | Effect |
|---|---|---|
| Valid event, known user | 200 | Event inserted + snapshot upserted |
| Valid event, unknown sub | 202 | Event inserted, snapshot deferred |
| Duplicate (`message_id` already seen) | 200 | No-op |
| Invalid/missing secret | 401 | Nothing |
| Invalid payload (missing sub/fields) | 422 | Nothing |

## DECIDED — Env / Config (Zod)

| Variable | Type | Notes |
|---|---|---|
| `LOCAL_COGNITO_WEBHOOK` | boolean, default `false` | Enables the register's self-POST locally |
| `COGNITO_WEBHOOK_SECRET` | string | The `X-Webhook-Secret` header secret |
| `COGNITO_WEBHOOK_URL` | string (or derived from the service's own base URL) | Destination of the local self-POST |

Env-gating: after obtaining the `sub` from the SDK, the register handler self-POSTs with the secret header if `LOCAL_COGNITO_WEBHOOK=true`. In prod the flag is `false` (the shim posts instead). Same handler, different trigger.

## DECIDED — Testing Strategy

Unit tests (Vitest, within JE-38):

- Zod validation (valid payload passes; missing sub/fields → 422).
- Auth (missing/invalid secret → 401).
- `message_id` canonical hash is deterministic (same event → same key; different event → different key).
- Idempotency (second POST of the same event → no-op, one row in events).
- Upsert (first event inserts snapshot; second event with same sub and different email → rolls forward last-write-wins).
- 202 case (unknown sub → event inserted, snapshot absent, 202).

Out of scope for JE-38: E2E suite rework ([JE-37](https://linear.app/je-martinez/issue/JE-37), blocked by JE-38).

## Future Work (Out of Scope)

- **202-case reconciliation** (unknown sub): materialize `users_cognito_data` from orphaned events once the user is created later. Out of scope for JE-38 (YAGNI) — on the local path the 202 case almost never happens because the register creates `usr_…` before the self-POST. Will be designed once the async prod shim exists.
- **Prod PostConfirmation Lambda shim** (separate `area/infra` issue).

---

## Next Step

Design is finalized. Next step: invoke `writing-plans` to produce the JE-38 implementation plan.

| Item | Value |
|---|---|
| Branch | `feat/JE-38-cognito-webhook` |
| Base branch | `feature/users-service` |
| Linear issue | [JE-38](https://linear.app/je-martinez/issue/JE-38) — Backlog |
| Next step | Invoke `writing-plans` to produce the implementation plan |

---

## Related

- [[2026-06-28-users-service-design]]
- [[floci-vs-ministack-spike-findings]]
- [[ADR-0017-floci-local]]
- [[ADR-0010-cognito-auth]]
- [[nano-id]]
- [[audit-fields]]
- [[soft-delete]]
- [[db-naming]]
- [[cqrs]]
