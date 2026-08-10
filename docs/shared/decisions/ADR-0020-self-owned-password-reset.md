---
title: "ADR-0020: Self-Owned Password Reset, Not Cognito's ForgotPassword"
type: adr
area: shared
status: accepted
id: ADR-0020
created: 2026-08-09
updated: 2026-08-09
deciders: [Jose E. Martinez]
supersedes: null
superseded-by: null
tags:
  - type/adr
  - area/shared
  - status/accepted
related:
  - "[[ADR-0010-cognito-auth]]"
  - "[[cognito-custom-auth-triggers]]"
  - "[[self-owned-password-reset-codes-in-redis]]"
  - "[[users-service-design]]"
  - "[[events-pipeline-design]]"
  - "[[email-templates]]"
  - "[[logging-context]]"
  - "[[testing]]"
---

# ADR-0020: Self-Owned Password Reset, Not Cognito's ForgotPassword

## Context

The web app needs a "forgot password" flow: a user who cannot sign in requests a reset, receives
a code by email, and sets a new password. Cognito ships this natively (`ForgotPassword` /
`ConfirmForgotPassword`), and the repo's existing passwordless-OTP work
([[cognito-custom-auth-triggers]]) already established a precedent for *not* trusting Cognito's
native flows on this substrate without measuring them first. The same discipline was applied
here: both the native path and a self-owned path were probed empirically before choosing.

## Decision — Users mints the code, emails it via the events pipeline, applies the change with `AdminSetUserPassword`

**Cognito's own `ForgotPassword`/`ConfirmForgotPassword` is not used anywhere in this flow.**
Three separate, measured findings rule it out — none of them assumed:

| Capability probed | Result |
|---|---|
| `ForgotPassword` returns the code to the caller | **NO** — it sends its own email and never returns the code in the API response, so this service could not intercept or re-send it even if it wanted to |
| Cognito's `CustomMessage` Lambda trigger fires on `ForgotPassword` (Floci) | **NO** — a probe Lambda logged **0** invocations from a real `ForgotPassword` call, while a **direct control invoke of the same Lambda logged 1** — proving the probe itself worked and the trigger genuinely did not fire, not that the probe was broken |
| `ConfirmForgotPassword` accepts a service-minted code | **NO** — the real Cognito-issued code (`074267`) succeeded; a service-minted code of the same shape returned `CodeMismatchException` |

> [!danger] This extends a prior finding — narrow it correctly
> [[cognito-custom-auth-triggers]] established that Floci invokes the three `CUSTOM_AUTH`
> *challenge* triggers (`DefineAuthChallenge`/`CreateAuthChallenge`/`VerifyAuthChallengeResponse`)
> genuinely, narrowing the repo's older blanket claim that "Cognito Lambda triggers are stored but
> never invoked" to `PostConfirmation`/`PreSignUp` only. **This ADR narrows it further: `CustomMessage`
> — a *messaging* trigger, not a challenge trigger — is *also* dead on Floci.** So the accurate
> statement is not "only sign-up triggers are dead" but **"only challenge (`CUSTOM_AUTH`) triggers
> fire; sign-up and messaging triggers do not."** See [[cognito-custom-auth-triggers]] for the
> updated capability table.

Given those three findings together, Cognito's native reset simply cannot be wired into this
product: there is no way to intercept the code (no trigger fires) and no way to substitute one
(only Cognito's own code passes verification). Rejected alternatives, and why each was rejected:

- **Use `ForgotPassword` as-is and let Cognito send its own email.** Rejected: it would ship a
  second, unbranded, unbrand-owned email outside the [[email-templates]] system, and the app has
  no way to know the code Cognito generated in order to show any custom UI around it.
  It also collides directly with the next alternative below (the two-emails problem).
  - **The two-emails problem.** If this service *also* emails a code (its own, self-owned one)
    while also calling Cognito's `ForgotPassword` for any reason, the user receives **two**
    reset emails with **two different codes**, only one of which (Cognito's) actually works
    against `ConfirmForgotPassword`. That is worse than confusing — it is silently broken for
    anyone who uses the wrong one. This is why the decision below is not "self-owned code,
    Cognito-owned apply": the whole flow, mint through apply, has to be on one side of that line.
  - **Rely on `CustomMessage` to customize Cognito's email and stay on its native flow entirely.**
    Rejected — the trigger does not fire (see the table above), so there is no hook to add
    the app's branding, a masked email, or the [[logging-context]] flow-log lines the rest of
    this product's auth flows produce.
- **Self-own the whole flow: mint the code, own its storage, own emailing it, own applying the
  password.** **Chosen.** It is the only option consistent with every measured fact above, and it
  reuses infrastructure and patterns already proven for passwordless OTP
  ([[cognito-custom-auth-triggers]], [[events-pipeline-design]]): a service-generated code, a
  dedicated event type through the same pipeline, and `AdminSetUserPassword` (already the
  mechanism Users uses elsewhere to set a Cognito password server-side) to apply the change.

Concretely: `POST /v1/users/password/forgot` mints a 6-digit code, stores its hash (see
[[self-owned-password-reset-codes-in-redis]] for the storage decision), and publishes
`PASSWORD_RESET_REQUESTED` to the events pipeline, which renders the `forgot-password` template
(the events pipeline's fifth, see [[email-templates]]) and sends it. `POST
/v1/users/password/confirm` verifies the code against the store and, on success, calls
`AdminSetUserPassword` — never `ConfirmForgotPassword`, which would reject a self-minted code
exactly as measured above.

## Two security properties this flow is built around (load-bearing, tested)

- **No user enumeration.** `POST /v1/users/password/forgot` answers identically — same status,
  same body — whether or not the email belongs to an account. An unknown email is logged
  (operators only) and returns with no code minted and no event published, but the HTTP response
  is indistinguishable from a known email's. The same reasoning extends to `POST
  /v1/users/password/confirm`: an unknown email and a wrong/expired code both reject with the
  identical `invalid_reset_code` error — the caller cannot tell "no such account" from "wrong
  code" from the response alone.
- **The event publish is best-effort *inside* the command, not delegated to the publisher's own
  swallow-and-log.** An unawaited publish rejection would surface as a 500 — but *only* for
  emails that exist (an unknown email never reaches the publish call at all), which turns a
  reliability failure into a second enumeration oracle by a different route than the first
  property closes. The `try/catch` around the publish call in `forgot-password.ts` is what keeps
  the guarantee structural: it is enforced at the boundary that owns the security property (the
  command), not left to a collaborator (the publisher) whose own retry/swallow behavior could
  change independently.

See [[testing]] for where these are exercised (unit + gateway E2E,
`e2e/tests/gateway/password-reset-flow.spec.ts`).

## Consequences

- Users now custodies a short-lived credential (the reset code) end to end — a tradeoff accepted
  because there was no working alternative, not because it was preferred. The code is never
  stored in plaintext (see [[self-owned-password-reset-codes-in-redis]]) and never logged.
- `PASSWORD_RESET_REQUESTED` joins `AUTH_OTP_REQUESTED` as one of exactly two event types whose
  payload is redacted before persistence to DocumentDB (`code` field) — see
  [[events-pipeline-design#Payload redaction — the one exception to "persist verbatim"]].
- A fourth Users auth surface (`PATCH /v1/users/me/password`) exists alongside the reset flow for
  an already-authenticated user changing their own password — deliberately a **separate**
  command (`ChangePasswordCommand`), not folded into the general profile-update command, so a
  request meant to change a phone number can never silently rewrite a credential, and the audit
  trail can tell the two apart.
- The `floci` skill's Cognito-trigger quirk (already narrowed once by [[cognito-custom-auth-triggers]])
  needs a second narrowing pass to add `CustomMessage` to the list of dead triggers — tracked
  here, not yet edited in the skill file itself.

## Related

- [[ADR-0010-cognito-auth]] — the base Cognito-as-auth-backend decision this flow builds on.
- [[cognito-custom-auth-triggers]] — the prior, narrower finding on `CUSTOM_AUTH` challenge
  triggers that this ADR extends to messaging triggers.
- [[self-owned-password-reset-codes-in-redis]] — the service-local decision on where the code
  lives (Redis, not Postgres) and the two Users-owned security properties in implementation detail.
- [[users-service-design]] — the four endpoints and `mustChangePassword` in the service spec.
- [[events-pipeline-design]] — `PASSWORD_RESET_REQUESTED` dispatch and redaction.
- [[email-templates]] — the `forgot-password` template, the fifth.
- [[logging-context]] — masked-email logging applied throughout this flow.
- [[testing]] — the three-layer testing convention this flow's gateway E2E follows.
