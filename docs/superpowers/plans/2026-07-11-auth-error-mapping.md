# Auth Error Mapping — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `POST /login` and `POST /register` return correct 4xx codes (401 for bad credentials, 409 for duplicate email) instead of 500, via typed domain errors + a global `setErrorHandler`.

**Architecture:** `CognitoAuthProvider` catches the SDK's `UserNotFound`/`NotAuthorized`/`UsernameExists` exceptions and rethrows typed `AuthError`s (`InvalidCredentialsError` 401, `EmailAlreadyExistsError` 409). A `setErrorHandler` in `buildApp` maps `AuthError` → its status; everything else (incl. Zod validation 400s) falls through to Fastify's default handling unchanged.

**Tech Stack:** Node 24, Fastify, `fastify-type-provider-zod`, Cognito SDK, Vitest.

## Global Constraints

- **Node:** `nvm use` before any pnpm/node command (24.18.0). From `services/users/`.
- **The `setErrorHandler` MUST NOT regress existing behavior:** the register-missing-fields test asserts `statusCode === 400` (not the body), the webhook returns 401/422 and `/me` returns 404 via `reply.code().send()` (they don't throw, so the handler never sees them). Validation errors (Zod) DO throw — the handler must let them keep their 400. Simplest safe approach: handle ONLY `AuthError` in the custom handler and RE-THROW everything else so Fastify's default handler processes it (preserves the exact current 400/500 bodies). Confirm with the full suite.
- **SDK exception names live only in `cognito-auth-provider.ts`** — the HTTP layer depends on `AuthError`, never on the Cognito SDK.
- **Login stays generic** (user-not-found and wrong-password both → 401, indistinguishable — no user enumeration).
- **Zod imports** stay `from "zod/v4"`. Code/comments English.
- **Git:** `users-impl` writes only source; main session commits. Service code only — no infra, no full `make bootstrap` (rebuild the users image only for E2E).

---

### Task 1: Typed domain errors

**Files:**
- Create: `services/users/src/shared/auth/auth-errors.ts`
- Test: `services/users/tests/shared/auth/auth-errors.test.ts`

**Interfaces:**
- Produces: `AuthError` (base, `statusCode`/`code`), `InvalidCredentialsError` (401/`invalid_credentials`), `EmailAlreadyExistsError` (409/`email_exists`) — consumed by Tasks 2 & 3.

- [ ] **Step 1: Write the failing test**

Create `services/users/tests/shared/auth/auth-errors.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { AuthError, InvalidCredentialsError, EmailAlreadyExistsError } from "#shared/auth/auth-errors";

describe("auth errors", () => {
  it("InvalidCredentialsError is 401/invalid_credentials", () => {
    const e = new InvalidCredentialsError();
    expect(e).toBeInstanceOf(AuthError);
    expect(e.statusCode).toBe(401);
    expect(e.code).toBe("invalid_credentials");
    expect(e.name).toBe("InvalidCredentialsError");
  });
  it("EmailAlreadyExistsError is 409/email_exists", () => {
    const e = new EmailAlreadyExistsError();
    expect(e).toBeInstanceOf(AuthError);
    expect(e.statusCode).toBe(409);
    expect(e.code).toBe("email_exists");
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `nvm use && pnpm test -- auth-errors.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `services/users/src/shared/auth/auth-errors.ts`:
```ts
// Typed auth-domain errors. The HTTP layer's setErrorHandler maps these to
// status codes without ever touching the Cognito SDK's exception names (those
// stay in cognito-auth-provider.ts).
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
  constructor() {
    super("invalid credentials", 401, "invalid_credentials");
  }
}

export class EmailAlreadyExistsError extends AuthError {
  constructor() {
    super("email already registered", 409, "email_exists");
  }
}
```

- [ ] **Step 4: Run to pass**

Run: `nvm use && pnpm test -- auth-errors.test`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit** *(main session)*

---

### Task 2: `CognitoAuthProvider` translates SDK exceptions

**Files:**
- Modify: `services/users/src/shared/auth/cognito-auth-provider.ts`
- Test: `services/users/tests/shared/auth-provider.test.ts` (existing — extend it)

**Interfaces:**
- Consumes: `InvalidCredentialsError`, `EmailAlreadyExistsError` (Task 1).
- Produces: `login` rejects with `InvalidCredentialsError` on UserNotFound/NotAuthorized; `signUp` rejects with `EmailAlreadyExistsError` on UsernameExists.

- [ ] **Step 1: Write the failing tests**

Add to `services/users/tests/shared/auth-provider.test.ts` (match its existing mock-client style — a `client` with a `send` vi.fn):
```ts
import { InvalidCredentialsError, EmailAlreadyExistsError } from "#shared/auth/auth-errors";

it("login maps UserNotFoundException to InvalidCredentialsError (401)", async () => {
  const client = { send: vi.fn(async () => { const e: any = new Error("User not found"); e.name = "UserNotFoundException"; throw e; }) };
  const p = new CognitoAuthProvider(client as any, "pool", "client");
  await expect(p.login("nobody@x.co", "bad")).rejects.toBeInstanceOf(InvalidCredentialsError);
});

it("login maps NotAuthorizedException to InvalidCredentialsError (401)", async () => {
  const client = { send: vi.fn(async () => { const e: any = new Error("Incorrect username or password"); e.name = "NotAuthorizedException"; throw e; }) };
  const p = new CognitoAuthProvider(client as any, "pool", "client");
  await expect(p.login("a@b.co", "wrong")).rejects.toBeInstanceOf(InvalidCredentialsError);
});

it("login rethrows unexpected errors unchanged", async () => {
  const boom = new Error("kaboom");
  const client = { send: vi.fn(async () => { throw boom; }) };
  const p = new CognitoAuthProvider(client as any, "pool", "client");
  await expect(p.login("a@b.co", "x")).rejects.toBe(boom);
});

it("signUp maps UsernameExistsException to EmailAlreadyExistsError (409)", async () => {
  const client = { send: vi.fn(async () => { const e: any = new Error("User already exists"); e.name = "UsernameExistsException"; throw e; }) };
  const p = new CognitoAuthProvider(client as any, "pool", "client");
  await expect(p.signUp("dup@x.co", "P@ss")).rejects.toBeInstanceOf(EmailAlreadyExistsError);
});
```
(Adjust the constructor call to match how the existing tests instantiate `CognitoAuthProvider`.)

- [ ] **Step 2: Run to see fail**

Run: `nvm use && pnpm test -- auth-provider.test`
Expected: FAIL — currently the SDK errors propagate raw (not the domain types).

- [ ] **Step 3: Implement the try/catch translation**

In `services/users/src/shared/auth/cognito-auth-provider.ts`:
- Add imports: `import { InvalidCredentialsError, EmailAlreadyExistsError } from "./auth-errors.ts";`
- Wrap the `login()` `AdminInitiateAuthCommand` send:
```ts
async login(email: string, password: string): Promise<AuthTokens> {
  let res;
  try {
    res = await this.client.send(
      new AdminInitiateAuthCommand({
        UserPoolId: this.userPoolId,
        ClientId: this.clientId,
        AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
        AuthParameters: { USERNAME: email, PASSWORD: password },
      }),
    );
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
- Wrap the `signUp()` `AdminCreateUserCommand` send (the FIRST send only; leave `AdminSetUserPassword` and the sub guard unchanged):
```ts
let created;
try {
  created = await this.client.send(new AdminCreateUserCommand({ /* unchanged args */ }));
} catch (e: any) {
  if (e?.name === "UsernameExistsException") throw new EmailAlreadyExistsError();
  throw e;
}
```

- [ ] **Step 4: Run to pass**

Run: `nvm use && pnpm test -- auth-provider.test`
Expected: PASS (new mapping tests + existing auth-provider tests).

- [ ] **Step 5: Commit** *(main session)*

---

### Task 3: Global error handler + OpenAPI schemas + regenerate

**Files:**
- Modify: `services/users/src/features/users/http/routes.ts`
- Test: `services/users/tests/features/users/http/routes.test.ts` (existing — extend)

**Interfaces:**
- Consumes: `AuthError` (Task 1); `login`/`signUp` now throw domain errors (Task 2).

- [ ] **Step 1: Write failing route tests (401 + 409)**

Append to `routes.test.ts` (use the existing `testContainer` pattern; register a `loginUserCommand`/`registerUserCommand` whose `execute` throws the domain error):
```ts
import { InvalidCredentialsError, EmailAlreadyExistsError } from "#shared/auth/auth-errors";

it("POST /v1/users/login returns 401 on invalid credentials", async () => {
  const c = testContainer(false);
  c.register({ loginUserCommand: asValue({ execute: vi.fn(async () => { throw new InvalidCredentialsError(); }) } as any) });
  const app = buildApp(c);
  const res = await app.inject({ method: "POST", url: "/v1/users/login", payload: { email: "a@b.co", password: "x" } });
  expect(res.statusCode).toBe(401);
  expect(res.json()).toEqual({ error: "invalid_credentials" });
});

it("POST /v1/users/register returns 409 on duplicate email", async () => {
  const c = testContainer(false);
  c.register({ registerUserCommand: asValue({ execute: vi.fn(async () => { throw new EmailAlreadyExistsError(); }) } as any) });
  const app = buildApp(c);
  const res = await app.inject({
    method: "POST", url: "/v1/users/register",
    payload: { email: "dup@b.co", password: "P@ss", fullName: "D" },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json()).toEqual({ error: "email_exists" });
});
```

- [ ] **Step 2: Run to see fail**

Run: `nvm use && pnpm test -- routes.test`
Expected: FAIL — the thrown AuthError currently becomes a 500.

- [ ] **Step 3: Add the setErrorHandler (AuthError only; re-throw the rest)**

In `services/users/src/features/users/http/routes.ts`:
- Import: `import { AuthError } from "#shared/auth/auth-errors";`
- In `buildApp`, after the compilers are set (before/around plugin+route registration), add:
```ts
app.setErrorHandler((error, _req, reply) => {
  if (error instanceof AuthError) {
    return reply.code(error.statusCode).send({ error: error.code });
  }
  // Everything else (Zod validation 400s, unexpected 500s) keeps Fastify's
  // default handling — re-throw so the framework's default error handler
  // produces the exact same body as before this change.
  throw error;
});
```
> If Fastify does not allow re-throwing from `setErrorHandler` in this version,
> fall back to explicitly replicating the default: for `error.validation` (or
> `hasZodFastifySchemaValidationErrors(error)`) reply `400` with the same shape
> the existing test tolerates (it only checks `statusCode === 400`); otherwise
> `reply.code(error.statusCode ?? 500).send(...)`. Verify the register-missing-
> fields test still passes either way.

- [ ] **Step 4: Add 401/409 to the OpenAPI route schemas**

In `routes.ts`:
- `POST /v1/users/login` `schema.response`: add `401: ErrorSchema` (alongside `200`).
- `POST /v1/users/register` `schema.response`: add `409: ErrorSchema` (alongside `201`).
(`ErrorSchema` is already imported.)

- [ ] **Step 5: Run the full suite**

Run: `nvm use && pnpm test`
Expected: ALL pass — new 401/409 tests, AND every existing test (register-missing-fields → 400, login-happy, register-happy, webhook 401/422, /me 404, e2e). If the 400 test regressed, the setErrorHandler is swallowing validation errors — fix per Step 3's fallback.

- [ ] **Step 6: Typecheck, lint, regenerate spec**

Run: `nvm use && pnpm build && pnpm lint && pnpm generate:openapi`
Expected: build + lint pass; `openapi.yaml` now documents `401` on login and `409` on register.

- [ ] **Step 7: Commit** *(main session)*

---

### Task 4: E2E verification (rebuild users image only — no full bootstrap)

**Files:** none (verification only).

> This is service code; the running container executes `dist/`, so rebuild ONLY the users image (`docker compose up -d --build users`). Do NOT run `make bootstrap` — no infra changed, so no teardown/rebuild of Floci is needed.

- [ ] **Step 1: Rebuild the users container**

```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
docker compose up -d --build users
# wait for health
for i in $(seq 1 8); do curl -sf -o /dev/null http://localhost:3000/v1/health && break; sleep 1.5; done
```

- [ ] **Step 2: Verify the 500s are now correct 4xx**

```bash
echo "login nonexistent  -> $(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:3000/v1/users/login -H 'Content-Type: application/json' -d '{"email":"nobody@x.co","password":"bad"}')"   # expect 401
# register a user, then register the same email again
curl -s -o /dev/null -X POST http://localhost:3000/v1/users/register -H 'Content-Type: application/json' -d '{"email":"dupe@example.co","password":"P@ssw0rd!2026","fullName":"D"}'
echo "register duplicate -> $(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:3000/v1/users/register -H 'Content-Type: application/json' -d '{"email":"dupe@example.co","password":"P@ssw0rd!2026","fullName":"D2"}')"  # expect 409
echo "register new       -> $(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:3000/v1/users/register -H 'Content-Type: application/json' -d '{"email":"fresh@example.co","password":"P@ssw0rd!2026","fullName":"F"}')"  # expect 201
```
Expected: `login nonexistent → 401`, `register duplicate → 409`, `register new → 201`. Clean up the test Cognito users afterward.

---

## Self-Review

**Spec coverage:**
- Typed domain errors (401/409) → Task 1. ✓
- Provider translates SDK exceptions (login + signUp) → Task 2. ✓
- Global setErrorHandler maps AuthError, preserves the rest → Task 3. ✓
- OpenAPI 401/409 + regenerate → Task 3 Steps 4,6. ✓
- Existing behavior preserved (400 validation, webhook, /me) → Task 3 Step 5 + Global Constraints. ✓
- E2E without full bootstrap → Task 4. ✓

**Placeholder scan:** No TBD/TODO; all code shown. The setErrorHandler has a primary (re-throw) and a documented fallback for the validation-preservation edge.

**Type consistency:** `AuthError`/`InvalidCredentialsError`/`EmailAlreadyExistsError` signatures identical across Tasks 1–3; the `{ error: code }` body shape matches between the provider errors and the route tests (`invalid_credentials`, `email_exists`).

## Related

- [[2026-07-11-auth-error-mapping-design]]
- [[ADR-0010-cognito-auth]]
