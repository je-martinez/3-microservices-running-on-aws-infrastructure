---
title: "Password reset codes live in Redis, not Postgres — mustChangePassword stays in Postgres"
type: adr
area: users
status: accepted
created: 2026-08-09
updated: 2026-08-09
tags:
  - type/adr
  - area/users
  - status/accepted
related:
  - "[[ADR-0020-self-owned-password-reset]]"
  - "[[users-service-design]]"
  - "[[redis-elasticache-replication-group-floci]]"
  - "[[logging-context]]"
  - "[[env-files]]"
  - "[[testing]]"
---

# Password reset codes live in Redis, not Postgres — mustChangePassword stays in Postgres

## Decision

The self-owned password-reset flow ([[ADR-0020-self-owned-password-reset]]) stores its reset
codes in **Redis** (`ResetCodeStore`, `services/users/src/shared/cache/reset-code-store.ts`), not
in a Postgres table. `mustChangePassword` — a *different* kind of state on the same feature —
stays in **Postgres** as a column on `users`.

**The first implementation used a `UserPasswordResetCode` table. It was rejected** after review
in favor of Redis, specifically to get native `EX` expiry instead of hand-rolled TTL logic.

## Why Redis for the code

- **The code is a ten-minute secret that must vanish on its own.** `SET password-reset:<emailHash>
  <sha256(code)> EX 600` expires the key natively. The Postgres version needed an `expires_at`
  column, a comparison at every read, and either a sweeper job or accumulating dead rows — three
  things a ten-minute credential does not deserve to need.
- **One key per email is the "invalidate the previous code" rule, for free.** A second
  `/password/forgot` call necessarily replaces the key holding the first code — two live codes
  for the same email can never coexist, which bounds the guessing surface. The table version
  needed an explicit "consume the old rows" write to get the same property.
- **The key is namespaced by `hashEmail(email)`, never the plaintext address.** Redis keys are
  visible to anyone who can reach the instance (`KEYS *`, `MONITOR`, a slowlog entry, a memory
  dump) — keying by the raw address would turn the store into a directory of "people who
  recently forgot their password," the same PII the logging convention already keeps out of log
  lines (see [[logging-context]]). `hashEmail` is reused rather than inventing a second hashing
  scheme, so the Redis key and the request's `email_hash` log field line up for an operator
  debugging a reset.
- **The stored value is `SHA-256(code)`, never the code itself** (`hashResetCode` /
  `resetCodeMatches`, `services/users/src/shared/auth/reset-code.ts`), compared with
  `crypto.timingSafeEqual` after an explicit length check (plain `===` on hashes leaks match
  length through timing). Deliberately plain SHA-256, not bcrypt/argon2: the threat this defends
  against is a leaked Redis row being replayed as a live credential, which a hash alone defeats —
  the usual reason to add a work factor (an offline brute force against a long-lived secret)
  doesn't apply to a single-use, ten-minute value.
- **Verification is atomic verify-and-delete** (`ResetCodeStore.verifyAndConsume`): a successful
  check `DEL`s the key in the same call, so a code cannot be replayed. A wrong guess does **not**
  delete the key — otherwise one wrong-code POST could cancel a real user's outstanding reset, a
  trivial denial of service; the code's own TTL bounds the guessing window instead.
- **"Expired" and "never existed" collapse into the same `false`, on purpose.** Redis has already
  removed an expired key by the time it's checked, so there is no `expires_at` branch to write —
  and this collapse matches what the API exposes anyway (see the no-enumeration property in
  [[ADR-0020-self-owned-password-reset]]): the caller was never going to be told which case
  applied. The price is that the *log line* can't separate `expired_code` from `code_mismatch`
  the way the Postgres version could — a trade judged worth the native TTL.

## Ordering: the code is consumed **before** `AdminSetUserPassword` is called

`ConfirmPasswordResetCommand` calls `resetCodeStore.verifyAndConsume` (which deletes the key on
success) **before** calling Cognito. This is the one behavior that differs from the rejected
Postgres version, which applied the password first so a Cognito failure left the code reusable.
Here, a Cognito failure burns the code and the user must request a new one — accepted
deliberately: the alternative order (verify, call Cognito, then delete) leaves a *verified* code
live in Redis across a network call, so two concurrent requests could both pass verification, and
a crash between verify and delete would leave a usable code live for the rest of its TTL. Trading
a rare "request another code" for a closed replay window is the right tradeoff for a credential,
even though it is the less convenient one for a user hitting a transient Cognito error.

## Why `mustChangePassword` stays in Postgres, not Redis

`mustChangePassword` is a **durable user attribute** — a boolean column on `users`
(`must_change_password`, migration `20260810032046_add_must_change_password`), read on every
`GET /v1/users/me` and cleared by `PATCH /v1/users/me/password` or `POST
/v1/users/password/confirm`. It has **no expiry**, is read far more often than the reset flow
runs, and must survive indefinitely until the user acts on it — the opposite profile from the
code. Putting it in Redis would mean either giving a "must survive forever" flag a cache's
eviction/TTL semantics, or pinning it with no TTL in a store chosen specifically for TTL — neither
is a fit for what the flag actually is: a fact about the user, not a live secret.

## The four endpoints this shipped

Full detail (schemas, error contract) is in [[users-service-design#Passwordless OTP authentication]]-adjacent
sections of the service spec — summarized here for the decision's own context:

| Method | Path | What it does |
|---|---|---|
| `POST` | `/v1/users/password/forgot` | Mints a code, stores its hash in Redis, publishes `PASSWORD_RESET_REQUESTED`. Always `202`, same body, regardless of whether the email exists. |
| `POST` | `/v1/users/password/confirm` | Verifies `{ email, code, newPassword }` against the Redis store; on success calls `AdminSetUserPassword` and clears `mustChangePassword`. `401` on any failure (unknown email, wrong code, expired code — all the same error). |
| `PATCH` | `/v1/users/me/password` | Authenticated caller sets a new password directly (no code) via `AdminSetUserPassword`; clears `mustChangePassword`. A dedicated command, not folded into general profile update — see [[ADR-0020-self-owned-password-reset#Consequences]]. |
| `GET` | `/v1/users/me` | Now exposes `mustChangePassword: boolean` (read-only) so the frontend knows to force the change screen. |

## Related

- [[ADR-0020-self-owned-password-reset]] — why the reset is self-owned at all, and the two
  security properties (no enumeration, best-effort publish at the boundary) this store supports.
- [[users-service-design]] — the service spec these four endpoints and the `mustChangePassword`
  column are documented in.
- [[redis-elasticache-replication-group-floci]] — the infra decision provisioning the Redis
  instance this store connects to, and the Floci quirks around it.
- [[logging-context]] — the masked-email/`email_hash` convention this store's keying follows.
- [[env-files]] — `REDIS_HOST`/`REDIS_PORT` are generated into `.env.local.users`, never
  hand-maintained.
- [[testing]] — three-layer coverage for this flow, including
  `e2e/tests/gateway/password-reset-flow.spec.ts`.
