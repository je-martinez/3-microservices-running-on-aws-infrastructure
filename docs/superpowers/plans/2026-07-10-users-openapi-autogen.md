# Users OpenAPI Auto-generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate `services/users/openapi.yaml` from the live Fastify routes (never hand-maintained again), while adding Zod-driven runtime validation and response serialization.

**Architecture:** Per-route Zod schemas drive three things at once — AJV validation (via `fastify-type-provider-zod`), response serialization, and the OpenAPI document produced by `@fastify/swagger`. A `generate:openapi` command builds the app in-memory, calls `app.swagger({ yaml: true })`, and writes the file. The production server is untouched and does no disk I/O.

**Tech Stack:** Fastify 5, Zod 3, `@fastify/swagger`, `fastify-type-provider-zod` v5, `tsx`, Vitest.

## Global Constraints

- **Node:** run `nvm use` before ANY node/pnpm command (repo pins 24.18.0 via `.nvmrc`).
- **Zod: same installed package (3.25.76), but import from the `zod/v4` subpath.** `fastify-type-provider-zod` v5 is written against Zod 4's internal API and crashes on classic-v3 schemas (`Cannot read properties of undefined (reading 'parent')`). Zod 3.25.76 ships the v4 API at the `zod/v4` subpath, so **all Users-service Zod imports migrate to `import { z } from "zod/v4"`** (verified: `env.ts` and `cognito-payload.ts` patterns — `.url()`, `.enum().default().transform()`, `.coerce`, `.uuid()`, `.union()`, `.passthrough()` — parse identically under v4). Do NOT add a new zod dependency; this is the same version's alternate entrypoint. This SUPERSEDES the earlier "never zod/v4" note.
- **Component `$ref` registration uses `z.globalRegistry`** (exists on `zod/v4`, not on classic `zod`). Register `UserSchema`/`AuthTokensSchema`/`ErrorSchema` via `z.globalRegistry.add(schema, { id })` and pass `transformObject: jsonSchemaTransformObject`.
- **`fastify-type-provider-zod` pinned to `^5.0.2`** — v6/v7 require `zod >=4.1.5` and MUST NOT be installed while the repo is on Zod 3.
- **`@fastify/swagger` `^9.5.1`** (peer floor of the provider).
- **OpenAPI version `3.1.0`** in the generated file (match the prior hand-written file).
- **Webhook contract is invariant:** `POST /v1/webhooks/cognito` returns **401** on bad/missing `x-webhook-secret` and **422** on invalid payload. These codes must not change — keep both checks INSIDE the handler; do NOT move the payload into `schema.body`.
- **Package manager:** pnpm. Commands run from `services/users/`.
- **Language:** code/comments in English; converse with the user in Spanish.
- **Git:** implementer writes only source; leaves work in the working tree. The main session commits via the A/B/C/D/E menu.

---

### Task 1: Install and pin dependencies

**Files:**
- Modify: `services/users/package.json` (dependencies)

**Interfaces:**
- Produces: the packages `@fastify/swagger`, `fastify-type-provider-zod` available to later tasks.

- [ ] **Step 1: Install the two packages at the pinned versions**

Run (from `services/users/`):
```bash
nvm use && pnpm add @fastify/swagger@^9.5.1 fastify-type-provider-zod@^5.0.2
```

- [ ] **Step 2: Verify the resolved versions satisfy Zod 3**

Run:
```bash
nvm use && node -e "const p=require('./package.json');console.log(p.dependencies['@fastify/swagger'], p.dependencies['fastify-type-provider-zod'])"
node -e "console.log('provider peer zod:', require('fastify-type-provider-zod/package.json').peerDependencies.zod)"
```
Expected: swagger `^9.5.1`, provider `^5.0.2`; provider peer zod prints a range that includes 3.25.x (e.g. `>=3.25.67`). If the provider resolved to v6/v7 (peer `>=4.1.5`), STOP — reinstall with the explicit `@5.0.2`.

- [ ] **Step 3: Confirm the build still compiles**

Run:
```bash
nvm use && pnpm build
```
Expected: PASS (no type errors) — no source changed yet, this baselines the toolchain.

- [ ] **Step 4: Commit**

```bash
git add services/users/package.json services/users/pnpm-lock.yaml ../../pnpm-lock.yaml 2>/dev/null; git add -A services/users
git commit -m "build(users): add @fastify/swagger + fastify-type-provider-zod (Zod 3 pinned)"
```

---

### Task 2: Migrate Zod imports to `zod/v4` + define reusable schemas

**Files:**
- Modify: `services/users/src/shared/config/env.ts` (line 1: `from "zod"` → `from "zod/v4"`)
- Modify: `services/users/src/features/users/webhooks/cognito-payload.ts` (line 1: `from "zod"` → `from "zod/v4"`)
- Create: `services/users/src/features/users/http/schemas.ts`
- Test: `services/users/tests/features/users/http/schemas.test.ts`

**Pre-step: migrate the two existing files' imports.** Change `import { z } from "zod";` to `import { z } from "zod/v4";` in `env.ts` and `cognito-payload.ts` (nothing else changes — verified that `.url()`, `.enum().default().transform()`, `.coerce.number()`, `.string().min()`, `.uuid()`, `.union()`, `.passthrough()` all parse identically under v4). After changing them, run `nvm use && pnpm test -- env.test cognito` (or the full suite) to confirm no regression BEFORE writing the new schemas file. This keeps a single Zod API (`zod/v4`) across the service, so re-exporting `cognitoWebhookPayloadSchema` from `schemas.ts` (also `zod/v4`) does not mix incompatible schema types.

**Interfaces:**
- Produces (all exported from `schemas.ts`):
  - `RegisterInputSchema`, `LoginInputSchema`, `UpdateProfileInputSchema` — `z.ZodObject` for request bodies.
  - `UserSchema` (registered `id: "User"`), `AuthTokensSchema` (`id: "AuthTokens"`), `ErrorSchema` (`id: "Error"`) — response bodies.
  - `UserIdHeader`, `WebhookSecretHeader` — header schemas.
  - `HealthResponseSchema`, `E2ECleanupResponseSchema` — small inline response schemas.
- Consumes: `cognitoWebhookPayloadSchema` from `../webhooks/cognito-payload.ts` (re-exported for the route file; NOT redefined).

- [ ] **Step 1: Write the failing test**

Create `services/users/tests/features/users/http/schemas.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  RegisterInputSchema, LoginInputSchema, UpdateProfileInputSchema,
  UserSchema, AuthTokensSchema, ErrorSchema, UserIdHeader,
} from "#features/users/http/schemas";

describe("http schemas", () => {
  it("RegisterInputSchema requires email/password/fullName, allows optional address/phoneNumber", () => {
    expect(RegisterInputSchema.safeParse({ email: "a@b.co", password: "P!1", fullName: "A" }).success).toBe(true);
    expect(RegisterInputSchema.safeParse({ email: "a@b.co" }).success).toBe(false);
  });

  it("LoginInputSchema requires email + password", () => {
    expect(LoginInputSchema.safeParse({ email: "a@b.co", password: "x" }).success).toBe(true);
    expect(LoginInputSchema.safeParse({ email: "a@b.co" }).success).toBe(false);
  });

  it("UpdateProfileInputSchema accepts an empty object (all optional)", () => {
    expect(UpdateProfileInputSchema.safeParse({}).success).toBe(true);
  });

  it("AuthTokensSchema requires the three tokens", () => {
    expect(AuthTokensSchema.safeParse({ idToken: "i", accessToken: "a", refreshToken: "r" }).success).toBe(true);
    expect(AuthTokensSchema.safeParse({ idToken: "i" }).success).toBe(false);
  });

  it("UserSchema parses a full user row shape", () => {
    const u = {
      id: "usr_x", email: "a@b.co", fullName: "A", address: null, phoneNumber: null,
      tags: [], createdBy: null, createdAt: "2026-07-10T00:00:00.000Z",
      updatedBy: null, updatedAt: "2026-07-10T00:00:00.000Z",
      deletedBy: null, deletedAt: null, isDeleted: false,
    };
    expect(UserSchema.safeParse(u).success).toBe(true);
  });

  it("UserIdHeader validates x-user-id and ErrorSchema an error string", () => {
    expect(UserIdHeader.safeParse({ "x-user-id": "usr_1" }).success).toBe(true);
    expect(ErrorSchema.safeParse({ error: "not_found" }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use && pnpm test -- schemas.test`
Expected: FAIL — cannot resolve `#features/users/http/schemas`.

- [ ] **Step 3: Write the schemas**

Create `services/users/src/features/users/http/schemas.ts`:
```ts
import { z } from "zod/v4";
import { cognitoWebhookPayloadSchema } from "../webhooks/cognito-payload.ts";

// Re-export so the route file imports webhook + all http schemas from one place.
// The payload schema is the single source of truth (see webhooks/cognito-payload.ts);
// it is documented in the spec but validated inside the handler to preserve the
// 422-on-invalid contract (see plan Global Constraints).
export { cognitoWebhookPayloadSchema };

// ---- Request bodies ----
export const RegisterInputSchema = z.object({
  email: z.string().email().describe("New user's email"),
  password: z.string().describe("Plaintext password (sent to the auth provider)"),
  fullName: z.string().describe("Display name"),
  address: z.unknown().optional().describe("Free-form structured address (stored as JSON)"),
  phoneNumber: z.string().optional(),
});

export const LoginInputSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export const UpdateProfileInputSchema = z.object({
  fullName: z.string().optional(),
  address: z.unknown().optional(),
  phoneNumber: z.string().optional(),
});

// ---- Responses ----
export const UserSchema = z
  .object({
    id: z.string().describe("Prefixed nano id, e.g. usr_V1StGXR8Z5"),
    email: z.string().email(),
    fullName: z.string(),
    address: z.unknown().nullable(),
    phoneNumber: z.string().nullable(),
    tags: z.array(z.string()),
    createdBy: z.string().nullable(),
    createdAt: z.string(),
    updatedBy: z.string().nullable(),
    updatedAt: z.string(),
    deletedBy: z.string().nullable(),
    deletedAt: z.string().nullable(),
    isDeleted: z.boolean(),
  })
  .describe("A user profile");

export const AuthTokensSchema = z.object({
  idToken: z.string(),
  accessToken: z.string(),
  refreshToken: z.string(),
});

export const ErrorSchema = z.object({
  error: z.string(),
});

export const HealthResponseSchema = z.object({ status: z.literal("ok") });
export const E2ECleanupResponseSchema = z.object({ deleted: z.number() });

// ---- Headers ----
export const UserIdHeader = z.object({
  "x-user-id": z.string().describe("Cognito subject forwarded by the API Gateway authorizer"),
});
export const WebhookSecretHeader = z.object({
  "x-webhook-secret": z.string().describe("Shared secret guarding the Cognito webhook"),
});

// Register reusable component ids so they appear under components/schemas
// (via jsonSchemaTransformObject) and are referenced by $ref in the spec.
z.globalRegistry.add(UserSchema, { id: "User" });
z.globalRegistry.add(AuthTokensSchema, { id: "AuthTokens" });
z.globalRegistry.add(ErrorSchema, { id: "Error" });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `nvm use && pnpm test -- schemas.test`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add services/users/src/features/users/http/schemas.ts services/users/tests/features/users/http/schemas.test.ts
git commit -m "feat(users): add reusable Zod schemas for http routes"
```

---

### Task 3: Wire the Zod type provider + swagger into buildApp

**Files:**
- Modify: `services/users/src/features/users/http/routes.ts`
- Test: `services/users/tests/features/users/http/routes.test.ts` (existing — must stay green)

**Interfaces:**
- Consumes: schemas from Task 2; `validatorCompiler`, `serializerCompiler`, `jsonSchemaTransform`, `jsonSchemaTransformObject`, `ZodTypeProvider` from `fastify-type-provider-zod`.
- Produces: `buildApp()` returns an app that (a) validates/serializes via Zod, (b) can produce an OpenAPI doc via `app.swagger()` after `app.ready()`.

- [ ] **Step 1: Write the failing test (spec integrity)**

Append to `services/users/tests/features/users/http/routes.test.ts`:
```ts
describe("openapi spec generation", () => {
  it("app.swagger() exposes all routes and the User component", async () => {
    const { buildApp } = await import("#features/users/http/routes");
    const { createContainer, asValue } = await import("awilix");
    const c = createContainer({ injectionMode: "PROXY" });
    c.register({ env: asValue({ E2E_TESTING_ENABLED: true } as any) });
    const app = buildApp(c as any);
    await app.ready();
    const spec = app.swagger() as any;
    const paths = Object.keys(spec.paths);
    expect(paths).toEqual(expect.arrayContaining([
      "/v1/health", "/v1/users/register", "/v1/users/login",
      "/v1/users/me", "/v1/webhooks/cognito",
      "/v1/users/e2e-cleanup", "/v1/users/e2e-identity",
    ]));
    expect(spec.components.schemas.User).toBeDefined();
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use && pnpm test -- routes.test`
Expected: FAIL — `app.swagger is not a function` (plugin not registered yet).

- [ ] **Step 3: Add imports + compilers + swagger registration**

In `services/users/src/features/users/http/routes.ts`, add imports after the existing ones (line 9 area):
```ts
import fastifySwagger from "@fastify/swagger";
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import {
  RegisterInputSchema, LoginInputSchema, UpdateProfileInputSchema,
  UserSchema, AuthTokensSchema, ErrorSchema,
  HealthResponseSchema, E2ECleanupResponseSchema,
  UserIdHeader, WebhookSecretHeader,
} from "./schemas.ts";
```

Immediately after `const app = Fastify({ logger: true });` set the compilers and register swagger (BEFORE the `fastifyAwilixPlugin` register and route declarations):
```ts
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.register(fastifySwagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Users Service API",
        version: "1.0.0",
        description:
          "HTTP API for the 3MRAI Users microservice (Fastify + Aurora Postgres). " +
          "Identity is enforced at the API Gateway authorizer, which forwards the " +
          "Cognito subject as the x-user-id header.",
      },
      servers: [{ url: "http://localhost:3000", description: "Local (docker compose / Floci)" }],
      tags: [
        { name: "health", description: "Liveness" },
        { name: "users", description: "Registration, auth and profile" },
        { name: "webhooks", description: "Inbound Cognito trigger (shared-secret guarded)" },
        { name: "e2e", description: "Test-only routes (E2E_TESTING_ENABLED)" },
      ],
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });

  const r = app.withTypeProvider<ZodTypeProvider>();
```

- [ ] **Step 4: Run the full existing suite to verify no regressions**

Run: `nvm use && pnpm test -- routes.test`
Expected: the new "openapi spec generation" test PASSES; all pre-existing route tests still PASS (health, register e2e-source, e2e-cleanup 404/200, e2e-identity, webhook 401/422). If any pre-existing test broke, the compilers changed behavior — reconcile before continuing.

- [ ] **Step 5: Commit**

```bash
git add services/users/src/features/users/http/routes.ts services/users/tests/features/users/http/routes.test.ts
git commit -m "feat(users): register @fastify/swagger + Zod type provider in buildApp"
```

---

### Task 4: Attach per-route schemas (validation + serialization + docs)

**Files:**
- Modify: `services/users/src/features/users/http/routes.ts`
- Test: `services/users/tests/features/users/http/routes.test.ts` (existing — must stay green)

**Interfaces:**
- Consumes: `r = app.withTypeProvider<ZodTypeProvider>()` and schemas from Task 3.
- Produces: every route carries a `schema` block; casts (`req.body as ...`) are removed except the webhook payload (kept manual).

- [ ] **Step 1: Add a failing test for input validation (400)**

Append to `routes.test.ts` inside `describe("routes")`:
```ts
it("register rejects a body missing required fields with 400", async () => {
  const app = buildApp(testContainer(false));
  const res = await app.inject({
    method: "POST", url: "/v1/users/register",
    payload: { email: "a@b.co" }, // missing password + fullName
  });
  expect(res.statusCode).toBe(400);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `nvm use && pnpm test -- routes.test`
Expected: FAIL — currently returns 201/500, not 400 (no body schema yet).

- [ ] **Step 3: Attach schemas to each route**

Rewrite the route declarations using `r` (the typed instance). Replace each `app.<verb>(...)` with `r.<verb>(...)` carrying a `schema`. Concrete changes:

`/v1/health`:
```ts
r.get("/v1/health", {
  schema: { tags: ["health"], operationId: "getHealth", summary: "Liveness probe",
    response: { 200: HealthResponseSchema } },
}, async () => ({ status: "ok" as const }));
```

`/v1/users/register` (remove the `as {...}` cast; keep the e2e header logic):
```ts
r.post("/v1/users/register", {
  schema: {
    tags: ["users"], operationId: "registerUser", summary: "Register a new user",
    body: RegisterInputSchema,
    response: { 201: UserSchema },
  },
}, async (req, reply) => {
  const body = req.body; // typed from RegisterInputSchema
  const headerFlag = req.headers["x-e2e-source"] === "true";
  const { env, registerUserCommand } = req.diScope.cradle;
  const e2eSource = headerFlag && env.E2E_TESTING_ENABLED;
  const user = await registerUserCommand.execute({ ...body, e2eSource });
  return reply.code(201).send(user);
});
```

`/v1/users/login`:
```ts
r.post("/v1/users/login", {
  schema: {
    tags: ["users"], operationId: "loginUser", summary: "Log in and obtain tokens",
    body: LoginInputSchema,
    response: { 200: AuthTokensSchema },
  },
}, async (req, reply) => {
  const { loginUserCommand } = req.diScope.cradle;
  const tokens = await loginUserCommand.execute(req.body);
  return reply.send(tokens);
});
```

`/v1/users/me` (GET) — headers documented; 404 keeps ErrorSchema:
```ts
r.get("/v1/users/me", {
  schema: {
    tags: ["users"], operationId: "getMe", summary: "Get the current user's profile",
    headers: UserIdHeader,
    response: { 200: UserSchema, 404: ErrorSchema },
  },
}, async (req, reply) => {
  const { userQueryService, currentActor } = req.diScope.cradle;
  const me = currentActor ? await userQueryService.getMe(currentActor) : null;
  return me ? reply.send(me) : reply.code(404).send({ error: "not_found" });
});
```

`/v1/users/me` (PATCH):
```ts
r.patch("/v1/users/me", {
  schema: {
    tags: ["users"], operationId: "updateMe", summary: "Update the current user's profile",
    headers: UserIdHeader,
    body: UpdateProfileInputSchema,
    response: { 200: UserSchema },
  },
}, async (req, reply) => {
  const { updateProfileCommand, currentActor } = req.diScope.cradle;
  const updated = await updateProfileCommand.execute(currentActor as string, req.body);
  return reply.send(updated);
});
```

`/v1/webhooks/cognito` — **do NOT put the payload in `schema.body`.** Document headers + responses only; keep the manual secret (401) and `safeParse` (422) checks exactly as they are:
```ts
r.post("/v1/webhooks/cognito", {
  schema: {
    tags: ["webhooks"], operationId: "cognitoWebhook",
    summary: "Cognito PostConfirmation trigger webhook",
    headers: WebhookSecretHeader,
    response: {
      200: z.object({ status: z.string() }),
      401: ErrorSchema,
      422: z.object({ error: z.literal("invalid_payload"), details: z.array(z.unknown()) }),
      500: ErrorSchema,
    },
  },
}, async (req, reply) => {
  // ...unchanged body: verifyWebhookSecret -> 401, safeParse -> 422, execute -> 200/500
});
```
Add `import { z } from "zod/v4";` at the top of `routes.ts` if not already present (it is needed for the inline webhook response schemas).

**Fix existing test fixtures for v4 `.email()`.** The current `routes.test.ts` register tests use `email: "a@b.c"` (lines ~35, ~46). Under `zod/v4`, `.email()` REJECTS `a@b.c` (single-char TLD), so once `RegisterInputSchema` validates the body these would flip 201→400. Update those two payloads to `email: "a@b.co"`. Do NOT weaken the schema to accept `a@b.c`; fix the fixtures. (The `getMe` mock at lines ~115/~128 returns `a@b.c` in a RESPONSE — that is serialized, not validated by `.email()` at the boundary the same way; only change it if a response-schema strip/validation causes a failure when the suite runs.)

e2e routes (inside the `if (container.cradle.env.E2E_TESTING_ENABLED)` block):
```ts
r.delete("/v1/users/e2e-cleanup", {
  schema: { tags: ["e2e"], operationId: "e2eCleanup", summary: "[E2E] Delete E2E-sourced users",
    response: { 200: E2ECleanupResponseSchema } },
}, async (req, reply) => {
  const { e2eCleanupCommand } = req.diScope.cradle;
  const { count } = await e2eCleanupCommand.execute();
  return reply.send({ deleted: count });
});

r.get("/v1/users/e2e-identity", {
  schema: {
    tags: ["e2e"], operationId: "e2eIdentity", summary: "[E2E] Read captured identity by email",
    querystring: z.object({ email: z.string().optional() }),
    response: { 200: z.object({}).passthrough(), 400: ErrorSchema },
  },
}, async (req, reply) => {
  const { e2eIdentityQuery } = req.diScope.cradle;
  const email = req.query.email;
  if (!email) return reply.code(400).send({ error: "email_required" });
  return reply.send(await e2eIdentityQuery.execute(email));
});
```

> Serialization note: the `200` response schemas strip undeclared fields. If a pre-existing test asserts a field not in `UserSchema`/etc., add that field to the schema — do not remove it from the handler.

- [ ] **Step 4: Run the full suite**

Run: `nvm use && pnpm test`
Expected: ALL tests pass — the new 400 test passes, and every pre-existing test (401/422 webhook, e2e 404/200, register e2e-source, health) stays green. Fix any serialization strip that drops an asserted field by extending the schema.

- [ ] **Step 5: Typecheck**

Run: `nvm use && pnpm build`
Expected: PASS — the `req.body`/`req.query` casts are gone and types infer from schemas.

- [ ] **Step 6: Commit**

```bash
git add services/users/src/features/users/http/routes.ts services/users/tests/features/users/http/routes.test.ts
git commit -m "feat(users): attach Zod schemas to routes (validation + serialization + spec)"
```

---

### Task 5: Generation script + package.json command

**Files:**
- Create: `services/users/src/features/users/http/generate-openapi.ts`
- Modify: `services/users/package.json` (scripts)

**Interfaces:**
- Consumes: `buildApp` from `routes.ts`.
- Produces: `pnpm generate:openapi` writes `services/users/openapi.yaml`.

- [ ] **Step 1: Write the generation script**

Create `services/users/src/features/users/http/generate-openapi.ts`:
```ts
// Generates services/users/openapi.yaml from the live routes. Run via
// `pnpm generate:openapi`. Builds the app with a minimal test container so it
// needs no database or real env: buildApp() skips singleton/service registration
// for any container that is not the shared diContainer, and we only call
// app.ready() + app.swagger() (no request injection), so no command mocks are
// required. E2E_TESTING_ENABLED is true so the file documents the full contract.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createContainer, asValue } from "awilix";
import { buildApp } from "./routes.ts";

async function main() {
  const container = createContainer({ injectionMode: "PROXY" });
  container.register({ env: asValue({ E2E_TESTING_ENABLED: true } as any) });

  const app = buildApp(container as any);
  await app.ready();
  const yamlSpec = app.swagger({ yaml: true });
  await app.close();

  // services/users/http/ -> services/users/  (../../../.. from http dir to service root)
  const here = dirname(fileURLToPath(import.meta.url));
  const out = resolve(here, "../../../../openapi.yaml");
  writeFileSync(out, yamlSpec);
  console.log(`Wrote ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Add the script to package.json**

In `services/users/package.json` `scripts`, add:
```json
"generate:openapi": "tsx --conditions=development src/features/users/http/generate-openapi.ts"
```

- [ ] **Step 3: Run the generator**

Run (from `services/users/`):
```bash
nvm use && pnpm generate:openapi
```
Expected: prints `Wrote .../services/users/openapi.yaml` and exits 0.

- [ ] **Step 4: Verify the generated spec**

Run:
```bash
python3 -c "
import yaml
d=yaml.safe_load(open('openapi.yaml'))
print('openapi:', d['openapi'])
print('paths:', len(d['paths']), sorted(d['paths'].keys()))
ops=sum(1 for p in d['paths'].values() for m in p if m in ('get','post','put','patch','delete'))
print('operations:', ops)
print('server:', d['servers'][0]['url'])
assert d['openapi'].startswith('3.1'), d['openapi']
assert ops == 8, ops
assert d['servers'][0]['url'] == 'http://localhost:3000'
assert 'User' in d['components']['schemas']
print('OK')
"
```
Expected: `openapi: 3.1.x`, 7 paths, 8 operations, server `http://localhost:3000`, `User` component present, prints `OK`.
> If `d['openapi']` is `3.0.x` instead of `3.1.0`, the toolchain forced 3.0 — acceptable, but update the spec doc's "3.1.0" note. Re-confirm with the user only if they required 3.1 strictly.

- [ ] **Step 5: Commit (script + generated file replacing the hand-written one)**

```bash
git add services/users/package.json services/users/src/features/users/http/generate-openapi.ts services/users/openapi.yaml
git commit -m "feat(users): generate openapi.yaml from routes via generate:openapi"
```

---

### Task 6: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Lint, typecheck, test, regenerate — all clean**

Run (from `services/users/`):
```bash
nvm use && pnpm lint && pnpm build && pnpm test && pnpm generate:openapi && git diff --stat services/users/openapi.yaml
```
Expected: lint PASS, build PASS, all tests PASS, generator writes the file, and `git diff` on `openapi.yaml` is EMPTY (regeneration is deterministic — the committed file already matches). A non-empty diff means generation is non-deterministic or the last commit was stale — investigate before finishing.

- [ ] **Step 2: Confirm the Apidog import path still holds**

The generated `services/users/openapi.yaml` is what gets imported into Apidog (Import Data → OpenAPI). No code change — just confirm the file exists and parsed OK in Task 5. The [[mcp-servers]] runbook already documents this flow.

---

## Self-Review

**Spec coverage:**
- Generate spec from routes → Tasks 3–5. ✓
- Per-route Zod schemas (validation/serialization/docs) → Tasks 2, 4. ✓
- `generate:openapi` command as sole writer → Task 5. ✓
- Preserve webhook 401/422 → Task 4 (payload kept out of `schema.body`; manual checks). ✓
- Version pins (Zod 3, provider v5.0.2, swagger 9.5.1, OpenAPI 3.1.0) → Global Constraints + Task 1. ✓
- Reuse `cognitoWebhookPayloadSchema` (no dup) → Task 2. ✓
- Replace hand-written yaml → Task 5 Step 5. ✓
- Spec-integrity test → Task 3 Step 1. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✓

**Type consistency:** `buildApp(container)` signature matches existing tests; `r = app.withTypeProvider<ZodTypeProvider>()` used consistently in Tasks 3–4; schema export names in Task 2 match imports in Tasks 3–4. ✓

**Open risk carried from spec:** OpenAPI 3.1 vs 3.0 default (Task 5 Step 4 handles both); webhook body documentation is intentionally description-only to preserve 422.

## Related

- [[2026-07-10-users-openapi-autogen-design]]
- [[users-service-design]]
- [[mcp-servers]]
