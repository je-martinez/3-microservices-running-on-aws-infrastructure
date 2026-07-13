---
title: Refresh token endpoint — POST /v1/users/refresh
type: spec
area: users
status: draft
created: 2026-07-11
updated: 2026-07-11
tags:
  - type/spec
  - area/users
  - status/draft
related:
  - "[[ADR-0010-cognito-auth]]"
  - "[[users-service-design]]"
---

# Refresh token endpoint — POST /v1/users/refresh

## Problem

Cognito access/id tokens expire (~1h). `login` returns a `refreshToken`, but
there is **no endpoint to redeem it** — a client must re-login when tokens
expire. Add `POST /v1/users/refresh` that exchanges a refresh token for fresh
id + access tokens.

Verified: Floci supports the `REFRESH_TOKEN_AUTH` flow (returns new id + access
tokens; the refresh token is NOT re-issued — the client keeps the old one), and
`ALLOW_REFRESH_TOKEN_AUTH` is already in the client's `explicit_auth_flows` — no
infra change to the Cognito module.

Decisions (made): the endpoint returns `{ idToken, accessToken }` (mirrors what
Cognito returns); the refresh token travels in the request body; the gateway
route is included (public, like login/register).

## Design

### 1. `AuthProvider.refresh` (`shared/auth/auth-provider.ts` + `cognito-auth-provider.ts`)

New response type + method on the interface:
```ts
export interface RefreshedTokens {
  idToken: string;
  accessToken: string;
}
export interface AuthProvider {
  signUp(email: string, password: string): Promise<CognitoSignUpResult>;
  login(email: string, password: string): Promise<AuthTokens>;
  refresh(refreshToken: string): Promise<RefreshedTokens>;
}
```

`CognitoAuthProvider.refresh` mirrors `login` (same `AdminInitiateAuthCommand`,
`REFRESH_TOKEN_AUTH` flow), and reuses the existing `InvalidCredentialsError`
(401) for an invalid/expired token:
```ts
async refresh(refreshToken: string): Promise<RefreshedTokens> {
  let res;
  try {
    res = await this.client.send(
      new AdminInitiateAuthCommand({
        UserPoolId: this.userPoolId,
        ClientId: this.clientId,
        AuthFlow: "REFRESH_TOKEN_AUTH",
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      }),
    );
  } catch (e: any) {
    if (e?.name === "NotAuthorizedException" || e?.name === "UserNotFoundException") {
      throw new InvalidCredentialsError();
    }
    throw e;
  }
  const r = res.AuthenticationResult;
  return { idToken: r?.IdToken ?? "", accessToken: r?.AccessToken ?? "" };
}
```

### 2. `RefreshTokenCommand` (`features/users/commands/refresh.ts`, new)

Thin, mirrors `LoginUserCommand` (constructor-injected `auth` from the Awilix
cradle, PROXY mode):
```ts
import type { AuthProvider, RefreshedTokens } from "#shared/auth/auth-provider";

export interface RefreshInput {
  refreshToken: string;
}

export class RefreshTokenCommand {
  private readonly auth: AuthProvider;
  constructor({ auth }: { auth: AuthProvider }) {
    this.auth = auth;
  }
  async execute(input: RefreshInput): Promise<RefreshedTokens> {
    return this.auth.refresh(input.refreshToken);
  }
}
```

### 3. DI registration (`shared/di/awilix-container.ts`)

- Add `refreshTokenCommand: RefreshTokenCommand;` to the `Cradle` type.
- Import `RefreshTokenCommand`.
- In `registerServices()`, add:
  `refreshTokenCommand: asClass(RefreshTokenCommand, { lifetime: Lifetime.SCOPED }),`
  (same shape as `loginUserCommand`).

### 4. Schemas (`features/users/http/schemas.ts`)

```ts
export const RefreshInputSchema = z.object({ refreshToken: z.string().min(1) });
export const RefreshedTokensSchema = z.object({
  idToken: z.string(),
  accessToken: z.string(),
});
```
(Imports stay `from "zod/v4"`.)

### 5. Route (`features/users/http/routes.ts`)

Public (NO JWT authorizer — the refresh token IS the credential). Registered
inside the `app.after()` block like the others:
```ts
r.post("/v1/users/refresh", {
  schema: {
    tags: ["users"], operationId: "refreshToken",
    summary: "Exchange a refresh token for new id/access tokens",
    body: RefreshInputSchema,
    response: { 200: RefreshedTokensSchema, 401: ErrorSchema },
  },
}, async (req, reply) => {
  const { refreshTokenCommand } = req.diScope.cradle;
  const tokens = await refreshTokenCommand.execute(req.body);
  return reply.send(tokens);
});
```
The existing `setErrorHandler` maps the thrown `InvalidCredentialsError` → 401
automatically. Import the two new schemas alongside the current schema imports.

### 6. API Gateway route (`infra/modules/api-gateway/main.tf`)

Add to the `local.routes` map (the public block, `auth = false`):
```hcl
refresh = { key = "POST /v1/users/refresh", path = "/v1/users/refresh", auth = false }
```
This creates the per-route integration (local baked-path) / shared integration
(prod) automatically via the existing `for_each` — no other gateway change.

## Testing

Unit:
- `CognitoAuthProvider.refresh`: success returns `{ idToken, accessToken }`;
  SDK send throwing `{ name: "NotAuthorizedException" }` → rejects with
  `InvalidCredentialsError`; unexpected error rethrows.
- `RefreshTokenCommand.execute` delegates to `auth.refresh` with the token.
- Route (via `app.inject`): `POST /refresh` with a command returning tokens →
  200 `{ idToken, accessToken }`; command throwing `InvalidCredentialsError` →
  401 `{ error: "invalid_credentials" }`; missing `refreshToken` body → 400
  (Zod).
- Existing suite stays green.

E2E:
- Service-level (no rebuild — `docker compose up -d --build users`): register →
  login (capture refreshToken) → `POST :3000/v1/users/refresh {refreshToken}` →
  200 with a NEW idToken/accessToken; a garbage refresh token → 401.
- Gateway-level (requires teardown + rebuild — the gateway route set changed;
  Floci 2nd-apply limit → `make bootstrap`): `POST <gateway>/v1/users/refresh`
  reachable and returns 200 for a valid token, 401 for invalid. This is the part
  that needs the destructive rebuild + the user's OK.

## Non-goals (YAGNI)

- No refresh-token rotation (Cognito reuses the same refresh token; we return
  only id+access, matching that).
- No refresh-token revocation endpoint / denylist.
- No cookie/header transport (body `{refreshToken}` only).
- No Cognito module change (`ALLOW_REFRESH_TOKEN_AUTH` already enabled).

## Consequences

- The auth surface is complete: register → login → refresh → me, all reachable
  through the gateway. A client can stay authenticated without re-login.
- `AuthProvider` gains a third method; `RefreshedTokens` is a new shared type
  (distinct from `AuthTokens` — no refresh token in the response).
- The gateway route addition means the next `make bootstrap` provisions 6 public
  + 2 protected routes.

## Related

- [[ADR-0010-cognito-auth]]
- [[users-service-design]]
