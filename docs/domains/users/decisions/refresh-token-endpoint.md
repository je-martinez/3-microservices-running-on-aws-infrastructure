---
title: Refresh token endpoint — POST /v1/users/refresh
type: adr
area: users
status: accepted
id: users-refresh-token-endpoint
deciders: ["Jose E. Martinez"]
supersedes: null
superseded-by: null
created: 2026-07-28
updated: 2026-07-28
tags: [type/adr, area/users, status/accepted]
related:
  - "[[users-service-design]]"
  - "[[ADR-0010-cognito-auth]]"
  - "[[2026-07-11-refresh-token-endpoint-design]]"
  - "[[2026-07-11-refresh-token-endpoint]]"
---

# Refresh token endpoint — POST /v1/users/refresh

## Context

Cognito access/id tokens expire (~1h). `login` already returns a `refreshToken`, but
there was no endpoint to redeem it, forcing a client to re-login on every expiry. Floci
was confirmed to support the `REFRESH_TOKEN_AUTH` flow, and `ALLOW_REFRESH_TOKEN_AUTH`
was already enabled on the Cognito client — no Cognito module change needed.

## Decision

- New `POST /v1/users/refresh`, **public** (no JWT authorizer) — the refresh token
  itself is the credential.
- Request body: `{ refreshToken }`. Response: `{ idToken, accessToken }` only — Cognito
  does not re-issue the refresh token on this flow, so the client keeps its original one.
- `AuthProvider` gains a third method, `refresh(refreshToken): Promise<RefreshedTokens>`,
  implemented in `CognitoAuthProvider` via `AdminInitiateAuthCommand` with
  `REFRESH_TOKEN_AUTH`, mirroring `login`.
- An invalid/expired refresh token reuses the existing `InvalidCredentialsError` (401) —
  no new error type, per [[2026-07-11-auth-error-mapping-design]]'s established pattern.
- A thin `RefreshTokenCommand` delegates directly to `AuthProvider.refresh`; the API
  Gateway route is added to the public block of `local.routes` (`auth = false`).

## Non-goals

- No refresh-token rotation (Cognito reuses the same refresh token on this flow).
- No refresh-token revocation endpoint or denylist.
- No cookie/header transport — body `{ refreshToken }` only.

## Consequences

- The auth surface is complete: register → login → refresh → me, all reachable through
  the gateway. A client can stay authenticated without re-login.
- `RefreshedTokens` is a new shared type, distinct from `AuthTokens` (no refresh token in
  the response) — do not conflate the two.
- Adding the gateway route bumps the local route count; a route-set change on Floci
  requires the destructive `make bootstrap` rebuild (Floci's 2nd-apply limit) before the
  gateway-level E2E layer can run.

## Related

- [[users-service-design]]
- [[ADR-0010-cognito-auth]]
- [[2026-07-11-refresh-token-endpoint-design]]
- [[2026-07-11-refresh-token-endpoint]]
