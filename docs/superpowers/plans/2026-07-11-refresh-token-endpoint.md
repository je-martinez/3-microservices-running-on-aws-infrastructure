# Refresh Token Endpoint — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `POST /v1/users/refresh` (public, through the gateway) exchanges a refresh token for new id + access tokens, reusing the existing 401 error mapping for an invalid/expired token.

**Architecture:** `AuthProvider.refresh` (REFRESH_TOKEN_AUTH flow) → `RefreshTokenCommand` (thin, DI-registered) → public route → new schemas. The API Gateway gets a new public route in `local.routes`. Cognito module unchanged (`ALLOW_REFRESH_TOKEN_AUTH` already enabled; Floci supports the flow — verified).

**Tech Stack:** Node 24, Fastify, `fastify-type-provider-zod`, Cognito SDK, Awilix DI, Terraform, Vitest.

## Global Constraints

- **Node:** `nvm use` before any pnpm/node command (24.18.0), from `services/users/`. Zod imports `from "zod/v4"`.
- **Response is `{ idToken, accessToken }`** only (Cognito does not re-issue the refresh token). Refresh token travels in the request body `{ refreshToken }`.
- **Reuse `InvalidCredentialsError`** (from the auth-error-mapping work) for an invalid/expired refresh token → 401. Do NOT add a new error type.
- **Route is PUBLIC** (no JWT authorizer) — the refresh token is the credential. In the gateway `local.routes`, `auth = false`.
- **SDK exception names** (`NotAuthorizedException`/`UserNotFoundException`) live only in `cognito-auth-provider.ts`.
- **Floci:** the gateway route-set changes, so gateway-level E2E needs teardown + rebuild (`make bootstrap`) — Task 5, NEEDS the user's explicit OK. Service-level E2E only needs `docker compose up -d --build users`.
- **Terraform** via `terraform -chdir=...`; provider pinned `= 5.31.0`; `terraform fmt` must pass.
- **Git:** implementers write only source; main session commits. Language: code English, converse Spanish.

---

### Task 1: `AuthProvider.refresh` + `RefreshedTokens` type

**Files:**
- Modify: `services/users/src/shared/auth/auth-provider.ts`
- Modify: `services/users/src/shared/auth/cognito-auth-provider.ts`
- Test: `services/users/tests/shared/auth-provider.test.ts` (existing — extend)

**Interfaces:**
- Produces: `RefreshedTokens { idToken, accessToken }`; `AuthProvider.refresh(refreshToken): Promise<RefreshedTokens>`.

- [ ] **Step 1: Write failing tests**

Add to `tests/shared/auth-provider.test.ts` (mirror the existing `new CognitoAuthProvider(client, "pool", "client")` + mocked `send` style):
```ts
import { InvalidCredentialsError } from "#shared/auth/auth-errors";

it("refresh returns new id + access tokens", async () => {
  const client = { send: vi.fn(async () => ({ AuthenticationResult: { IdToken: "id2", AccessToken: "acc2" } })) };
  const p = new CognitoAuthProvider(client as any, "pool", "client");
  await expect(p.refresh("rt")).resolves.toEqual({ idToken: "id2", accessToken: "acc2" });
});

it("refresh maps NotAuthorizedException to InvalidCredentialsError (401)", async () => {
  const client = { send: vi.fn(async () => { const e: any = new Error("Invalid Refresh Token"); e.name = "NotAuthorizedException"; throw e; }) };
  const p = new CognitoAuthProvider(client as any, "pool", "client");
  await expect(p.refresh("bad")).rejects.toBeInstanceOf(InvalidCredentialsError);
});

it("refresh rethrows unexpected errors", async () => {
  const boom = new Error("kaboom");
  const client = { send: vi.fn(async () => { throw boom; }) };
  const p = new CognitoAuthProvider(client as any, "pool", "client");
  await expect(p.refresh("rt")).rejects.toBe(boom);
});
```

- [ ] **Step 2: Run to fail**

Run: `nvm use && pnpm test -- auth-provider.test`
Expected: FAIL — `refresh` is not defined on the provider.

- [ ] **Step 3: Implement**

In `services/users/src/shared/auth/auth-provider.ts`, add:
```ts
export interface RefreshedTokens {
  idToken: string;
  accessToken: string;
}
```
and add to the `AuthProvider` interface:
```ts
  refresh(refreshToken: string): Promise<RefreshedTokens>;
```

In `services/users/src/shared/auth/cognito-auth-provider.ts`, add the method (import `RefreshedTokens` from `./auth-provider.ts`; `InvalidCredentialsError` is already imported from Task-2 of the prior feature):
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

- [ ] **Step 4: Run to pass + typecheck**

Run: `nvm use && pnpm test -- auth-provider.test && pnpm build`
Expected: PASS (3 new + existing); build clean.

- [ ] **Step 5: Commit** *(main session)*

---

### Task 2: `RefreshTokenCommand` + DI registration

**Files:**
- Create: `services/users/src/features/users/commands/refresh.ts`
- Modify: `services/users/src/shared/di/awilix-container.ts`
- Test: `services/users/tests/features/users/commands/refresh.test.ts`

**Interfaces:**
- Consumes: `AuthProvider.refresh` (Task 1).
- Produces: `RefreshTokenCommand.execute({ refreshToken }): Promise<RefreshedTokens>`; `refreshTokenCommand` in the cradle.

- [ ] **Step 1: Write the failing test**

Create `services/users/tests/features/users/commands/refresh.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { RefreshTokenCommand } from "#features/users/commands/refresh";

describe("RefreshTokenCommand", () => {
  it("delegates to auth.refresh with the token", async () => {
    const refresh = vi.fn(async () => ({ idToken: "id", accessToken: "acc" }));
    const cmd = new RefreshTokenCommand({ auth: { refresh } as any });
    const res = await cmd.execute({ refreshToken: "rt" });
    expect(refresh).toHaveBeenCalledWith("rt");
    expect(res).toEqual({ idToken: "id", accessToken: "acc" });
  });
});
```

- [ ] **Step 2: Run to fail**

Run: `nvm use && pnpm test -- refresh.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the command**

Create `services/users/src/features/users/commands/refresh.ts`:
```ts
import type { AuthProvider, RefreshedTokens } from "#shared/auth/auth-provider";

export interface RefreshInput {
  refreshToken: string;
}

// Constructor-injected from the Awilix cradle (PROXY injection mode).
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

- [ ] **Step 4: Register in DI**

In `services/users/src/shared/di/awilix-container.ts`:
- Add import: `import { RefreshTokenCommand } from "#features/users/commands/refresh";` (next to the other command imports).
- Add to the `Cradle` interface: `refreshTokenCommand: RefreshTokenCommand;` (next to `loginUserCommand`).
- In `registerServices()`, add: `refreshTokenCommand: asClass(RefreshTokenCommand, { lifetime: Lifetime.SCOPED }),` (next to `loginUserCommand`).

- [ ] **Step 5: Run to pass + typecheck**

Run: `nvm use && pnpm test -- refresh.test && pnpm build`
Expected: PASS; build clean (the cradle type resolves).

- [ ] **Step 6: Commit** *(main session)*

---

### Task 3: Schemas + public route

**Files:**
- Modify: `services/users/src/features/users/http/schemas.ts`
- Modify: `services/users/src/features/users/http/routes.ts`
- Test: `services/users/tests/features/users/http/routes.test.ts` (existing — extend)

**Interfaces:**
- Consumes: `refreshTokenCommand` (Task 2), `InvalidCredentialsError` (mapped to 401 by the existing setErrorHandler).

- [ ] **Step 1: Add the schemas**

In `services/users/src/features/users/http/schemas.ts` (imports already `from "zod/v4"`):
```ts
export const RefreshInputSchema = z.object({ refreshToken: z.string().min(1) });
export const RefreshedTokensSchema = z.object({ idToken: z.string(), accessToken: z.string() });
```

- [ ] **Step 2: Write failing route tests**

Append to `tests/features/users/http/routes.test.ts`. Register a `refreshTokenCommand` on the container per test (the existing `testContainer` doesn't include it):
```ts
import { InvalidCredentialsError } from "#shared/auth/auth-errors";

it("POST /v1/users/refresh returns 200 with new tokens", async () => {
  const c = testContainer(false);
  c.register({ refreshTokenCommand: asValue({ execute: vi.fn(async () => ({ idToken: "id2", accessToken: "acc2" })) } as any) });
  const app = buildApp(c);
  const res = await app.inject({ method: "POST", url: "/v1/users/refresh", payload: { refreshToken: "rt" } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ idToken: "id2", accessToken: "acc2" });
});

it("POST /v1/users/refresh returns 401 on invalid refresh token", async () => {
  const c = testContainer(false);
  c.register({ refreshTokenCommand: asValue({ execute: vi.fn(async () => { throw new InvalidCredentialsError(); }) } as any) });
  const app = buildApp(c);
  const res = await app.inject({ method: "POST", url: "/v1/users/refresh", payload: { refreshToken: "bad" } });
  expect(res.statusCode).toBe(401);
  expect(res.json()).toEqual({ error: "invalid_credentials" });
});

it("POST /v1/users/refresh returns 400 when refreshToken is missing", async () => {
  const app = buildApp(testContainer(false));
  const res = await app.inject({ method: "POST", url: "/v1/users/refresh", payload: {} });
  expect(res.statusCode).toBe(400);
});
```

- [ ] **Step 3: Run to fail**

Run: `nvm use && pnpm test -- routes.test`
Expected: FAIL — the `/v1/users/refresh` route doesn't exist (404), and the schemas aren't imported.

- [ ] **Step 4: Add the route**

In `services/users/src/features/users/http/routes.ts`:
- Add `RefreshInputSchema, RefreshedTokensSchema` to the existing import from `./schemas.ts`.
- Inside the `app.after()` block (near the login route), add:
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

- [ ] **Step 5: Full suite + build + lint + regenerate spec**

Run: `nvm use && pnpm test && pnpm build && pnpm lint && pnpm generate:openapi`
Expected: ALL tests pass (new 200/401/400 + every existing test); build + lint clean; `openapi.yaml` now has `POST /v1/users/refresh` with 200/401.

- [ ] **Step 6: Commit** *(main session)*

---

### Task 4: API Gateway public route

**Files:**
- Modify: `infra/modules/api-gateway/main.tf`

**Interfaces:** adds `POST /v1/users/refresh` (public) to the gateway route set.

- [ ] **Step 1: Add the route to `local.routes`**

In `infra/modules/api-gateway/main.tf`, add to the public block of the `local.routes` map (alongside `register`/`login`/`health`):
```hcl
      refresh  = { key = "POST /v1/users/refresh", path = "/v1/users/refresh", auth = false }
```
The existing `for_each` over `local.routes` creates the per-route integration (local baked-path) + route automatically — no other change.

- [ ] **Step 2: Format + validate**

Run:
```bash
terraform -chdir=infra/modules/api-gateway fmt
terraform -chdir=infra/environments/local validate
```
Expected: `Success! The configuration is valid.` Do NOT apply (Floci 2nd-apply limit).

- [ ] **Step 3: Commit** *(main session)*

---

### Task 5: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Service-level E2E (rebuild users image only — no bootstrap)**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
docker compose up -d --build users
for i in $(seq 1 8); do curl -sf -o /dev/null http://localhost:3000/v1/health && break; sleep 1.5; done
export AWS_ENDPOINT_URL=http://localhost:4566 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1
source .env
# register + login to get a refresh token
curl -s -X POST http://localhost:3000/v1/users/register -H 'Content-Type: application/json' -d '{"email":"rt@example.co","password":"P@ssw0rd!2026","fullName":"RT"}' >/dev/null
aws cognito-idp admin-set-user-password --user-pool-id "$COGNITO_USER_POOL_ID" --username rt@example.co --password 'P@ssw0rd!2026' --permanent --endpoint-url http://localhost:4566
RT=$(aws cognito-idp admin-initiate-auth --user-pool-id "$COGNITO_USER_POOL_ID" --client-id "$COGNITO_CLIENT_ID" --auth-flow ADMIN_USER_PASSWORD_AUTH --auth-parameters USERNAME=rt@example.co,PASSWORD='P@ssw0rd!2026' --endpoint-url http://localhost:4566 | python3 -c "import sys,json;print(json.load(sys.stdin)['AuthenticationResult']['RefreshToken'])")
echo "refresh valid   -> $(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:3000/v1/users/refresh -H 'Content-Type: application/json' -d "{\"refreshToken\":\"$RT\"}")"   # expect 200
echo "refresh invalid -> $(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:3000/v1/users/refresh -H 'Content-Type: application/json' -d '{"refreshToken":"garbage"}')"  # expect 401
```
Expected: `refresh valid → 200`, `refresh invalid → 401`. Confirm the 200 body has a new idToken/accessToken. Clean up the test user.

- [ ] **Step 2: Gateway-level E2E — NEEDS USER OK (teardown + rebuild)**

> The gateway route set changed; Floci forbids a 2nd apply. This requires `make bootstrap` (destructive: resets Cognito/DB IDs, regenerates `.env`). Get the user's explicit OK before running.

```bash
make bootstrap
```
Then, with a fresh token, POST to the gateway:
```bash
API_ID=$(terraform -chdir=infra/environments/local output -raw api_id)
BASE="http://localhost:4566/restapis/$API_ID/\$default/_user_request_"
# register/login via gateway to get a refresh token, then:
echo "gateway refresh -> $(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/users/refresh" -H 'Content-Type: application/json' -d "{\"refreshToken\":\"<token>\"}")"  # expect 200
```
Expected: the `/v1/users/refresh` route is reachable through the gateway and returns 200 for a valid token.

---

## Self-Review

**Spec coverage:**
- `AuthProvider.refresh` + `RefreshedTokens` → Task 1. ✓
- `RefreshTokenCommand` + DI → Task 2. ✓
- Schemas + public route + 401 mapping + OpenAPI → Task 3. ✓
- API Gateway public route → Task 4. ✓
- E2E (service + gateway) → Task 5. ✓
- Reuse InvalidCredentialsError (no new error type) → Task 1 Step 3. ✓
- Response is `{idToken, accessToken}` only → Task 1 + schema. ✓

**Placeholder scan:** No TBD/TODO; all code shown.

**Type consistency:** `RefreshedTokens {idToken, accessToken}` identical across provider (Task 1), command (Task 2), schema + route (Task 3); `refreshTokenCommand` cradle name matches the route's `req.diScope.cradle.refreshTokenCommand`.

**Known risk:** Task 5 Step 2 needs a destructive rebuild + user OK. Service-level (Step 1) validates the endpoint without it.

## Related

- [[2026-07-11-refresh-token-endpoint-design]]
- [[ADR-0010-cognito-auth]]
