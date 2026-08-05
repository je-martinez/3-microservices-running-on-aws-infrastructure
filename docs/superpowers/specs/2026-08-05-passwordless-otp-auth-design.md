---
title: Passwordless OTP Authentication Design
type: spec
area: users
status: draft
created: 2026-08-05
updated: 2026-08-05
tags:
  - type/spec
  - area/users
  - status/draft
propagates-to:
  - "[[users-service-design]]"
  - "[[events-pipeline-design]]"
  - "[[testing]]"
  - "[[logging-context]]"
related:
  - "[[ADR-0017-floci-local]]"
  - "[[app-user-id-token-claim]]"
  - "[[auth-error-mapping]]"
  - "[[logging-context]]"
  - "[[testing]]"
  - "[[audit-fields]]"
  - "[[env-files]]"
---

# Passwordless OTP Authentication Design

## Summary

Adds one-time-code-by-email (OTP) authentication as a **second** login path alongside the
existing password login — password login is not removed. It also introduces fully
**passwordless** users, who have no usable password at all and can only authenticate via OTP.
The whole design hinges on `CUSTOM_AUTH`, Cognito's Lambda-driven challenge flow, rather than
the native `USER_AUTH` + `EMAIL_OTP` challenge — a choice justified empirically below, because
the native path silently does not work on Floci.

## Floci feasibility — verified empirically (2026-08-05)

Before committing to `CUSTOM_AUTH`, both the custom and native paths were probed by hand
against the running local stack (Floci's Cognito emulation). Results:

| Capability | Result |
|---|---|
| `CUSTOM_AUTH` triggers actually invoked by Floci | YES |
| Wrong code rejected | YES — `NotAuthorizedException: Incorrect challenge answer` |
| User with no password authenticates via OTP | YES |
| Coexistence with existing PreTokenGeneration V2 trigger | YES — `app_user_id` claim survives |
| Native `USER_AUTH` + `PREFERRED_CHALLENGE=EMAIL_OTP` | **NO — returns tokens with no challenge at all** |

### Evidence

- `InitiateAuth` with `AuthFlow=CUSTOM_AUTH` and no triggers configured on the user pool failed
  with `InvalidUserPoolConfigurationException: DefineAuthChallenge trigger is not configured`,
  confirming Floci actually validates the trigger wiring rather than no-op-ing the flow.
- With the three triggers wired to a probe Lambda, the same call returned
  `ChallengeName: CUSTOM_CHALLENGE` and echoed back `publicChallengeParameters` (`email:
  "masked"`), proving the Lambda genuinely ran rather than Floci faking a canned response.
- `RespondToAuthChallenge` with the correct answer issued Access/Id/Refresh tokens. With a wrong
  answer it raised `NotAuthorizedException: Incorrect challenge answer`.
- A user created via `AdminCreateUser` with no password at all reached `CONFIRMED` status in
  Floci and completed the full `CUSTOM_AUTH` flow end-to-end, issuing tokens — confirming
  passwordless users are viable, not just password users routed through a second path.

> [!danger] Critical trap — native `EMAIL_OTP` is silently bypassed on Floci
> Floci **accepts** `InitiateAuth` with `AuthFlow=USER_AUTH` and
> `PREFERRED_CHALLENGE=EMAIL_OTP` in the request, and **silently ignores it** — it returns
> Access/Id/Refresh tokens directly, with no challenge issued at all. An E2E test written
> against native `EMAIL_OTP` would pass green while authentication is entirely bypassed: no
> code is generated, none is verified, and a caller who only knows an email gets valid tokens
> for that user. This is exactly the shape of false-PASS this repo has hit before (see
> [[testing]] and the async-assertion lessons baked into it) — a test asserting "tokens were
> issued" without asserting "a challenge was actually presented and solved" cannot tell a real
> login from a bypassed one. **This is why the design uses `CUSTOM_AUTH`, never native
> `EMAIL_OTP`.**

> [!warning] Corrects the `floci` skill and the local-emulator spike
> The repo's `floci` skill states (quirk #7) that Cognito Lambda triggers are "stored but never
> invoked." That holds for `PostConfirmation`/`PreSignUp` — it does **not** hold for the three
> `CUSTOM_AUTH` challenge triggers (`DefineAuthChallenge`, `CreateAuthChallenge`,
> `VerifyAuthChallengeResponse`), which this probe confirms Floci genuinely invokes. The `floci`
> skill and [[floci-vs-ministack-spike-findings]] should be updated to narrow that claim to the
> trigger types it actually covers, rather than reading as a blanket statement about all Cognito
> triggers.

## Data model

`User.authType` — a new Prisma enum on the existing `User` model in
`services/users/prisma/schema.prisma`:

```prisma
enum AuthType {
  PASSWORD
  PASSWORDLESS
}

model User {
  // ...existing fields
  authType AuthType @default(PASSWORD) @map("auth_type")
}
```

An enum was chosen over a boolean (`isPasswordless`) for two reasons: a boolean cannot express a
future third method (social login, passkeys) without a breaking rename, and
`isPasswordless=false` does not say *which* method a user actually has — `authType=PASSWORD` is
self-describing. The `@default(PASSWORD)` means existing rows need no backfill and keep current
login behavior unchanged. The column follows the repo's existing snake_case `@map` convention
used throughout the `User` model.

## Endpoints

- **`POST /auth/otp/start`** — `{ email }` → `{ session }`. Works for both auth types: it is the
  second path for a `PASSWORD` user and the only path for a `PASSWORDLESS` user.
- **`POST /auth/otp/verify`** — `{ email, session, code }` → returns the same `AuthTokens` shape
  as the existing login endpoint, so the gateway, JWT authorizer, and `app_user_id` claim
  handling (see [[app-user-id-token-claim]]) need no change — OTP-issued tokens are
  indistinguishable downstream from password-issued ones.
- **`POST /auth/register/passwordless`** — creates the application `User` with
  `authType=PASSWORDLESS`, plus a backing Cognito user whose password is a random value that is
  never revealed to the caller or stored anywhere retrievable.
- Existing `POST /auth/login` and `POST /auth/register` are unchanged.

## The passwordless guarantee needs a service-side guard

Cognito requires every user to have *some* password internally, so a passwordless user still
gets a random one assigned at creation. That leaves `ADMIN_USER_PASSWORD_AUTH` (and any other
password-based flow) technically reachable against that random value if it ever leaked or were
brute-forced offline against Cognito's rate limits. Relying on "the password is unknown" as the
only protection makes the passwordless guarantee cosmetic rather than structural.

**`POST /auth/login` must therefore reject `authType=PASSWORDLESS` in the service layer**,
before any Cognito call, returning `403`. This check is what makes "passwordless" an enforced
property of the account rather than an incidental effect of nobody knowing the random password.
Per [[auth-error-mapping]], this joins the existing catalog of service-layer auth rejections
that must not leak Cognito's own error shape.

## The three Cognito triggers

Live in `infra/modules/cognito/`, following the same pattern as the existing pre-token Lambda —
including registration via the Python script where the pinned AWS provider can't express the
trigger config directly (`terraform_data.pre_token_trigger` +
`scripts/set_pre_token_trigger.py`).

- **`DefineAuthChallenge`** — orchestrates the flow: issue a challenge, count attempts, decide
  between issuing tokens and failing the session.
- **`CreateAuthChallenge`** — generates the code and places it **only** in
  `privateChallengeParameters`, so Cognito custodies it (encrypted, bounded by the session TTL);
  also publishes the `AUTH_OTP_REQUESTED` event that triggers the email (see below).
- **`VerifyAuthChallengeResponse`** — compares the submitted code to the private challenge
  parameter using a constant-time comparison.

No new database table is needed: the code lives entirely in Cognito's challenge session, so
there are no OTP rows to write, index, or clean up.

## Email delivery — reuses the existing events pipeline

A new event type, `AUTH_OTP_REQUESTED`, is added the same way every other event type is: one
entry in `functions/events-pipeline/src/handlers/index.ts` and one new template, `auth-otp`, in
`src/email/catalog.ts` (reusing this branch's branding templates, per
[[events-pipeline-design]]'s catalog mechanism). The envelope follows the existing
`EnvelopeSchema` (`functions/events-pipeline/src/domain/envelope.ts`), including the required
`author` object.

> [!danger] The OTP code must be redacted before persistence
> Every other event type persists its `payload` verbatim to DocumentDB, by design — that is
> the audit trail. `AUTH_OTP_REQUESTED` is the one exception: the code reaches the email
> renderer, but **must be redacted from the payload before the event document is written**. A
> live, unexpired credential sitting in the `events` collection — and in anything that later
> dumps or inspects a payload — turns an audit log into a second, weaker copy of the
> authentication surface.

## Latency

The three existing event types (`USER_CREATED`, `ORDER_CREATED`, `TRACKING_STATUS_CHANGED`) are
notifications where delivery lag is harmless — nobody is staring at their inbox waiting for an
order-confirmation email. An OTP is different: a human is actively waiting, and the code has a
short TTL. The path is `CreateAuthChallenge → SQS → Lambda → SES → Mailpit`, which adds a queue
hop and a full pipeline invocation to what is normally an instant code-entry experience.

**Plan task #1 must measure real end-to-end latency on this path** and set the code TTL from the
measurement rather than a guess — expected to land around 10 minutes, comfortably above a
seconds-scale pipeline, but this must be confirmed, not assumed.

**Documented fallback, not built pre-emptively:** if the measured latency is unacceptable,
`CreateAuthChallenge` can call SES directly instead of going through the pipeline, at the cost of
duplicating the email-sending path outside the catalog. Per YAGNI, this fallback is not built
unless the measurement in task #1 shows it is needed.

## Logging

Per [[logging-context]], log `otp_challenge_created` carrying `email_hash`, a correlatable
`challenge_id`, and the TTL — following the existing `app_event` convention
(`<flow>_started|_succeeded|_failed` plus `reason` on failure; there is no `SUCCESS` severity,
success is `INFO` + `app_event=*_succeeded`).

> [!danger] Never log the OTP code — not even masked or hashed
> [[logging-context]] already says never to log passwords or tokens; this makes explicit that
> the OTP code falls under that same rule with no exception, and explains why the usual masking
> trick does not apply here. Email masking (`jo*****e@gmail.com`) works because an email is a
> high-entropy identifier, not a credential — knowing the masked form doesn't materially help
> guess the real one. A 6-digit OTP has only ~1,000,000 possibilities: revealing half (`12****`)
> collapses the search space to 1,000 candidates, and even a truncated hash of the full code is
> brute-forceable in milliseconds offline. The code stays valid for its whole TTL, so any log
> access during that window would become a live authentication vector. `challenge_id` gives the
> same traceability with none of the risk, so there is no operational reason to log the code
> itself.

## Testing — three layers per the repo convention

Per [[testing]], every new or changed endpoint needs all three layers before it's done:

1. **Unit** — the three triggers as pure functions: challenge issued, correct code accepted,
   incorrect code rejected, attempts exhausted.
2. **Internal E2E** — `POST /auth/otp/start` and `POST /auth/otp/verify` against the direct
   service URL.
3. **Gateway E2E with Mailpit** — `otp/start` → poll Mailpit via `searchByRecipient(address)`
   (the existing `e2e/support/mailpit-client.ts`) → extract the code from the email body →
   `otp/verify` → use the resulting real JWT against a protected endpoint through the gateway,
   proving the OTP-issued token is accepted exactly like a password-issued one.

> [!warning] Two mandatory anti-false-PASS guards
> The repo has a documented history of tests passing green while the real path was broken (see
> the false-PASS lessons folded into [[testing]]). This design requires two specific negative
> tests, not just the happy path:
>
> - **A wrong code must be rejected.** Without this test, a flow that issues tokens without
>   actually validating anything would pass green — which is exactly what native `USER_AUTH` +
>   `EMAIL_OTP` does on Floci today (see the feasibility section above).
> - **`POST /auth/login` must be rejected for a passwordless user.** Without this test, the
>   service-side guard described above could regress silently and the passwordless guarantee
>   would quietly become cosmetic again.

E2E addresses follow the existing unique-per-run convention (`e2e+<uuid>@example.com`) so
Mailpit assertions can't accidentally read mail left over from a previous run.

## Out of scope (YAGNI)

- Password login is not removed; both paths coexist indefinitely.
- No custom rate-limiting layer — Cognito already bounds attempts per challenge session.
- The registration flow for password users (`POST /auth/register`) is untouched.
- No OTP for anything other than authentication (no OTP-gated password reset, no step-up MFA) —
  out of scope for this design.

## Open items for the plan

- Measure real pipeline latency end-to-end (task #1), then set the code TTL from the
  measurement rather than the ~10 minute estimate above.
- Confirm the code length/alphabet — proposal: 6 digits, numeric only.
- Decide whether `authType` is exposed in the user API response — proposal: yes, read-only.

## Related

- [[ADR-0017-floci-local]]
- [[app-user-id-token-claim]]
- [[auth-error-mapping]]
- [[logging-context]]
- [[testing]]
- [[audit-fields]]
- [[env-files]]
- [[users-service-design]]
- [[events-pipeline-design]]
