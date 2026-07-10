---
title: "JE-38 — Cognito identity webhook + identity tables — Design"
type: spec
area: users
status: draft
created: 2026-07-09
updated: 2026-07-09
tags: [type/spec, area/users, status/draft, issue/JE-38]
related: ["[[users-service-milestone]]", "[[ADR-0010-cognito-auth]]", "[[ADR-0017-floci-local]]", "[[floci-vs-ministack-spike-findings]]", "[[soft-delete]]", "[[audit-fields]]", "[[nano-id]]", "[[db-naming]]", "[[versioning]]", "[[ADR-0007-secrets-parameter-store]]"]
---

# JE-38 — Cognito identity webhook + identity tables — Design

> [!info] Path note
> Linear issue [JE-38](https://linear.app/je-martinez/issue/JE-38) references this spec at
> `docs/superpowers/specs/2026-06-29-users-cognito-webhook-design` — that file was never written.
> This document is the actual design, created 2026-07-09 at the path above. If you followed the
> JE-38 link and landed here, this is the intended note.

## Problem

Cognito Lambda triggers (PostConfirmation, etc.) are **never invoked by the local emulator** —
confirmed empirically in the Floci spike (see [[ADR-0017-floci-local]] and
[[floci-vs-ministack-spike-findings]]). Identity capture therefore cannot depend on a
PostConfirmation Lambda when running locally on Floci.

The strategy adopted: **one Fastify HTTP handler**, `POST /v1/webhooks/cognito`, shared by local
and prod. Only the *trigger* that calls it differs — a Lambda shim in prod, a self-POST from
`register()` locally. The handler code path is identical either way, so it is exercised for real
in local/E2E testing rather than only in prod.

## Architecture

```
PROD:   Cognito --PostConfirmation--> Lambda shim --POST--> /v1/webhooks/cognito
                                      (separate issue)          |
LOCAL:  register() --auth.signUp()--> {sub} --self-POST-------->|
                                                                 v
                                          verify shared secret + Zod
                                                                 |
                                    +----------------------------+----------------------------+
                                    v                                                         v
                           users_cognito_data                                     users_cognito_events
                           (1:1 upsert by cognito_sub)                    (insert, ON CONFLICT DO NOTHING)
```

The prod-side Lambda shim (the box that turns a real Cognito PostConfirmation trigger into an
HTTP POST) is drawn above for context only — see [Out of scope](#in-scope--out-of-scope); it is
not part of this issue.

## Verified facts

These were confirmed against the AWS docs, the running code, and a live Floci stack; they are
recorded here as established, not re-derived.

1. **Real PostConfirmation event shape.** `version`, `triggerSource`, `region`, `userPoolId`,
   `userName`, `callerContext.{awsSdkVersion, clientId}`, `request.userAttributes.{sub, email,
   email_verified}`, `response`. Confirmed via `cognito-idp list-users` on the live Floci pool
   that `sub`, `email`, `email_verified` are the attributes actually present.
2. **The event carries no timestamp and no per-delivery unique field.** A Cognito retry sends a
   byte-identical payload. This is the single most consequential fact in this design — it drives
   the idempotency approach in [D4](#d4--idempotency-key-is-derived-not-transmitted).
3. `AuthProvider.signUp()` already returns `{ sub }`
   (`services/users/src/shared/auth/cognito-auth-provider.ts:36`), but `register.ts:31` currently
   discards it (`await this.auth.signUp(...)`). Capturing it is part of this work.
4. The service has exactly one Prisma model today (`User`), and `MODEL_ID_PREFIXES`
   (`shared/id/nano-id.ts`) contains only `User: "usr_"`.
5. A Prisma client extension stamps ids, audit fields, and enforces soft-delete
   ([[soft-delete]], [[audit-fields]], ADR-0004). New models get this for free.
6. The DB role `users_app` has `SELECT`/`INSERT`/`UPDATE` and **no `DELETE`**; new tables inherit
   that via `ALTER DEFAULT PRIVILEGES` in `infra/environments/local/bootstrap.sh`.
7. `infra/modules/api-gateway/main.tf` already separates **public routes** (`POST
   /v1/users/register`, `POST /v1/users/login`, `GET /v1/health`) from **protected routes** (JWT
   authorizer). The webhook is a public route protected by the shared secret, not by the JWT
   authorizer — its caller is a Lambda or the service itself, never a user with a JWT.
8. An `EventPublisher` seam already exists (`shared/messaging/event-publisher.ts`), currently
   `NoopEventPublisher`. It is **not** used by this design — the issue rules out SQS/events-pipeline
   for this flow. Noted here so it isn't mistaken for an oversight.

## Decisions

### D1 — Security: shared secret in a header

The caller sends `x-webhook-secret`; the service compares it to `env.WEBHOOK_SECRET` using a
**timing-safe comparison**.

Rejected: HMAC body signing (more code, and a body-canonicalization footgun) and IAM/SigV4 (Floci
does not validate SigV4, which would break the one-handler premise and make the local path
untestable). Trade-off accepted: a leaked secret allows replay; rotation is manual.

### D2 — Local trigger: self-POST over HTTP

`register()` captures the `sub` and POSTs to its own `/v1/webhooks/cognito`, env-gated. Chosen
over calling the use-case class in-process because it exercises the *real* HTTP handler locally —
the same code path prod runs. Trade-off: the service calls itself.

### D3 — Webhook failure is best-effort, non-blocking

If the self-POST fails (network, bad secret, DB down), `register` logs the error and still
returns `201`. Identity capture is a secondary snapshot, not a registration precondition; in prod
Cognito retries the trigger anyway.

Rejected: failing the registration, which would leave an orphaned Cognito user and couple two
writes that don't need to be coupled.

### D4 — Idempotency key is derived, not transmitted

`message_id = sha256(sub + ":" + triggerSource)`.

Because the event carries no timestamp (fact 2), this deliberately collapses to **one row per
`(user, trigger type)`**. A Cognito retry hashes identically and is swallowed by `ON CONFLICT DO
NOTHING` — which is exactly the duplicate this is meant to prevent.

Rejected: a caller-generated UUID (a retry creates a new id, so it protects nothing) and the
Lambda `awsRequestId` (same flaw, plus it doesn't exist locally).

### D5 — Scope limited to PostConfirmation

Accepted `triggerSource` values: `PostConfirmation_ConfirmSignUp` and
`PostConfirmation_ConfirmForgotPassword`. Both occur once per user, so D4's key behaves as a
genuine 1:N log at this scope.

> [!warning] Sharpest limitation of this design
> JE-38's issue text describes `users_cognito_events` as a "1:N event log". With D4's key it
> actually stores **one row per (user, trigger type)**, not one row per delivery. Adding a
> **recurring** trigger later — e.g. `PostAuthentication`, which fires on every login — would
> silently store only the first occurrence. **Revisiting the idempotency key is a prerequisite
> for capturing any recurring trigger.** Do not extend `triggerSource` support without first
> reworking D4.

### D6 — The prod PostConfirmation Lambda shim is out of scope

Deferred to a new `area/infra` issue. Floci never invokes Cognito triggers, so that code cannot
be verified locally and would merge without evidence. JE-38 delivers only what is verifiable
against Floci.

## Zod contract

```ts
CognitoWebhookPayload = z.object({
  version: z.string(),
  triggerSource: z.enum([
    "PostConfirmation_ConfirmSignUp",
    "PostConfirmation_ConfirmForgotPassword",
  ]),
  region: z.string(),
  userPoolId: z.string(),
  userName: z.string(),
  callerContext: z.object({ awsSdkVersion: z.string(), clientId: z.string() }),
  request: z.object({
    userAttributes: z
      .object({
        sub: z.string().uuid(),
        email: z.string().email(),
        email_verified: z.union([z.boolean(), z.string()]).optional(),
      })
      .passthrough(),
  }),
});
```

`passthrough()` on `userAttributes` because `raw_payload` (jsonb) must retain everything,
including future custom attributes. The `triggerSource` enum is the gate that enforces
[D5](#d5--scope-limited-to-postconfirmation).

## Data model

Columns are `snake_case` per [[db-naming]]; ids are prefixed nano-ids per [[nano-id]].

- **`users_cognito_data`** — 1:1 snapshot per user.
  `id` (`ucd_`), `user_id` FK → `users.id` (**unique**), `cognito_sub` (**unique**), `email`,
  `client_id`, `last_event_type`, `raw_payload` (jsonb), audit fields (`updated_at` = last sync).
- **`users_cognito_events`** — event log.
  `id` (`cge_`), `cognito_sub` FK → `users_cognito_data.cognito_sub`, `event_type`, `message_id`
  (**unique**, [D4](#d4--idempotency-key-is-derived-not-transmitted)'s derived key), `raw_payload`
  (jsonb), audit fields (`created_at` = received).

Chain: `users` —(`user_id`)→ `users_cognito_data` —(`cognito_sub`)→ `users_cognito_events`.

Add `UsersCognitoData: "ucd_"` and `UsersCognitoEvents: "cge_"` to `MODEL_ID_PREFIXES`.

## Error handling

| Condition | Response |
|---|---|
| Missing/incorrect secret | `401`, no DB write |
| Payload fails Zod | `422` with the Zod error |
| Unsupported `triggerSource` | `422` (rejected by the enum) |
| Event already seen (same `message_id`) | `200` — idempotent, not an error |
| No `users` row for that `sub` | `202` accepted; event logged, snapshot deferred |
| Self-POST fails inside `register` | Does not propagate — `log.error`, `register` still returns `201` ([D3](#d3--webhook-failure-is-best-effort-non-blocking)) |

## Testing strategy

- **Unit (Vitest):** Zod validation (valid / malformed / unsupported trigger); timing-safe secret
  comparison; deterministic `message_id` derivation.
- **Integration (`app.inject()`, no network):** `401` without the secret; `422` on invalid
  payload; and the case that matters most — POST the same event twice, assert exactly one row in
  `users_cognito_events`.
- **E2E (Playwright against Floci):** `register` → assert `users_cognito_data` and
  `users_cognito_events` rows exist for that `sub`. This exercises the real self-POST.

The JWT authorizer is not involved (fact 7). Per [[floci-vs-ministack-spike-findings]] the API
Gateway invoke URL has known limits on Floci, so E2E drives the service directly, consistent with
the approach JE-37 established.

## In scope / Out of scope

**In scope:** the webhook endpoint, the Zod contract, the two new tables plus their Prisma
migration, the `MODEL_ID_PREFIXES` entries, `WEBHOOK_SECRET` added to `shared/config/env.ts`
(Zod-validated), capturing `sub` in `register.ts`, the env-gated self-POST, and the tests above.

**Out of scope:** the prod PostConfirmation Lambda shim and its Terraform — deferred to a new
`area/infra` issue ([D6](#d6--the-prod-postconfirmation-lambda-shim-is-out-of-scope)).

## Open questions for implementation

- The env-gate variable name for the self-POST: reuse `E2E_TESTING_ENABLED` or introduce
  `LOCAL_COGNITO_WEBHOOK`? The issue mentions both; pick at implementation time.
- Where `WEBHOOK_SECRET` comes from in prod: Secrets Manager per [[ADR-0007-secrets-parameter-store]]
  — confirm the exact wiring when the infra issue ([D6](#d6--the-prod-postconfirmation-lambda-shim-is-out-of-scope))
  is written.

## Related

- [[users-service-milestone]]
- [[ADR-0010-cognito-auth]]
- [[ADR-0017-floci-local]]
- [[floci-vs-ministack-spike-findings]]
- [[soft-delete]]
- [[audit-fields]]
- [[nano-id]]
- [[db-naming]]
- [[versioning]]
- [[ADR-0007-secrets-parameter-store]]
