---
title: Auth error mapping — typed domain errors + global setErrorHandler
type: adr
area: users
status: accepted
id: users-auth-error-mapping
deciders: ["Jose E. Martinez"]
supersedes: null
superseded-by: null
created: 2026-07-28
updated: 2026-08-05
tags: [type/adr, area/users, status/accepted]
related:
  - "[[users-service-design]]"
  - "[[ADR-0010-cognito-auth]]"
  - "[[2026-07-11-auth-error-mapping-design]]"
  - "[[2026-07-11-auth-error-mapping]]"
  - "[[passwordless-auth-type]]"
---

# Auth error mapping — typed domain errors + global setErrorHandler

## Context

`POST /v1/users/login` and `POST /v1/users/register` returned **500** for ordinary
client errors: a nonexistent user or wrong password on login, and a duplicate email on
register. `CognitoAuthProvider.login()`/`signUp()` let AWS SDK exceptions
(`UserNotFoundException`, `NotAuthorizedException`, `UsernameExistsException`) propagate
uncaught, and nothing mapped them — Fastify's default handler serialized every one of
them as a 500, wrongly signaling a server fault for what are normal client outcomes.

## Decision

- **Typed domain errors** (`shared/auth/auth-errors.ts`): an `AuthError` base class
  (`statusCode`, `code`) with two concrete subclasses — `InvalidCredentialsError` (401,
  `invalid_credentials`) and `EmailAlreadyExistsError` (409, `email_exists`).
- **`CognitoAuthProvider` is the only place that knows Cognito's SDK exception names.**
  It wraps the relevant SDK calls in try/catch and rethrows the typed domain error;
  everything above it depends on `AuthError`, never on Cognito.
- **Login stays generic on 401.** User-not-found and wrong-password both map to the same
  `InvalidCredentialsError` — deliberately indistinguishable, to avoid user enumeration.
- **A single global `app.setErrorHandler`** in `routes.ts` maps `AuthError` instances to
  their status/code; everything else (Zod validation 400s, unexpected 500s) keeps
  Fastify's default handling untouched.
- Scope is narrow by design (YAGNI): only the three exceptions that produced observed
  500s are mapped. No blanket remapping of every possible Cognito exception.

## Consequences

- `login`/`register` now return correct 4xx codes; clients can distinguish "bad
  credentials"/"email taken" from a real server failure.
- Establishes the error-mapping pattern (typed domain error + one `setErrorHandler`)
  that later Users work reuses directly: [[2026-07-11-refresh-token-endpoint-design]]'s
  refresh endpoint reuses `InvalidCredentialsError` rather than adding a new error type.
- `shared/auth` gained a small error module; the HTTP layer depends on `AuthError` (a
  shared type), not on the Cognito SDK — the boundary stays clean.
- The anti-enumeration rule established here (login stays generic on 401) is what
  [[passwordless-auth-type]] (2026-08-05) applies to reject a `PASSWORDLESS` user's login
  attempt with the same generic `401 invalid_credentials` rather than a distinct `403` — the
  established pattern absorbing a new case, not a new pattern.

## Related

- [[users-service-design]]
- [[ADR-0010-cognito-auth]]
- [[2026-07-11-auth-error-mapping-design]]
- [[2026-07-11-auth-error-mapping]]
- [[passwordless-auth-type]]
