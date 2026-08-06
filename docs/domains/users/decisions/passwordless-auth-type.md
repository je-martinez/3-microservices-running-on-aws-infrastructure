---
title: Passwordless auth type — AuthType enum, service-side login guard, 401 not 403
type: adr
area: users
status: accepted
id: users-passwordless-auth-type
deciders: ["Jose E. Martinez"]
supersedes: null
superseded-by: null
created: 2026-08-05
updated: 2026-08-05
tags: [type/adr, area/users, status/accepted, issue/JE-83]
related:
  - "[[users-service-design]]"
  - "[[auth-error-mapping]]"
  - "[[cognito-custom-auth-triggers]]"
  - "[[2026-08-05-passwordless-otp-auth-design]]"
  - "[[2026-08-05-passwordless-otp-auth]]"
  - "[[logging-context]]"
  - "[[testing]]"
---

# Passwordless auth type — AuthType enum, service-side login guard, 401 not 403

## Context

Passwordless OTP authentication (see [[2026-08-05-passwordless-otp-auth-design]] and
[[2026-08-05-passwordless-otp-auth]]) needed a way to mark a user as having **no usable
password**, and a way to stop that guarantee from being purely incidental — "nobody happens to
know the random password Cognito still requires internally" is not the same as "this account
cannot be password-authenticated."

## Decision

- **`AuthType` enum (`PASSWORD` | `PASSWORDLESS`) on `User`, not a boolean.** A boolean
  (`isPasswordless`) cannot express a future third method (social login, passkeys) without a
  breaking rename, and `isPasswordless=false` does not say *which* method a user actually has —
  `authType=PASSWORD` is self-describing. `@default(PASSWORD) @map("auth_type")` means existing
  rows need no backfill.
- **Exposed read-only in the API response** (`UserSchema.authType`) — never a writable field on
  register or update. `POST /v1/users/register` always sets `PASSWORD`; the new `POST
  /v1/users/register/passwordless` is the only route that sets `PASSWORDLESS`.
- **A service-side login guard makes the passwordless guarantee structural, not cosmetic.**
  Cognito requires every user to have *some* password internally, so a passwordless user still
  gets a random 32-byte one assigned at creation, which is never revealed to the caller or stored
  anywhere retrievable. Relying on "the password is unknown" as the only protection would leave
  `ADMIN_USER_PASSWORD_AUTH` technically reachable against that value if it ever leaked or were
  brute-forced offline. `LoginUserCommand` therefore injects `db` and looks the user up by email
  **before** any Cognito call, rejecting a `PASSWORDLESS` user outright.
- **The rejection reuses the existing generic `401 invalid_credentials` — deliberately not a new
  `403`.** [[auth-error-mapping]]'s anti-user-enumeration rule requires login failures to stay
  indistinguishable from the response alone: user-not-found and wrong-password already map to
  the same `InvalidCredentialsError`, and a distinct status code for "this account has no
  password" would let a caller distinguish "wrong password" from "passwordless account" purely
  from the HTTP response — exactly the account-existence leak that rule exists to prevent. This
  is not a departure from [[auth-error-mapping]]; it is a direct application of it to a case the
  original design spec had not yet reconciled (the design spec's first draft proposed `403` for
  this case — the plan corrected it before implementation for this reason). The real cause is
  logged only as `reason: "passwordless_user"` on the existing `login_failed` app_event, never in
  the HTTP status or body. See [[logging-context]].
- **`InvalidOtpError` (401, `invalid_otp`) is a separate, new typed error** for `POST
  /v1/users/otp/verify` — distinct from `invalid_credentials`, because it answers a different
  question (a wrong OTP code, not a wrong password/nonexistent account) and does not carry the
  same enumeration risk: the caller already knows the email is enrolled in an OTP challenge by
  virtue of having called `otp/start` successfully.

## Consequences

- The passwordless guarantee is enforced by application code, not by secrecy of an internal
  Cognito password value — a leaked or brute-forced random password cannot authenticate a
  `PASSWORDLESS` account, because the DB lookup runs first and rejects before Cognito is ever
  called.
- Login's error surface stays a single generic 401 for every "this login will not succeed" case
  (wrong password, unknown user, passwordless account) — no new enumeration vector was
  introduced by adding a second reason a login can fail.
- Per [[testing]]'s mandatory-rejection-test rule, both branches this decision creates are
  covered by a dedicated negative test at all three layers: a wrong OTP code returns
  `401 invalid_otp`, and a passwordless user's login attempt with any password returns the
  generic `401 invalid_credentials`.

## Related

- [[users-service-design]]
- [[auth-error-mapping]]
- [[cognito-custom-auth-triggers]]
- [[2026-08-05-passwordless-otp-auth-design]]
- [[2026-08-05-passwordless-otp-auth]]
- [[logging-context]]
- [[testing]]
