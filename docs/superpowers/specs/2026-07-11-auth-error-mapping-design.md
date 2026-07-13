---
title: Map Cognito auth exceptions to HTTP status codes (no more 500s)
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

# Map Cognito auth exceptions to HTTP status codes (no more 500s)

## Problem

`POST /v1/users/login` and `POST /v1/users/register` return **500** on ordinary
client errors (verified live; exception names captured from the service logs):

| Endpoint | Cognito exception | Cause | Today | Should be |
|---|---|---|---|---|
| login | `UserNotFoundException` | user doesn't exist | 500 | **401** |
| login | `NotAuthorizedException` | wrong password | 500 | **401** |
| register | `UsernameExistsException` | email already registered | 500 | **409** |

`CognitoAuthProvider.login()`/`signUp()` call the AWS SDK and let its exceptions
propagate uncaught; nothing maps them; Fastify serializes them as
`{"statusCode":500,"error":"Internal Server Error","message":"..."}`. A 500 wrongly
signals a server fault for what are normal client outcomes.

Design decisions (already made): login uses a **generic 401** (user-not-found
and wrong-password are indistinguishable — avoids user enumeration); register
uses **409**; the mapping lives in a **global `setErrorHandler`**, fed by
**typed domain errors** the auth provider throws (so the HTTP layer never
touches SDK exception names).

## Design

### 1. Typed domain errors — `shared/auth/auth-errors.ts` (new)

```ts
export class AuthError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidCredentialsError extends AuthError {
  constructor() { super("invalid credentials", 401, "invalid_credentials"); }
}

export class EmailAlreadyExistsError extends AuthError {
  constructor() { super("email already registered", 409, "email_exists"); }
}
```

### 2. `CognitoAuthProvider` translates SDK exceptions (`cognito-auth-provider.ts`)

The SDK exception names live ONLY here (Cognito is already encapsulated in this
class). Wrap the SDK calls and rethrow domain errors:

`login()`:
```ts
async login(email: string, password: string): Promise<AuthTokens> {
  let res;
  try {
    res = await this.client.send(new AdminInitiateAuthCommand({ /* unchanged */ }));
  } catch (e: any) {
    if (e?.name === "UserNotFoundException" || e?.name === "NotAuthorizedException") {
      throw new InvalidCredentialsError();
    }
    throw e;
  }
  const r = res.AuthenticationResult;
  return { idToken: r?.IdToken ?? "", accessToken: r?.AccessToken ?? "", refreshToken: r?.RefreshToken ?? "" };
}
```

`signUp()` — wrap the `AdminCreateUserCommand` call (the first SDK send):
```ts
let created;
try {
  created = await this.client.send(new AdminCreateUserCommand({ /* unchanged */ }));
} catch (e: any) {
  if (e?.name === "UsernameExistsException") throw new EmailAlreadyExistsError();
  throw e;
}
// ...rest unchanged (AdminSetUserPassword, sub extraction)
```
(The `AdminSetUserPassword` call and the "no sub" guard stay as-is; only the
create call gets the try/catch.)

### 3. Global error handler — `http/routes.ts` in `buildApp`

Register a `setErrorHandler` (there is none today). It maps `AuthError`
instances to their status; everything else keeps the current behavior.

```ts
import { AuthError } from "#shared/auth/auth-errors";
// inside buildApp, after compilers/plugins, before/around route registration:
app.setErrorHandler((error, req, reply) => {
  if (error instanceof AuthError) {
    return reply.code(error.statusCode).send({ error: error.code });
  }
  // Fastify schema-validation errors already carry statusCode 400 — preserve them.
  if ((error as any).validation) {
    return reply.code(400).send({ error: "invalid_request", details: (error as any).validation });
  }
  req.log.error({ err: error }, "unhandled error");
  const status = (error as any).statusCode ?? 500;
  return reply.code(status).send({ error: status === 500 ? "internal_error" : (error as any).code ?? "error" });
});
```

> **Must not regress existing handlers.** The webhook (`reply.code(401/422)`),
> `/me` (`reply.code(404)`), and e2e routes RETURN their responses via
> `reply.code().send()` — they do not throw — so `setErrorHandler` never sees
> them. The Zod validator's 400s DO surface as thrown validation errors; the
> `error.validation` branch preserves them. The implementer confirms the exact
> shape of a Zod-provider validation error (it may be `error.validation` or a
> `ZodFastifySchemaValidationError` — check `fastify-type-provider-zod`'s
> `hasZodFastifySchemaValidationErrors`) and keeps the current 400 behavior
> byte-compatible with the existing "register missing fields → 400" test.

### 4. OpenAPI schemas

- `POST /v1/users/login` response: add `401: ErrorSchema` (currently only 200).
- `POST /v1/users/register` response: add `409: ErrorSchema` (currently only 201).
- Regenerate `services/users/openapi.yaml`.

## Testing

Unit:
- `InvalidCredentialsError` → `{ statusCode: 401, code: "invalid_credentials" }`;
  `EmailAlreadyExistsError` → `{ statusCode: 409, code: "email_exists" }`.
- `CognitoAuthProvider.login`: SDK send throwing `{ name: "UserNotFoundException" }`
  → rejects with `InvalidCredentialsError`; same for `NotAuthorizedException`;
  a non-auth error rethrows unchanged; success path unchanged.
- `CognitoAuthProvider.signUp`: SDK create throwing `{ name: "UsernameExistsException" }`
  → rejects with `EmailAlreadyExistsError`; success path unchanged.
- Route (via `app.inject`): `POST /login` where the command rejects with
  `InvalidCredentialsError` → **401 `{"error":"invalid_credentials"}`**;
  `POST /register` rejecting with `EmailAlreadyExistsError` → **409
  `{"error":"email_exists"}`**.
- Existing tests stay green: login-happy, register-happy, register-missing-fields
  → 400, webhook 401/422, /me 404, e2e routes.

E2E (no rebuild needed — the stack is already up; this is service code, but the
container runs `dist/`, so rebuild the `users` image with `docker compose up -d
--build users` to pick up the change, NOT a full `make bootstrap`):
- `POST /login` (nonexistent user) → 401 (was 500).
- `POST /register` (duplicate email) → 409 (was 500).
- `POST /login` (valid creds) → 200 with tokens (unchanged).

## Non-goals (YAGNI)

- No blanket remapping of every possible Cognito exception — only the three that
  produce the observed 500s (UserNotFound/NotAuthorized/UsernameExists). Others
  keep 500 (genuinely unexpected).
- No distinguishing user-not-found vs wrong-password on login (intentional —
  generic 401 avoids user enumeration).
- No gateway/nginx/infra change; no new error-handling framework beyond the one
  `setErrorHandler` and the two domain error classes.

## Consequences

- Establishes an error-mapping pattern (domain errors + one `setErrorHandler`)
  that future endpoints can extend — a place to hang the missing "error-handling
  convention" the vault lacks today. Worth a short convention note later.
- `shared/auth` gains a tiny error module; the HTTP layer depends on `AuthError`
  (a shared type), NOT on the Cognito SDK — the boundary stays clean.
- login/register now return correct 4xx codes, so clients can handle "bad
  credentials"/"email taken" without treating them as server failures.

## Related

- [[ADR-0010-cognito-auth]]
- [[users-service-design]]
