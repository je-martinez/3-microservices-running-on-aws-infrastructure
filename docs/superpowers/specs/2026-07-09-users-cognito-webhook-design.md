---
title: "JE-38 — Cognito identity webhook + identity tables — Design"
type: spec
area: users
status: draft
created: 2026-07-09
updated: 2026-07-10
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

The strategy adopted: **one shared persistence path**, the `CaptureCognitoIdentityCommand` use
case, reached two ways. In prod a Lambda shim turns a real Cognito PostConfirmation trigger into
an HTTP POST to `POST /v1/webhooks/cognito`, a thin route that verifies the shared secret, parses
with Zod, and delegates to the command. Locally, `register()` invokes the same command class
in-process through Awilix, with no HTTP hop — see
[D2](#d2--local-trigger-shared-use-case-class-invoked-in-process).

## Architecture

```
PROD:   Cognito --PostConfirmation--> Lambda shim --POST /v1/webhooks/cognito-->|
                                      (separate issue)                          |
                                                          verify secret + Zod   |
                                                                                v
                                                        CaptureCognitoIdentityCommand
                                                                                ^
LOCAL:  register() --auth.signUp()--> {sub, email, ...} --in-process call-------|
        (when NODE_ENV !== "production")                                        |
                                                                                  v
                                                        find users row by email
                                                                                  |
                                                             usersCognitoData.upsert
                                                             (events nested: create)
                                                                                  |
                                              +-------------------+--------------+
                                              v                   v
                                    users_cognito_data     users_cognito_events
                                    (1:1 by cognito_sub)   (child, same transaction)
```

The prod-side Lambda shim (the box that turns a real Cognito PostConfirmation trigger into an
HTTP POST) is drawn above for context only — see [Out of scope](#in-scope--out-of-scope); it is
not part of this issue.

### Persistence: a single nested write

The command looks up the `users` row by email first. If none matches, it does not persist
anything (see [Error handling](#error-handling)). Otherwise it persists with **one Prisma nested
write**: `usersCognitoData.upsert`, with the event nested via `events: { create: [...] }` inside
**both** the `create` and `update` branches. Prisma runs a nested write as a single transaction —
per the official docs, "Nested writes provide transactional guarantees ... If any part fails,
Prisma Client rolls back all changes" — so the parent snapshot is inserted before the child event,
and the foreign key from `users_cognito_events.cognito_sub` to `users_cognito_data.cognito_sub`
(NOT NULL) is satisfied by construction. There is no separate "write the event first" step; the
event is always a child of the snapshot in the same transaction.

This was verified live against the Floci Postgres instance, both paths:
- **First delivery** (no snapshot yet): the upsert's `create` branch runs `events: { create:
  [event] }` — snapshot and event are inserted together, the FK is satisfied, and the child event
  is returned.
- **Retry** (snapshot already present): the upsert's `update` branch runs `events: { create:
  [event] }` with the same `message_id` — Prisma throws `P2002` on the unique `message_id` index,
  and the event count stays at 1. [D4](#d4--idempotency-key-is-derived-not-transmitted)'s
  idempotency guarantee holds through the nested write.

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
   discards it (`await this.auth.signUp(...)`). Capturing it is part of this work — see fact 9 for
   why the return type must widen beyond `{ sub }`.
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
9. **The full webhook payload is constructible at the point `register()` calls `auth.signUp()`.**
   Verified against a live Floci Cognito pool: `AdminCreateUser` returns `User.Attributes`
   containing `sub`, `email`, and `email_verified`. `CognitoAuthProvider` already holds
   `userPoolId` and `clientId` as constructor fields
   (`services/users/src/shared/auth/cognito-auth-provider.ts:10-14`). Field sources for the
   synthetic local event:
   - `version` → constant `"1"`
   - `triggerSource` → constant `"PostConfirmation_ConfirmSignUp"`
   - `region` → `env.AWS_REGION`
   - `userPoolId` → `CognitoAuthProvider.userPoolId`
   - `userName` → the email
   - `callerContext.clientId` → `CognitoAuthProvider.clientId`
   - `request.userAttributes.{sub, email, email_verified}` → from `AdminCreateUser`'s response

   **Blocker to note:** `signUp()` today returns only `{ sub }` (`cognito-auth-provider.ts:37`)
   and discards the rest of `created.User`. It also has a silent fallback — if no `sub` attribute
   is found it returns the *email* in its place (`:36`). Widening its return type is part of this
   work, and that fallback should be revisited: a missing `sub` should probably fail loudly rather
   than masquerade as one.

## Decisions

### D1 — Security: shared secret in a header

The caller sends `x-webhook-secret`; the service compares it to `env.WEBHOOK_SECRET` using a
**timing-safe comparison**.

Rejected: HMAC body signing (more code, and a body-canonicalization footgun) and IAM/SigV4 (Floci
does not validate SigV4, which would break the one-handler premise and make the local path
untestable). Trade-off accepted: a leaked secret allows replay; rotation is manual.

### D2 — Local trigger: shared use-case class, invoked in-process

The HTTP route `POST /v1/webhooks/cognito` is a **thin layer**: verify the shared secret → parse
with Zod → delegate to `CaptureCognitoIdentityCommand.execute(event)`. `register()` calls that
**same command class directly through Awilix**, with no HTTP hop, when `env.NODE_ENV !==
"production"` ([env gate](#env-gate)). One persistence path, reached two ways: in prod the
Cognito Lambda shim enters via HTTP; locally `register()` enters via the class.

`app.inject()` was considered — it would exercise the full route without a socket — but it
requires the command to hold a reference to the Fastify `app` that contains it. `buildApp()`
creates the app, and the app creates the DI container, so injecting `app` back into a command
inside that container is a circular dependency, resolvable only by a late `asValue` registration
or a lazy getter. Coupling a domain command to the HTTP server was judged not worth it. A real
self-POST (the service calling its own `/v1/webhooks/cognito` over HTTP) was rejected because the
service calling itself over the network adds timeout/port/DNS failure modes for no gain once the
persistence path is shared.

> [!warning] Trade-off — the local happy path skips the secret check and Zod validation
> With the in-process call, the local `register()` flow does **not** exercise the shared-secret
> check or the Zod parsing — those two layers are covered only by unit and integration tests,
> never by the local happy path. This is the cost of avoiding the self-call, and it is accepted
> deliberately, not an oversight.

### D3 — Webhook failure is best-effort, non-blocking

If the in-process command call fails (DB down, unexpected error), `register` logs the error and
still returns `201`. Identity capture is a secondary snapshot, not a registration precondition; in
prod Cognito retries the trigger anyway.

Rejected: failing the registration, which would leave an orphaned Cognito user and couple two
writes that don't need to be coupled.

### D4 — Idempotency key is derived, not transmitted

```
message_id = sha256(`${sub.length}:${sub}:${triggerSource.length}:${triggerSource}`)
```

Because the event carries no timestamp (fact 2), this deliberately collapses to **one row per
`(user, trigger type)`**. A Cognito retry hashes identically and is swallowed by `ON CONFLICT DO
NOTHING` — which is exactly the duplicate this is meant to prevent.

Rejected: a caller-generated UUID (a retry creates a new id, so it protects nothing) and the
Lambda `awsRequestId` (same flaw, plus it doesn't exist locally).

**Why length-prefixed, not a naive `sha256(sub + ":" + triggerSource)` join.** A plain `:` join is
not injective: `deriveMessageId("a:b", "c")` and `deriveMessageId("a", "b:c")` both hash the
identical string `"a:b:c"`, producing the identical digest. Two different events colliding on the
same `message_id` would mean one is silently swallowed by `ON CONFLICT DO NOTHING` — data loss
that would be very hard to trace, and it would defeat the exact guarantee this decision exists to
provide. This collision is **not reachable through the current caller**: the Zod contract
constrains `sub` to a UUID and `triggerSource` to the closed two-value enum in
[D5](#d5--scope-limited-to-postconfirmation), and neither can contain `:`. But `deriveMessageId`
is a standalone exported function, and its correctness must not depend entirely on its caller —
length-prefixing each component makes the encoding unambiguous (and therefore injective)
regardless of what strings are passed in.

> [!warning] The production Lambda shim MUST use this exact encoding
> The prod PostConfirmation Lambda shim (deferred to the `area/infra` issue per
> [D6](#d6--the-prod-postconfirmation-lambda-shim-is-out-of-scope)) **must derive `message_id`
> with this identical length-prefixed encoding** — not a re-implementation, not the naive `:`
> join. If prod and local diverge on this formula, they derive **different** keys for the
> **same** event, and idempotency silently fails across environments: a retry that should be
> deduped by `ON CONFLICT DO NOTHING` would instead insert a second row. This is the single
> most important consequence of this decision.

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

### D7 — Env gate: `NODE_ENV !== "production"` {#env-gate}

Not a dedicated `LOCAL_COGNITO_WEBHOOK` variable. The gate for the in-process call in
[D2](#d2--local-trigger-shared-use-case-class-invoked-in-process) is `env.NODE_ENV !==
"production"`, which covers local, test, and CI uniformly. Add to `shared/config/env.ts`:

```ts
NODE_ENV: z.enum(["development", "test", "production"]).default("development")
```

Verified: `NODE_ENV` currently exists in **none** of `services/users/src/shared/config/env.ts`,
`docker-compose.yml`, or `services/users/Dockerfile` — it must be added to the Zod schema;
`docker-compose.yml` can rely on the default.

Defaulting to `development` is deliberately safe: if a production deploy forgets
`NODE_ENV=production`, both the Lambda and `register()` capture the identity — but they derive
the **same** `message_id` ([D4](#d4--idempotency-key-is-derived-not-transmitted)), so `ON
CONFLICT DO NOTHING` swallows the duplicate. The failure mode of the default is benign and
self-healing, not data loss.

### D8 — `WEBHOOK_SECRET` is required in every environment

`WEBHOOK_SECRET: z.string().min(1)` — no `.optional()`, in local/test/CI as much as prod.
`docker-compose.yml` supplies a development value for the `users` service. This is fail-fast: the
service refuses to boot without it, so the endpoint can never be deployed unprotected by
omission. In prod the value comes from Secrets Manager
([[ADR-0007-secrets-parameter-store]]) — that wiring belongs to the separate infra issue
([D6](#d6--the-prod-postconfirmation-lambda-shim-is-out-of-scope)).

Worth stating plainly: with the in-process local call from
[D2](#d2--local-trigger-shared-use-case-class-invoked-in-process), nothing in the local happy
path actually sends the secret; it guards only the HTTP endpoint, which locally is exercised only
by tests.

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
  `id` (`ucd_`), `user_id` FK → `users.id` (**unique**, **NOT NULL**), `cognito_sub` (**unique**),
  `email`, `client_id`, `last_event_type`, `raw_payload` (jsonb), audit fields (`updated_at` = last
  sync).
- **`users_cognito_events`** — event log.
  `id` (`cge_`), `cognito_sub` FK → `users_cognito_data.cognito_sub` (**NOT NULL**), `event_type`,
  `message_id` (**unique**, [D4](#d4--idempotency-key-is-derived-not-transmitted)'s derived key),
  `raw_payload` (jsonb), audit fields (`created_at` = received).

Chain: `users` —(`user_id`)→ `users_cognito_data` —(`cognito_sub`)→ `users_cognito_events`. Both FKs
are `NOT NULL`, which is why the event can never be persisted ahead of its snapshot, and the
snapshot can never be persisted ahead of its user — see [Persistence: a single nested
write](#persistence-a-single-nested-write).

Add `UsersCognitoData: "ucd_"` and `UsersCognitoEvents: "cge_"` to `MODEL_ID_PREFIXES`.

## Error handling

| Condition | Response |
|---|---|
| Missing/incorrect secret | `401`, no DB write |
| Payload fails Zod | `422` with the Zod error |
| Unsupported `triggerSource` | `422` (rejected by the enum) |
| Event already seen (same `message_id`) | `200` — idempotent, not an error |
| No `users` row for that email | The command does not persist anything (no snapshot, no event — see [Persistence: a single nested write](#persistence-a-single-nested-write)). The route maps it to an error (see the plan for the exact status). In prod, Cognito retries the trigger, so a transient race self-heals on retry. |
| In-process command call fails inside `register` | Does not propagate — `log.error`, `register` still returns `201` ([D3](#d3--webhook-failure-is-best-effort-non-blocking)) |

## Testing strategy

- **Unit (Vitest):** Zod validation (valid / malformed / unsupported trigger); timing-safe secret
  comparison; deterministic `message_id` derivation.
- **Integration (`app.inject()`, no network):** `401` without the secret; `422` on invalid
  payload; and the case that matters most — POST the same event twice, assert exactly one row in
  `users_cognito_events`.
- **E2E (Playwright against Floci):** `register` → assert `users_cognito_data` and
  `users_cognito_events` rows exist for that `sub`. This exercises the real in-process
  `CaptureCognitoIdentityCommand` call, **not** the HTTP route or its secret/Zod layers — those
  are covered only by the integration tests above ([D2](#d2--local-trigger-shared-use-case-class-invoked-in-process)).

The JWT authorizer is not involved (fact 7). Per [[floci-vs-ministack-spike-findings]] the API
Gateway invoke URL has known limits on Floci, so E2E drives the service directly, consistent with
the approach JE-37 established.

## In scope / Out of scope

**In scope:** the webhook endpoint, the Zod contract, the two new tables plus their Prisma
migration, the `MODEL_ID_PREFIXES` entries, the shared `CaptureCognitoIdentityCommand`, the thin
HTTP route that delegates to it, the `NODE_ENV` gate in `register()`, widening
`AuthProvider.signUp()`'s return type, adding `NODE_ENV` and `WEBHOOK_SECRET` to the Zod env
schema, and the tests above.

**Out of scope:** the prod PostConfirmation Lambda shim and its Terraform — deferred to a new
`area/infra` issue ([D6](#d6--the-prod-postconfirmation-lambda-shim-is-out-of-scope)).

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
