---
title: Users Cognito Identity Webhook + Identity Tables — Design
type: spec
area: users
status: draft
created: 2026-06-29
updated: 2026-06-29
tags:
  - type/spec
  - area/users
  - status/draft
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

> [!warning] Draft — design in progress
> Decided sections are final; "Open questions / pending" lists what to finish next session before writing the implementation plan.

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
| cognito_sub | varchar | FK → `users_cognito_data.cognito_sub` (natural join key) |
| event_type | varchar | `triggerSource` / event type string |
| message_id | varchar | `UNIQUE` — idempotency key; duplicate POST = no-op |
| raw_payload | jsonb | Full Cognito payload for this specific event |
| (audit fields) | — | `created_at` = time received; see [[audit-fields]] |

### Relationship chain

```
users ──(user_id)──► users_cognito_data ──(cognito_sub)──► users_cognito_events
```

Join key events ↔ data is the **natural key** `cognito_sub`. The `sub` arrives in every Cognito message, so ingest is direct — no sub → internal-ID resolution step needed at write time.

---

## DECIDED — Ownership

The **Users service** owns all of this:

- Tables in the Users Postgres database.
- Prisma migrations in `services/users/prisma/`.
- Webhook handler in the Users Fastify application.
- FK to `users.id` is a native Postgres FK (same DB — no cross-service join).

This is consistent with the Users service design ([[2026-06-28-users-service-design]]) and the Cognito auth decision ([[ADR-0010-cognito-auth]]).

---

## Open Questions / Pending

Finish these before invoking `writing-plans` for the implementation plan.

- [ ] **Webhook payload contract:** define the exact Zod schema for the `POST /v1/webhooks/cognito` body. Which Cognito fields are required: `sub`, `email`, `clientId`, `triggerSource`, `userAttributes`, full raw event? Map Cognito event shape → table columns explicitly.
- [ ] **Webhook security / auth:** how is `POST /v1/webhooks/cognito` authenticated? Options: shared secret / HMAC header from the Lambda shim, network-only (VPC), or another mechanism. Must **not** be a public unauthenticated write. Decide local vs prod behaviour separately.
- [ ] **Error handling:** idempotency via `message_id` (duplicate POST → no-op); what happens if `user_id` / `sub` is not yet present in `users`; validation failures; retry strategy.
- [ ] **Upsert semantics for `users_cognito_data`:** insert vs update on repeat events; how `last_event_type` and `raw_payload` roll forward on successive events.
- [ ] **Testing strategy:** unit tests for the webhook handler; how the reworked JE-37 e2e suite exercises the webhook locally (the auto-POST code path).
- [ ] **Scope boundary — Lambda shim:** is the prod PostConfirmation Lambda shim part of this Users issue or a separate `area/infra` issue?
- [ ] **Env flag name:** confirm the exact name and gating logic for `LOCAL_COGNITO_WEBHOOK` (or whichever flag name we settle on).
- [ ] **Relationship to PR #42 / JE-37:** the reworked e2e flow should drive this design; confirm the dependency direction and whether JE-37 blocks or is blocked by this work.

---

## Session State — How to Resume

| Item | Value |
|---|---|
| Branch | To be created as `feat/JE-NN-cognito-webhook` (JE-NN = Linear issue being created this session) |
| Base branch | `feature/users-service` (at the merged Floci + Prisma migration work) |
| Linear issue | Being created via `linear-pm`: title `feat(users): Cognito identity webhook + identity tables`, milestone Users Service |
| Next step | Finish all open questions above, then invoke `writing-plans` to produce the implementation plan |

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
