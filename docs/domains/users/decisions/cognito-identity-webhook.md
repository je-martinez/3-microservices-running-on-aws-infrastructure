---
title: Cognito identity webhook — shared capture use case, two entry paths
type: adr
area: users
status: accepted
id: users-cognito-identity-webhook
deciders: ["Jose E. Martinez"]
supersedes: null
superseded-by: null
created: 2026-07-28
updated: 2026-07-28
tags: [type/adr, area/users, status/accepted, issue/JE-38]
related:
  - "[[users-service-design]]"
  - "[[ADR-0010-cognito-auth]]"
  - "[[ADR-0017-floci-local]]"
  - "[[ADR-0007-secrets-parameter-store]]"
  - "[[soft-delete]]"
  - "[[audit-fields]]"
  - "[[2026-07-09-users-cognito-webhook-design]]"
  - "[[2026-07-09-users-cognito-webhook]]"
---

# Cognito identity webhook — shared capture use case, two entry paths

## Context

Cognito Lambda triggers (PostConfirmation, etc.) are **never invoked by Floci**,
confirmed empirically (see [[ADR-0017-floci-local]]). Identity capture therefore cannot
depend on a PostConfirmation Lambda when running locally, but production needs one. The
design had to give both environments the same persistence guarantees without duplicating
the write logic.

## Decision

- **One shared use case, reached two ways.** `CaptureCognitoIdentityCommand` is the
  single persistence path. In prod, a Lambda shim (separate infra issue, out of scope
  here) turns a real Cognito PostConfirmation trigger into an HTTP `POST
  /v1/webhooks/cognito`. Locally, `register()` invokes the same command class
  **in-process** through Awilix (no HTTP hop) whenever `NODE_ENV !== "production"`.
- **Security: shared secret in a header**, `x-webhook-secret`, compared with a
  timing-safe comparison against `env.WEBHOOK_SECRET` — required in **every**
  environment (fail-fast; prod sources it from Secrets Manager, see
  [[ADR-0007-secrets-parameter-store]]). Rejected: HMAC body signing and IAM/SigV4
  (Floci doesn't validate SigV4, which would make the local path untestable).
- **Best-effort, non-blocking.** If the in-process capture fails, `register` logs the
  error and still returns 201 — identity capture is a secondary snapshot, not a
  registration precondition.
- **Idempotency key is derived, not transmitted**: `message_id =
  sha256(length-prefixed(sub, triggerSource))`. The Cognito event carries no timestamp or
  per-delivery unique field, so a retry hashes identically and is caught by the unique
  index on `message_id`. Length-prefixing (not a naive `:` join) keeps the encoding
  injective regardless of caller input.
- **Persistence is one nested Prisma write**: `usersCognitoData.upsert` with the event
  nested via `events: { create: [...] } }` in both the `create` and `update` branches —
  Prisma's nested-write transactional guarantee means the parent snapshot is always
  inserted before the child event, satisfying the `NOT NULL` FK by construction.
- **Scope limited to PostConfirmation** (`ConfirmSignUp`, `ConfirmForgotPassword`).
  Adding any *recurring* trigger (e.g. `PostAuthentication`) requires reworking the
  idempotency key first — at PostConfirmation-only scope it collapses to one row per
  (user, trigger type), which would silently store only the first occurrence of a
  recurring trigger.
- **Data model, additive only:** `users.cognito_sub` (nullable, unique) is stamped from
  the same `signUp.sub` value `register()` already has, denormalized alongside the
  existing `users` → `users_cognito_data` → `users_cognito_events` chain — it does not
  replace or alter that chain.
- **A confirmed identity with no matching `users` row is a 500**, not a 404/409 — the
  caller here is never an end user with a resource identifier, and Cognito retries the
  trigger in prod, so a transient race self-heals.

## Consequences

- Local dev exercises the real persistence path but **not** the shared-secret check or
  Zod validation on the happy path — those layers are covered only by integration tests,
  a deliberate, accepted trade-off of avoiding a self-POST.
- The production Lambda shim (deferred) **must** derive `message_id` with the identical
  length-prefixed encoding, or prod and local silently derive different keys for the same
  event and idempotency breaks across environments.
- Establishes the pattern (thin route → shared command, invoked two ways) for any future
  webhook-style integration this service needs.

## Related

- [[users-service-design]]
- [[ADR-0010-cognito-auth]]
- [[ADR-0017-floci-local]]
- [[ADR-0007-secrets-parameter-store]]
- [[soft-delete]]
- [[audit-fields]]
- [[2026-07-09-users-cognito-webhook-design]]
- [[2026-07-09-users-cognito-webhook]]
