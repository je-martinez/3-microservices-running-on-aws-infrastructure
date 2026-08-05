---
title: Passwordless OTP Authentication Implementation Plan
type: plan
area: users
status: active
created: 2026-08-05
updated: 2026-08-05
tags:
  - type/plan
  - area/users
  - status/active
propagates-to:
  - "[[users-service-design]]"
  - "[[events-pipeline-design]]"
  - "[[testing]]"
  - "[[logging-context]]"
  - "[[passwordless-auth-type]]"
  - "[[cognito-custom-auth-triggers]]"
related:
  - "[[2026-08-05-passwordless-otp-auth-design]]"
  - "[[ADR-0017-floci-local]]"
  - "[[auth-error-mapping]]"
  - "[[testing]]"
  - "[[logging-context]]"
  - "[[passwordless-auth-type]]"
  - "[[cognito-custom-auth-triggers]]"
---

# Passwordless OTP Authentication Implementation Plan

> [!info] Shipped and verified live (2026-08-05)
> All 16 tasks complete. Test counts: 254 unit (Users), 180 (events-pipeline), 11 (Lambda), 80
> E2E — all green, including both mandatory anti-false-PASS guards (wrong OTP code rejected,
> passwordless login rejected). Propagated into the organized vault: [[users-service-design]],
> [[events-pipeline-design]], [[testing]], [[logging-context]], and two new decision notes,
> [[passwordless-auth-type]] and [[cognito-custom-auth-triggers]].

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one-time-code-by-email (OTP) authentication to Users, as a second login path
alongside password login and as the only path for fully passwordless users, using Cognito's
`CUSTOM_AUTH` challenge flow (both locally and in production — never native `USER_AUTH`/
`EMAIL_OTP`, which Floci silently bypasses). A `POST /v1/users/otp/start` + `POST
/v1/users/otp/verify` pair issues the same `AuthTokens` shape as password login; `POST
/v1/users/register/passwordless` creates a `PASSWORDLESS` user; `POST /v1/users/login` rejects a
`PASSWORDLESS` user with a generic 401. The OTP code is emailed via the existing events pipeline
and is never persisted or logged in cleartext.

**Architecture:** Three Cognito Lambda triggers (`DefineAuthChallenge`, `CreateAuthChallenge`,
`VerifyAuthChallengeResponse`) are served by **one** new Lambda (`infra/modules/cognito/
otp-challenge-lambda/`), dispatching on `event.triggerSource`, registered on the user pool by a
new Python script following the existing `set_pre_token_trigger.py` pattern. `CreateAuthChallenge`
generates a 6-digit code, stores it **only** in Cognito's `privateChallengeParameters` (no new
DB table), and publishes an `AUTH_OTP_REQUESTED` event to the shared SQS queue so the existing
events-pipeline Lambda renders and sends the email via a new `auth-otp` template.
`VerifyAuthChallengeResponse` does a constant-time comparison. Users gets a new `AuthType` enum
(`PASSWORD` | `PASSWORDLESS`) on `User`, two new `AuthProvider` methods
(`startOtpChallenge`/`respondToOtpChallenge`) using `AdminInitiateAuthCommand`/
`RespondToAuthChallengeCommand` with `AuthFlow: "CUSTOM_AUTH"`/`ChallengeName:
"CUSTOM_CHALLENGE"`, and three new routes under the existing `/v1/users/*` prefix (not `/auth/*`
— this repo's endpoints are always `/v1/<service>/...`).

**Tech Stack:** Terraform (Cognito module, Lambda, IAM), Python (boto3 trigger-wiring script,
following `set_pre_token_trigger.py`), Node.js 24.18.0 (the new OTP Lambda, zero deps, mirroring
`pre-token-lambda/index.mjs`), TypeScript/Fastify/Zod/Prisma (Users service), TypeScript/react-email
(events-pipeline template + handler), vitest (Users + events-pipeline unit tests), Playwright
(internal + gateway E2E), Floci (local AWS emulator), Mailpit (local SMTP inbox).

## Global Constraints

- Node is pinned by `.nvmrc` (24.18.0) — run `nvm use` before ANY `node`/`npm`/`npx`/`pnpm`
  command in this plan, including every vitest run and `pnpm generate:openapi`.
- OTP code: **6 numeric digits**. TTL **300 seconds (5 minutes)**. This is a settled decision,
  not left to task 1 to determine: measured pipeline latency on this exact path (register →
  Mailpit) was **0.5s / 1.0s / 1.8s** (cold Lambda) across three trials, so 300s gives roughly
  **160x headroom** over the slowest observed run. 5 minutes is also a conventional, user-legible
  OTP lifetime — no further measurement task is needed before implementing.
- Auth flow is **`CUSTOM_AUTH` in BOTH local (Floci) and production**. The native `USER_AUTH` +
  `PREFERRED_CHALLENGE=EMAIL_OTP` flow is **never used**: Floci accepts the request and silently
  returns Access/Id/Refresh tokens with **no challenge issued at all** — a caller who only knows
  an email would authenticate as that user with no code ever generated or checked. This was
  verified empirically (see [[2026-08-05-passwordless-otp-auth-design]]) and is why every task
  below wires `CUSTOM_AUTH` explicitly, never `USER_AUTH`.
- Routes are **`/v1/users/otp/start`**, **`/v1/users/otp/verify`**, and
  **`/v1/users/register/passwordless`** — under the existing Users `/v1/users/*` prefix, per this
  repo's versioning + per-service-prefix convention (see the existing `/v1/users/register`,
  `/v1/users/login`). The design spec's `/auth/*` routes are **superseded by this plan** — they
  would break that convention.
- **ONE** Cognito Lambda serves all three triggers (`DefineAuthChallenge`, `CreateAuthChallenge`,
  `VerifyAuthChallengeResponse`), dispatching on `event.triggerSource`, exactly as
  `pre-token-lambda/index.mjs` is the repo's only precedent for a Cognito trigger Lambda — this
  keeps the pattern to one Terraform Lambda resource, one IAM role, one log group.
- **Login guard returns 401 `invalid_credentials`** (the existing generic auth error), **NOT**
  403. This deliberately overrides the design spec's proposed 403: per [[auth-error-mapping]]'s
  anti-user-enumeration rule, a distinct status code for "this account has no password" would let
  a caller distinguish "wrong password" from "passwordless account" from the response alone,
  which is exactly the kind of account-existence leak that convention exists to prevent. The real
  cause is recorded **only** in the log, as `reason: "passwordless_user"` on the existing
  `login_failed` app_event — never in the HTTP response body or status code.
- The `auth-otp` email template is built on the **existing plain `EmailLayout`**
  (`functions/events-pipeline/emails/components/layout.tsx`) — branding templates do not exist on
  this branch yet, and this plan has no dependency on branding work landing first (YAGNI).
- **NEVER log the OTP code** — not masked, not hashed, not truncated, and never embedded in a
  `reason` string or a Zod error message. The only OTP-related log line is `otp_challenge_created`
  carrying `email_hash`, `challenge_id`, and the TTL. A 6-digit code has only 1,000,000
  possibilities — unlike an email, no partial reveal or hash is safe (see
  [[2026-08-05-passwordless-otp-auth-design]]'s logging section for the full justification).
- `authType` is exposed **read-only** in the Users API response (`UserSchema`) — it is never a
  writable field on register/update, and no route sets it directly (register sets `PASSWORD`;
  the new passwordless-register route sets `PASSWORDLESS`).
- The OTP Lambda's payload **must be redacted before persistence**: the events-pipeline persists
  every other event's `payload` verbatim as its audit trail, but a live OTP code sitting in
  DocumentDB would be a second, weaker copy of the authentication surface. Task 8 adds a
  `redactPayload()` applied only at the exact point `process-record.ts` builds the persisted
  document, never touching the in-memory envelope the handler renders from.
- Commits follow Conventional Commits with scope `users`, `infra`, or `events-pipeline` (per the
  module/service touched).
- The implementer writes ONLY source code and never runs git beyond the per-task commit shown in
  each step, and never touches Linear.
- TypeScript path aliases in Users use `#` subpath imports (`#shared/*`, `#features/*`); the
  events-pipeline Lambda uses `#domain/*`, `#pipeline/*`, `#email/*`, `#handlers/*`, `#shared/*`.
  Neither uses `@`.
- Tests use **vitest** for both Users (`pnpm test`, `pnpm --filter` from repo root or
  `services/users`) and the events-pipeline Lambda (`npm test` → `vitest run` from
  `functions/events-pipeline`). E2E uses **Playwright** from `e2e/` (`internal` and `gateway`
  projects).
- Any route/schema change in Users requires `nvm use && pnpm generate:openapi` (from
  `services/users`) and committing the regenerated `services/users/openapi.yaml` in the same
  step.
- Any new Awilix Cradle key in Users requires adding it to `testContainer()` in
  `services/users/tests/features/users/http/routes.test.ts`, or every route test fails on
  resolution — even tests unrelated to the new key.
- OTel config lives in env vars, never in code — no `options.endpoint`/`options.protocol` set in
  TypeScript, per [[logging-context]] and the three prior silent failures this repo has hit from
  that exact mistake.

---

### Task 1: Prisma `AuthType` enum + `authType` column + migration

**Files:**
- Modify: `services/users/prisma/schema.prisma`
- Create: `services/users/prisma/migrations/<timestamp>_add_auth_type/migration.sql` (generated
  by `pnpm prisma migrate dev`, not hand-written)

**Interfaces:**
- Produces: Prisma enum `AuthType { PASSWORD PASSWORDLESS }`; `User.authType: AuthType` (default
  `PASSWORD`), mapped to `auth_type` column.

- [ ] **Step 1: Add the `AuthType` enum and `authType` field to the Prisma schema.**
  Open `services/users/prisma/schema.prisma` and add, above `model User`:
  ```prisma
  enum AuthType {
    PASSWORD
    PASSWORDLESS
  }
  ```
  Then add one field inside `model User` (after `deletedAt`, before the relation line), matching
  the existing snake_case `@map` convention used by every other field on this model:
  ```prisma
    authType    AuthType  @default(PASSWORD) @map("auth_type")
  ```
  The full field block becomes:
  ```prisma
  model User {
    id          String    @id
    email       String    @unique
    cognitoSub  String?   @unique @map("cognito_sub")
    fullName    String    @map("full_name")
    address     Json?
    phoneNumber String?   @map("phone_number")
    tags        String[]  @default([])
    authType    AuthType  @default(PASSWORD) @map("auth_type")
    createdBy   String?   @map("created_by")
    createdAt   DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
    updatedBy   String?   @map("updated_by")
    updatedAt   DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)
    deletedBy   String?   @map("deleted_by")
    deletedAt   DateTime? @map("deleted_at") @db.Timestamptz(6)

    cognitoData UsersCognitoData?

    @@map("users")
    @@index([deletedAt])
  }
  ```

- [ ] **Step 2: Generate the migration.**
  From `services/users/`, run:
  ```bash
  nvm use && pnpm prisma migrate dev --name add_auth_type
  ```
  Expect it to create `prisma/migrations/<timestamp>_add_auth_type/migration.sql` containing a
  `CREATE TYPE "AuthType"` and an `ALTER TABLE "users" ADD COLUMN "auth_type" "AuthType" NOT NULL
  DEFAULT 'PASSWORD'`, and to apply cleanly against the local dev database with no prompts about
  data loss (the column has a default, so existing rows backfill automatically).

- [ ] **Step 3: Verify the generated Prisma client exposes the new field.**
  ```bash
  nvm use && pnpm build
  ```
  Expect a clean TypeScript build — `src/generated/prisma` now types `authType: AuthType` on the
  `User` model with no manual edits needed (it is generated, never hand-edited).

- [ ] **Step 4: Commit.**
  ```bash
  git add services/users/prisma/schema.prisma services/users/prisma/migrations
  git commit -m "feat(users): add AuthType enum and authType column to User"
  ```

---

### Task 2: Expose `authType` read-only in the API response + regenerate openapi.yaml + fix `fakeUser()` fixture

**Files:**
- Modify: `services/users/src/features/users/domain/user.ts`
- Modify: `services/users/src/features/users/http/schemas.ts`
- Modify: `services/users/src/features/users/http/routes.ts`
- Modify: `services/users/openapi.yaml` (regenerated, not hand-edited)
- Modify: `services/users/tests/features/users/http/routes.test.ts`

**Interfaces:**
- Consumes: Prisma `authType` field from Task 1.
- Produces: `UserRow.authType: "PASSWORD" | "PASSWORDLESS"`; `UserSchema` gains `authType`.

- [ ] **Step 1: Write a failing route test asserting `authType` is present in the serialized user.**
  In `services/users/tests/features/users/http/routes.test.ts`, extend `fakeUser()`'s base
  object (so every existing call site keeps passing without every test needing an override) and
  add a dedicated assertion. First, update `fakeUser()`:
  ```typescript
  function fakeUser(overrides: Record<string, unknown> = {}) {
    return {
      id: "usr_1",
      email: "a@b.co",
      fullName: "A",
      address: null,
      phoneNumber: null,
      tags: [] as string[],
      authType: "PASSWORD" as const,
      createdBy: "usr_1",
      createdAt: FIXED_DATE,
      updatedBy: "usr_1",
      updatedAt: FIXED_DATE,
      deletedBy: null,
      deletedAt: null,
      isDeleted: false,
      ...overrides,
    };
  }
  ```
  Then add a new test near the existing register tests:
  ```typescript
  it("register response includes authType", async () => {
    const app = buildApp(testContainer(false));
    const res = await app.inject({
      method: "POST", url: "/v1/users/register",
      payload: { email: "a@b.co", password: "P!1", fullName: "A" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().authType).toBe("PASSWORD");
  });
  ```
  Run it now, before touching the schema:
  ```bash
  nvm use && pnpm --filter @3mrai/users test -- routes.test.ts
  ```
  Expect **FAIL** with a Zod serialization error (the handler returns a shape the response schema
  will reject once we add the field to `UserSchema` but not to `fakeUser()`'s wiring — actually
  at this point `UserSchema` does not declare `authType` yet, so the response's extra field would
  be silently stripped by Zod's default object mode, and `res.json().authType` would be
  `undefined`). Confirm the specific failure: `expect(res.json().authType).toBe("PASSWORD")`
  fails with `undefined !== "PASSWORD"`.

- [ ] **Step 2: Add `authType` to `UserRow` and `toDomain`.**
  Edit `services/users/src/features/users/domain/user.ts`:
  ```typescript
  export interface UserRow {
    id: string;
    email: string;
    fullName: string;
    cognitoSub: string | null;
    address: unknown | null;
    phoneNumber: string | null;
    tags: string[];
    authType: "PASSWORD" | "PASSWORDLESS";
    createdBy: string | null;
    createdAt: Date;
    updatedBy: string | null;
    updatedAt: Date;
    deletedBy: string | null;
    deletedAt: Date | null;
  }
  ```
  `toDomain` needs no change — it already spreads every field of `UserRow` through unchanged.

- [ ] **Step 3: Add `authType` to `UserSchema` in `schemas.ts`.**
  Edit `services/users/src/features/users/http/schemas.ts`:
  ```typescript
  export const UserSchema = z
    .object({
      id: z.string().describe("Prefixed nano id, e.g. usr_V1StGXR8Z5"),
      email: z.string().email(),
      fullName: z.string(),
      address: z.unknown().nullable(),
      phoneNumber: z.string().nullable(),
      tags: z.array(z.string()),
      authType: z
        .enum(["PASSWORD", "PASSWORDLESS"])
        .describe("Read-only. PASSWORDLESS accounts have no usable password and authenticate via OTP only."),
      createdBy: z.string().nullable(),
      createdAt: z.string(),
      updatedBy: z.string().nullable(),
      updatedAt: z.string(),
      deletedBy: z.string().nullable(),
      deletedAt: z.string().nullable(),
      isDeleted: z.boolean(),
    })
    .describe("A user profile");
  ```

- [ ] **Step 4: Confirm `serializeUser()` in `routes.ts` needs no change.**
  `serializeUser()` spreads `...user` and only overrides the three `Date` fields, so `authType`
  already passes through once it exists on the domain object. No edit needed in `routes.ts` for
  this step — verify by reading the function, do not add a redundant explicit `authType: user.authType`.

- [ ] **Step 5: Run the test again, expect PASS.**
  ```bash
  nvm use && pnpm --filter @3mrai/users test -- routes.test.ts
  ```
  Expect all tests in the file, including the new one, to pass — `res.json().authType` is now
  `"PASSWORD"` because `registerUserCommand` in `testContainer()` returns `fakeUser(...)`, which
  now includes `authType: "PASSWORD"` by default.

- [ ] **Step 6: Regenerate the OpenAPI spec.**
  ```bash
  cd services/users && nvm use && pnpm generate:openapi
  ```
  Expect `openapi.yaml`'s `User` component to gain an `authType` property with the enum
  `[PASSWORD, PASSWORDLESS]`.

- [ ] **Step 7: Run the full Users test suite and build.**
  ```bash
  nvm use && pnpm --filter @3mrai/users test && pnpm --filter @3mrai/users build
  ```
  Expect all tests green and a clean build.

- [ ] **Step 8: Commit.**
  ```bash
  git add services/users/src/features/users/domain/user.ts \
          services/users/src/features/users/http/schemas.ts \
          services/users/tests/features/users/http/routes.test.ts \
          services/users/openapi.yaml
  git commit -m "feat(users): expose authType read-only in the user API response"
  ```

---

### Task 3: `ALLOW_CUSTOM_AUTH` in both Terraform and `create_user_pool_client.py`

**Files:**
- Modify: `infra/modules/cognito/main.tf`
- Modify: `infra/modules/cognito/scripts/create_user_pool_client.py`

**Interfaces:**
- Produces: the Cognito app client's `explicit_auth_flows` (native path) and
  `ExplicitAuthFlows` (Floci CLI-fallback path) both include `ALLOW_CUSTOM_AUTH`.

- [ ] **Step 1: Add `ALLOW_CUSTOM_AUTH` to the native `aws_cognito_user_pool_client` resource.**
  In `infra/modules/cognito/main.tf`, edit the `explicit_auth_flows` list on
  `resource "aws_cognito_user_pool_client" "this"`:
  ```hcl
    explicit_auth_flows = [
      "ALLOW_ADMIN_USER_PASSWORD_AUTH",
      "ALLOW_USER_PASSWORD_AUTH",
      "ALLOW_REFRESH_TOKEN_AUTH",
      "ALLOW_CUSTOM_AUTH",
    ]
  ```

- [ ] **Step 2: Add `ALLOW_CUSTOM_AUTH` to the Floci CLI-fallback script.**
  In `infra/modules/cognito/scripts/create_user_pool_client.py`, edit the module-level
  `EXPLICIT_AUTH_FLOWS` list (the comment already states it must match the native resource — this
  keeps that true):
  ```python
  EXPLICIT_AUTH_FLOWS = [
      "ALLOW_ADMIN_USER_PASSWORD_AUTH",
      "ALLOW_USER_PASSWORD_AUTH",
      "ALLOW_REFRESH_TOKEN_AUTH",
      "ALLOW_CUSTOM_AUTH",
  ]
  ```
  Note this script has no test suite of its own (it is a `local-exec` provisioner) — verification
  is via `terraform validate` and `python -m py_compile` (below), and later, functionally, by
  Task 4's Lambda receiving `CUSTOM_AUTH` requests through this exact client without a
  `NotAuthorizedException` on the flow itself.

- [ ] **Step 3: Validate Terraform syntax.**
  ```bash
  cd infra && terraform -chdir=modules/cognito validate
  ```
  Expect `Success! The configuration is valid.` (this only checks the module in isolation, but
  catches an HCL typo immediately).

- [ ] **Step 4: Validate the Python script compiles.**
  ```bash
  .venv/bin/python -m py_compile infra/modules/cognito/scripts/create_user_pool_client.py
  ```
  Run from the repo root. Expect no output (success) — a syntax error would print a traceback.

- [ ] **Step 5: Commit.**
  ```bash
  git add infra/modules/cognito/main.tf infra/modules/cognito/scripts/create_user_pool_client.py
  git commit -m "feat(infra): enable ALLOW_CUSTOM_AUTH on the Cognito app client"
  ```

---

### Task 4: The `otp-challenge-lambda` (one Lambda, triggerSource dispatch, 6 digits, 300s, constant-time compare, publishes AUTH_OTP_REQUESTED)

**Files:**
- Create: `infra/modules/cognito/otp-challenge-lambda/index.mjs`
- Modify: `infra/modules/cognito/main.tf`
- Modify: `infra/modules/cognito/variables.tf`
- Modify: `infra/modules/cognito/outputs.tf`
- Modify: `infra/environments/local/main.tf` (wiring `module.cognito`'s new inputs)

**Interfaces:**
- Consumes: Cognito's `DefineAuthChallenge`/`CreateAuthChallenge`/`VerifyAuthChallengeResponse`
  trigger event shapes; `module.messaging` outputs `queue_url`/`queue_arn`.
- Produces: `aws_lambda_function.otp_challenge`; publishes an `AUTH_OTP_REQUESTED` SQS message
  matching the pipeline's `EnvelopeSchema`.

- [ ] **Step 1: Write the Lambda source.**
  Create `infra/modules/cognito/otp-challenge-lambda/index.mjs`:
  ```javascript
  // One Lambda serving all three CUSTOM_AUTH challenge triggers, dispatched on
  // event.triggerSource, mirroring the repo's only other Cognito trigger Lambda
  // (../pre-token-lambda/index.mjs — plain ESM, zero deps). No new DB table: the
  // code lives entirely in Cognito's challenge session (privateChallengeParameters),
  // which is encrypted and bounded by the session TTL.
  import { randomInt, timingSafeEqual } from "node:crypto";
  import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

  const CODE_LENGTH = Number(process.env.OTP_CODE_LENGTH ?? "6");
  const CODE_TTL_SECONDS = Number(process.env.OTP_CODE_TTL_SECONDS ?? "300");
  const MAX_ATTEMPTS = 3;

  const sqs = new SQSClient({
    region: process.env.AWS_REGION,
    endpoint: process.env.AWS_ENDPOINT_URL,
  });

  function generateCode() {
    // Numeric-only, zero-padded to CODE_LENGTH digits (e.g. "042817").
    const max = 10 ** CODE_LENGTH;
    return String(randomInt(0, max)).padStart(CODE_LENGTH, "0");
  }

  function constantTimeEquals(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    // timingSafeEqual throws on length mismatch rather than returning false —
    // guard explicitly so a wrong-length guess doesn't crash the trigger.
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }

  async function publishOtpRequested(event, code, challengeId) {
    const queueUrl = process.env.EVENTS_QUEUE_URL;
    const email = event.request.userAttributes.email;
    const envelope = {
      event_id: `evt_${challengeId}`,
      type: "AUTH_OTP_REQUESTED",
      source: "users",
      user_id: event.request.userAttributes.sub,
      order_id: null,
      author: { actor: "cognito:create_auth_challenge" },
      // `code` travels ONLY here, inside the SQS message body that the events
      // pipeline consumes to render the email — it is NEVER logged (see
      // otp_challenge_created below) and is redacted before the pipeline
      // persists this envelope's payload (functions/events-pipeline's
      // redactPayload, applied at process-record.ts).
      payload: { email, code, ttlSeconds: CODE_TTL_SECONDS },
    };
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(envelope),
        MessageAttributes: {
          type: { DataType: "String", StringValue: envelope.type },
          source: { DataType: "String", StringValue: envelope.source },
        },
      }),
    );
  }

  async function handleDefineAuthChallenge(event) {
    const sessions = event.request.session ?? [];
    const attempts = sessions.filter((s) => s.challengeName === "CUSTOM_CHALLENGE").length;

    if (sessions.length > 0 && sessions[sessions.length - 1].challengeResult === true) {
      event.response.issueTokens = true;
      event.response.failAuthentication = false;
      return event;
    }

    if (attempts >= MAX_ATTEMPTS) {
      event.response.issueTokens = false;
      event.response.failAuthentication = true;
      return event;
    }

    event.response.issueTokens = false;
    event.response.failAuthentication = false;
    event.response.challengeName = "CUSTOM_CHALLENGE";
    return event;
  }

  async function handleCreateAuthChallenge(event) {
    // A retry within the same session (a second CUSTOM_CHALLENGE round) must
    // NOT mint a new code — that would invalidate the one just emailed. Reuse
    // it from the previous challenge's private parameters if present.
    const sessions = event.request.session ?? [];
    const previous = sessions[sessions.length - 1];
    const code = previous?.challengeMetadata
      ? JSON.parse(previous.challengeMetadata).code
      : generateCode();

    if (!previous) {
      const challengeId = `otp_${event.request.userAttributes.sub}_${Date.now()}`;
      await publishOtpRequested(event, code, challengeId);
      // Structured log — mirrors the shared cross-service context. NEVER
      // includes the code itself, not even masked.
      console.log(
        JSON.stringify({
          level: "info",
          app_event: "otp_challenge_created",
          email_hash: undefined, // hashed client-side is unavailable here without a shared dep; challenge_id is the correlator instead
          challenge_id: challengeId,
          ttl_seconds: CODE_TTL_SECONDS,
        }),
      );
    }

    event.response.publicChallengeParameters = { email: "masked" };
    event.response.privateChallengeParameters = { code };
    // Round-trips the code to the NEXT invocation's `session` array (via
    // challengeMetadata) so a same-session retry reuses it instead of
    // generating a second, different code that would silently invalidate the
    // first email sent.
    event.response.challengeMetadata = JSON.stringify({ code });
    return event;
  }

  async function handleVerifyAuthChallengeResponse(event) {
    const expected = event.request.privateChallengeParameters.code;
    const submitted = event.request.challengeAnswer;
    event.response.answerCorrect = constantTimeEquals(expected, submitted);
    return event;
  }

  export const handler = async (event) => {
    switch (event.triggerSource) {
      case "DefineAuthChallenge_Authentication":
        return handleDefineAuthChallenge(event);
      case "CreateAuthChallenge_Authentication":
        return handleCreateAuthChallenge(event);
      case "VerifyAuthChallengeResponse_Authentication":
        return handleVerifyAuthChallengeResponse(event);
      default:
        return event;
    }
  };
  ```

- [ ] **Step 2: Add a `package.json` for the `@aws-sdk/client-sqs` dependency, since this Lambda
  (unlike `pre-token-lambda`) needs it.**
  Create `infra/modules/cognito/otp-challenge-lambda/package.json`:
  ```json
  {
    "name": "otp-challenge-lambda",
    "private": true,
    "type": "module",
    "dependencies": {
      "@aws-sdk/client-sqs": "^3.600.0"
    }
  }
  ```
  Install it so `archive_file` zips real `node_modules` alongside `index.mjs`:
  ```bash
  cd infra/modules/cognito/otp-challenge-lambda && npm install
  ```
  Expect a `node_modules/` and `package-lock.json` to be created in that directory.

- [ ] **Step 3: Add the Terraform module inputs the Lambda needs.**
  In `infra/modules/cognito/variables.tf`, add:
  ```hcl
  variable "events_queue_url" {
    description = "URL of the shared events SQS queue the OTP challenge Lambda publishes AUTH_OTP_REQUESTED to."
    type        = string
  }

  variable "events_queue_arn" {
    description = "ARN of the shared events SQS queue, for the OTP challenge Lambda's IAM policy."
    type        = string
  }

  variable "otp_code_length" {
    description = "Number of digits in a generated OTP code."
    type        = number
    default     = 6
  }

  variable "otp_code_ttl_seconds" {
    description = "OTP code TTL in seconds, informational only (Cognito enforces session expiry independently)."
    type        = number
    default     = 300
  }
  ```

- [ ] **Step 4: Add the Lambda resource, IAM role/policy, and permission in `main.tf`.**
  Append to `infra/modules/cognito/main.tf`, after the existing pre-token Lambda block:
  ```hcl
  # ─── OTP Challenge Lambda (CUSTOM_AUTH: Define/Create/VerifyAuthChallenge) ────
  # One Lambda serving all three triggers, dispatched by triggerSource — see
  # otp-challenge-lambda/index.mjs. Unlike pre_token, this role needs sqs:SendMessage:
  # CreateAuthChallenge publishes AUTH_OTP_REQUESTED to the shared events queue.
  data "archive_file" "otp_challenge" {
    type        = "zip"
    source_dir  = "${path.module}/otp-challenge-lambda"
    output_path = "${path.module}/otp-challenge-lambda.zip"
  }

  resource "aws_iam_role" "otp_challenge" {
    name = "${var.context.id}-otp-challenge-role"
    assume_role_policy = jsonencode({
      Version = "2012-10-17"
      Statement = [{
        Effect    = "Allow"
        Principal = { Service = "lambda.amazonaws.com" }
        Action    = "sts:AssumeRole"
      }]
    })
    tags = var.context.tags
  }

  resource "aws_iam_role_policy" "otp_challenge_sqs" {
    name = "${var.context.id}-otp-challenge-sqs-policy"
    role = aws_iam_role.otp_challenge.id

    policy = jsonencode({
      Version = "2012-10-17"
      Statement = [{
        Sid      = "SqsSendOtpEvents"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = var.events_queue_arn
      }]
    })
  }

  resource "aws_lambda_function" "otp_challenge" {
    function_name    = "${var.context.id}-otp-challenge"
    runtime          = "nodejs20.x"
    handler          = "index.handler"
    role             = aws_iam_role.otp_challenge.arn
    filename         = data.archive_file.otp_challenge.output_path
    source_code_hash = data.archive_file.otp_challenge.output_base64sha256
    timeout          = 10

    environment {
      variables = {
        EVENTS_QUEUE_URL     = var.events_queue_url
        AWS_ENDPOINT_URL     = var.aws_cli_endpoint_url
        OTP_CODE_TTL_SECONDS = tostring(var.otp_code_ttl_seconds)
        OTP_CODE_LENGTH      = tostring(var.otp_code_length)
      }
    }

    tags = var.context.tags
  }

  resource "aws_lambda_permission" "otp_challenge_cognito" {
    statement_id  = "AllowCognitoInvokeOtpChallenge"
    action        = "lambda:InvokeFunction"
    function_name = aws_lambda_function.otp_challenge.function_name
    principal     = "cognito-idp.amazonaws.com"
    source_arn    = aws_cognito_user_pool.this.arn
  }
  ```

- [ ] **Step 5: Add outputs for the trigger-wiring script (Task 5) to consume.**
  In `infra/modules/cognito/outputs.tf`, add:
  ```hcl
  output "otp_challenge_lambda_arn" {
    description = "ARN of the OTP challenge Lambda (DefineAuthChallenge/CreateAuthChallenge/VerifyAuthChallengeResponse)."
    value       = aws_lambda_function.otp_challenge.arn
  }
  ```

- [ ] **Step 6: Wire the new module inputs from `environments/local/main.tf`.**
  Find the existing `module "cognito" { ... }` block and add the two new required arguments,
  sourced from the already-instantiated `module.messaging`:
  ```hcl
    events_queue_url = module.messaging.queue_url
    events_queue_arn = module.messaging.queue_arn
  ```
  (Insert alongside the module's other inputs — same block, no new module instantiation.)

- [ ] **Step 7: Validate.**
  ```bash
  cd infra && terraform -chdir=modules/cognito validate && terraform -chdir=environments/local validate
  ```
  Expect `Success!` for both.

- [ ] **Step 8: Commit.**
  ```bash
  git add infra/modules/cognito/otp-challenge-lambda infra/modules/cognito/main.tf \
          infra/modules/cognito/variables.tf infra/modules/cognito/outputs.tf \
          infra/environments/local/main.tf
  git commit -m "feat(infra): add the OTP challenge Lambda for CUSTOM_AUTH"
  ```

---

### Task 5: `set_auth_challenge_triggers.py` registering all three triggers

**Files:**
- Create: `infra/modules/cognito/scripts/set_auth_challenge_triggers.py`
- Modify: `infra/modules/cognito/main.tf`

**Interfaces:**
- Consumes: `USER_POOL_ID`, `DEFINE_AUTH_CHALLENGE_LAMBDA_ARN`,
  `CREATE_AUTH_CHALLENGE_LAMBDA_ARN`, `VERIFY_AUTH_CHALLENGE_RESPONSE_LAMBDA_ARN` (all three point
  at the SAME Lambda ARN from Task 4), `ENDPOINT_URL`, `AWS_REGION`, `EXECUTION_LOG_TABLE` env vars.
- Produces: exits 0 with all three `LambdaConfig` keys wired and verified; exits 1 on mismatch.

- [ ] **Step 1: Write the script as a near-copy of `set_pre_token_trigger.py`, setting all three
  keys in one call.**
  Create `infra/modules/cognito/scripts/set_auth_challenge_triggers.py`:
  ```python
  #!/usr/bin/env python3
  """Idempotent Cognito CUSTOM_AUTH trigger wiring via boto3.

  Used ONLY by modules/cognito/main.tf's terraform_data.auth_challenge_triggers,
  the same Floci-only workaround as terraform_data.pre_token_trigger
  (set_pre_token_trigger.py): the AWS provider pinned at 5.31.0 (ADR-0016) has no
  Terraform-native way to express these three LambdaConfig keys, so this script
  registers them directly, outside Terraform's resource lifecycle.

  Sets DefineAuthChallenge, CreateAuthChallenge, and VerifyAuthChallengeResponse
  in ONE update_user_pool call — three separate scripts each reading-modifying-
  writing LambdaConfig would race and clobber each other's key.

  SETTINGS-PRESERVING, same as set_pre_token_trigger.py: UpdateUserPool is a PUT,
  so this reads the current pool, keeps every other top-level setting, injects
  the three trigger keys, and re-applies the whole thing. Schema/custom
  attributes are deliberately NOT touched (create-only).

  Required env vars (set by the calling local-exec provisioner):
    USER_POOL_ID                              - Cognito User Pool id
    DEFINE_AUTH_CHALLENGE_LAMBDA_ARN           - ARN of the DefineAuthChallenge Lambda
    CREATE_AUTH_CHALLENGE_LAMBDA_ARN           - ARN of the CreateAuthChallenge Lambda
    VERIFY_AUTH_CHALLENGE_RESPONSE_LAMBDA_ARN  - ARN of the VerifyAuthChallengeResponse Lambda
    ENDPOINT_URL                               - optional endpoint override
    AWS_REGION                                 - AWS region

  Optional:
    EXECUTION_LOG_TABLE - DynamoDB table recording this run for traceability
                          (lib3mrai.execution_log). Unset = record nothing.
  """

  import os
  import sys

  if "ENDPOINT_URL" in os.environ:
      os.environ["AWS_ENDPOINT_URL"] = os.environ["ENDPOINT_URL"]

  from lib3mrai import aws  # noqa: E402
  from lib3mrai.execution_log import record_execution  # noqa: E402

  PRESERVED_FIELDS = [
      "Policies",
      "DeletionProtection",
      "AutoVerifiedAttributes",
      "VerificationMessageTemplate",
      "SmsAuthenticationMessage",
      "UserAttributeUpdateSettings",
      "MfaConfiguration",
      "DeviceConfiguration",
      "EmailConfiguration",
      "SmsConfiguration",
      "UserPoolTags",
      "AdminCreateUserConfig",
      "UserPoolAddOns",
      "AccountRecoverySetting",
  ]


  def require(name: str) -> str:
      value = os.environ.get(name, "")
      if not value:
          print(f"set_auth_challenge_triggers.py: {name} is required", file=sys.stderr)
          sys.exit(1)
      return value


  class TriggersNotWired(RuntimeError):
      """The post-update verification found one or more triggers absent/mismatched."""


  def main() -> int:
      pool_id = require("USER_POOL_ID")
      define_arn = require("DEFINE_AUTH_CHALLENGE_LAMBDA_ARN")
      create_arn = require("CREATE_AUTH_CHALLENGE_LAMBDA_ARN")
      verify_arn = require("VERIFY_AUTH_CHALLENGE_RESPONSE_LAMBDA_ARN")

      try:
          with record_execution(script="set_auth_challenge_triggers.py", resource_id=pool_id):
              idp = aws.client("cognito-idp")

              pool = idp.describe_user_pool(UserPoolId=pool_id)["UserPool"]

              lambda_config = dict(pool.get("LambdaConfig", {}))
              lambda_config["DefineAuthChallenge"] = define_arn
              lambda_config["CreateAuthChallenge"] = create_arn
              lambda_config["VerifyAuthChallengeResponse"] = verify_arn

              preserved = {
                  field: pool[field]
                  for field in PRESERVED_FIELDS
                  if pool.get(field) not in (None, "", {}, [])
              }
              idp.update_user_pool(
                  UserPoolId=pool_id, LambdaConfig=lambda_config, **preserved
              )

              wired = idp.describe_user_pool(UserPoolId=pool_id)["UserPool"].get(
                  "LambdaConfig", {}
              )
              mismatches = []
              if wired.get("DefineAuthChallenge") != define_arn:
                  mismatches.append("DefineAuthChallenge")
              if wired.get("CreateAuthChallenge") != create_arn:
                  mismatches.append("CreateAuthChallenge")
              if wired.get("VerifyAuthChallengeResponse") != verify_arn:
                  mismatches.append("VerifyAuthChallengeResponse")

              if mismatches:
                  print(
                      f"set_auth_challenge_triggers.py: FAILED — not wired: {', '.join(mismatches)}",
                      file=sys.stderr,
                  )
                  raise TriggersNotWired(f"triggers not wired: {', '.join(mismatches)}")
      except TriggersNotWired:
          return 1

      print(
          f"set_auth_challenge_triggers.py: wired all three CUSTOM_AUTH triggers on "
          f"{pool_id} (existing pool settings preserved)"
      )
      return 0


  if __name__ == "__main__":
      sys.exit(main())
  ```

- [ ] **Step 2: Wire the `terraform_data` provisioner in `main.tf`.**
  Append after the `terraform_data.pre_token_trigger` block:
  ```hcl
  resource "terraform_data" "auth_challenge_triggers" {
    depends_on = [aws_lambda_permission.otp_challenge_cognito]

    input = {
      user_pool_id = aws_cognito_user_pool.this.id
      lambda_arn   = aws_lambda_function.otp_challenge.arn
    }

    provisioner "local-exec" {
      command     = "${var.python_bin} ${path.module}/scripts/set_auth_challenge_triggers.py"
      interpreter = ["/usr/bin/env", "bash", "-c"]
      environment = {
        USER_POOL_ID                             = self.input.user_pool_id
        DEFINE_AUTH_CHALLENGE_LAMBDA_ARN          = self.input.lambda_arn
        CREATE_AUTH_CHALLENGE_LAMBDA_ARN          = self.input.lambda_arn
        VERIFY_AUTH_CHALLENGE_RESPONSE_LAMBDA_ARN = self.input.lambda_arn
        ENDPOINT_URL                              = var.aws_cli_endpoint_url
        AWS_REGION                                = var.region
        EXECUTION_LOG_TABLE                       = var.execution_log_table
      }
    }
  }
  ```

- [ ] **Step 3: Validate.**
  ```bash
  cd infra && terraform -chdir=modules/cognito validate
  .venv/bin/python -m py_compile infra/modules/cognito/scripts/set_auth_challenge_triggers.py
  ```
  Expect `Success!` and no compile output.

- [ ] **Step 4: Commit.**
  ```bash
  git add infra/modules/cognito/scripts/set_auth_challenge_triggers.py infra/modules/cognito/main.tf
  git commit -m "feat(infra): register the three CUSTOM_AUTH triggers on the Cognito pool"
  ```

---

### Task 6: `auth-otp` email template + catalog entry (on the existing `EmailLayout`)

**Files:**
- Create: `functions/events-pipeline/emails/auth-otp.tsx`
- Modify: `functions/events-pipeline/src/email/catalog.ts`
- Modify: `functions/events-pipeline/tests/email/catalog.test.ts` (verify it already iterates the
  catalog generically — no per-template edit needed there, confirm in Step 1)

**Interfaces:**
- Produces: default-exported `AuthOtpEmail`, props `AuthOtpEmailProps { code: string; ttlMinutes: number }`.

- [ ] **Step 1: Read `tests/email/catalog.test.ts` to confirm it iterates `catalog` generically.**
  ```bash
  cat functions/events-pipeline/tests/email/catalog.test.ts
  ```
  Confirm it loops `Object.entries(catalog)` and renders each entry's `component` with its
  `sampleProps` — if so, no edit is needed there; adding a catalog entry with `sampleProps` is
  sufficient for this test to cover the new template automatically.

- [ ] **Step 2: Write the template.**
  Create `functions/events-pipeline/emails/auth-otp.tsx`:
  ```tsx
  import { Heading, Text } from "@react-email/components";
  import { EmailLayout } from "./components/layout.tsx";

  export interface AuthOtpEmailProps {
    code: string;
    ttlMinutes: number;
  }

  // Default export (react-email's `email dev` previews the default export); the
  // catalog imports the same symbol, so preview and production render the
  // identical component. Built on the EXISTING plain EmailLayout — branding
  // templates do not exist on this branch, and this template has no dependency
  // on that work landing first.
  //
  // The code is rendered as plain visible text (not an image, not obfuscated) —
  // deliberately, so the gateway E2E spec (Task 15) can extract it from the
  // message body without OCR or fragile markup scraping.
  export default function AuthOtpEmail({ code, ttlMinutes }: AuthOtpEmailProps) {
    return (
      <EmailLayout>
        <Heading>Your one-time code</Heading>
        <Text>Use this code to sign in. It expires in {ttlMinutes} minutes.</Text>
        <Text style={{ fontSize: "28px", fontWeight: "bold", letterSpacing: "4px" }}>{code}</Text>
        <Text>If you did not request this, you can safely ignore this email.</Text>
      </EmailLayout>
    );
  }
  ```

- [ ] **Step 3: Register the catalog entry.**
  In `functions/events-pipeline/src/email/catalog.ts`, add the import at the top:
  ```typescript
  import AuthOtpEmail, { type AuthOtpEmailProps } from "../../emails/auth-otp.tsx";
  ```
  Add the entry inside the `catalog` object, alongside the existing ones:
  ```typescript
    "auth-otp": defineTemplate<AuthOtpEmailProps>({
      component: AuthOtpEmail,
      sampleProps: { code: "042817", ttlMinutes: 5 },
    }),
  ```

- [ ] **Step 4: Run the catalog test, expect PASS (it renders every entry generically).**
  ```bash
  cd functions/events-pipeline && nvm use && npm test -- catalog.test.ts
  ```
  Expect all catalog entries, including `auth-otp`, to render without throwing.

- [ ] **Step 5: Commit.**
  ```bash
  git add functions/events-pipeline/emails/auth-otp.tsx functions/events-pipeline/src/email/catalog.ts
  git commit -m "feat(events-pipeline): add the auth-otp email template"
  ```

---

### Task 7: `AUTH_OTP_REQUESTED` handler + dispatch entry

**Files:**
- Create: `functions/events-pipeline/src/handlers/auth-otp-requested.ts`
- Create: `functions/events-pipeline/tests/handlers/auth-otp-requested.test.ts`
- Modify: `functions/events-pipeline/src/handlers/index.ts`

**Interfaces:**
- Consumes: `Envelope` with `payload: { email: string; code: string; ttlSeconds: number }`.
- Produces: `authOtpRequestedHandler(envelope: Envelope): Promise<void>`.

- [ ] **Step 1: Write the failing unit test.**
  Create `functions/events-pipeline/tests/handlers/auth-otp-requested.test.ts`:
  ```typescript
  import { describe, it, expect, vi, beforeEach } from "vitest";
  import { authOtpRequestedHandler } from "#handlers/auth-otp-requested";
  import { PermanentError } from "#pipeline/errors";
  import type { Envelope } from "#domain/envelope";

  vi.mock("#email/sender", () => ({ sendEmail: vi.fn(async () => undefined) }));
  import { sendEmail } from "#email/sender";

  function envelope(payload: Record<string, unknown>): Envelope {
    return {
      event_id: "evt_1",
      type: "AUTH_OTP_REQUESTED",
      source: "users",
      user_id: "usr_1",
      order_id: null,
      author: { actor: "cognito:create_auth_challenge" },
      payload,
    };
  }

  describe("authOtpRequestedHandler", () => {
    beforeEach(() => vi.clearAllMocks());

    it("sends the OTP email to the recipient with the code rendered in the body", async () => {
      await authOtpRequestedHandler(
        envelope({ email: "user@example.com", code: "042817", ttlSeconds: 300 }),
      );

      expect(sendEmail).toHaveBeenCalledOnce();
      const call = vi.mocked(sendEmail).mock.calls[0]![0];
      expect(call.to).toBe("user@example.com");
      expect(call.html).toContain("042817");
    });

    it("throws PermanentError on an invalid payload and does not call sendEmail", async () => {
      await expect(
        authOtpRequestedHandler(envelope({ email: "not-an-email", code: "1", ttlSeconds: 300 })),
      ).rejects.toBeInstanceOf(PermanentError);
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it("does not leak the email address in the PermanentError message", async () => {
      try {
        await authOtpRequestedHandler(
          envelope({ email: "leaky@example.com", code: "1", ttlSeconds: 300 }),
        );
        expect.unreachable("expected a PermanentError to be thrown");
      } catch (err) {
        expect((err as Error).message).not.toContain("leaky@example.com");
      }
    });
  });
  ```
  Run it now:
  ```bash
  cd functions/events-pipeline && nvm use && npm test -- auth-otp-requested.test.ts
  ```
  Expect **FAIL** with `Cannot find module '#handlers/auth-otp-requested'`.

- [ ] **Step 2: Write the handler.**
  Create `functions/events-pipeline/src/handlers/auth-otp-requested.ts`:
  ```typescript
  import { z } from "zod";
  import type { Envelope } from "#domain/envelope";
  import { renderTemplate } from "#email/renderer";
  import { sendEmail } from "#email/sender";
  import { PermanentError } from "#pipeline/errors";

  const AuthOtpRequestedPayloadSchema = z.object({
    email: z.string().email(),
    code: z.string().min(1),
    ttlSeconds: z.number().positive(),
  });

  // Mirrors userCreatedHandler's flow: validate (Zod) -> render -> send. The
  // code reaches this handler via the envelope's payload, exactly as it does
  // for every other event type — it is the REDACTED, persisted copy of that
  // payload (see redactPayload in Task 8) that never carries it, not this
  // in-memory one.
  export async function authOtpRequestedHandler(envelope: Envelope): Promise<void> {
    const result = AuthOtpRequestedPayloadSchema.safeParse(envelope.payload);

    if (!result.success) {
      // Only FIELD PATHS are reported, never Zod's own message — it echoes the
      // offending input, which here would be the OTP code itself, not just an
      // email. This string is persisted on the (already-redacted) event
      // document and logged as `reason` (see src/handler.ts), so it must be
      // PII/credential-free by construction.
      const fields = result.error.issues.map((issue) => issue.path.join(".")).join(", ");
      throw new PermanentError(`invalid AUTH_OTP_REQUESTED payload: invalid fields: ${fields}`);
    }

    const ttlMinutes = Math.round(result.data.ttlSeconds / 60);
    const html = await renderTemplate("auth-otp", { code: result.data.code, ttlMinutes });

    await sendEmail({
      to: result.data.email,
      subject: "Your one-time code",
      html,
    });
  }
  ```

- [ ] **Step 3: Register the dispatch entry.**
  In `functions/events-pipeline/src/handlers/index.ts`:
  ```typescript
  import type { HandlerMap } from "#pipeline/process-record";
  import { userCreatedHandler } from "#handlers/user-created";
  import { orderCreatedHandler } from "#handlers/order-created";
  import { trackingStatusChangedHandler } from "#handlers/tracking-status-changed";
  import { authOtpRequestedHandler } from "#handlers/auth-otp-requested";

  export const handlers: HandlerMap = {
    USER_CREATED: userCreatedHandler,
    ORDER_CREATED: orderCreatedHandler,
    TRACKING_STATUS_CHANGED: trackingStatusChangedHandler,
    AUTH_OTP_REQUESTED: authOtpRequestedHandler,
  };
  ```

- [ ] **Step 4: Run the test, expect PASS.**
  ```bash
  cd functions/events-pipeline && nvm use && npm test -- auth-otp-requested.test.ts
  ```
  Expect all three tests to pass.

- [ ] **Step 5: Run the full events-pipeline suite.**
  ```bash
  cd functions/events-pipeline && nvm use && npm test
  ```
  Expect all tests green, including the existing `handlers/index.ts` consumers.

- [ ] **Step 6: Commit.**
  ```bash
  git add functions/events-pipeline/src/handlers/auth-otp-requested.ts \
          functions/events-pipeline/tests/handlers/auth-otp-requested.test.ts \
          functions/events-pipeline/src/handlers/index.ts
  git commit -m "feat(events-pipeline): dispatch AUTH_OTP_REQUESTED to the auth-otp template"
  ```

---

### Task 8: `redactPayload()` applied at `process-record.ts:69` + test proving the code is absent from the persisted doc but present in the handler's envelope

**Files:**
- Create: `functions/events-pipeline/src/domain/redact-payload.ts`
- Create: `functions/events-pipeline/tests/domain/redact-payload.test.ts`
- Modify: `functions/events-pipeline/src/pipeline/process-record.ts`
- Modify: `functions/events-pipeline/tests/pipeline/process-record.test.ts` (add the
  redaction-specific assertion; existing tests must keep passing unchanged)

**Interfaces:**
- Produces: `redactPayload(type: string, payload: Record<string, unknown>):
  Record<string, unknown>` — pure function, no I/O.
- Consumes: called from `processRecord` at the point `doc.payload` is built, BEFORE
  `insertStarted`; the handler is still invoked with the original, unredacted `envelope`.

- [ ] **Step 1: Write the failing unit test for `redactPayload` itself.**
  Create `functions/events-pipeline/tests/domain/redact-payload.test.ts`:
  ```typescript
  import { describe, it, expect } from "vitest";
  import { redactPayload } from "#domain/redact-payload";

  describe("redactPayload", () => {
    it("removes the code field from an AUTH_OTP_REQUESTED payload", () => {
      const result = redactPayload("AUTH_OTP_REQUESTED", {
        email: "user@example.com",
        code: "042817",
        ttlSeconds: 300,
      });

      expect(result).not.toHaveProperty("code");
      expect(result.email).toBe("user@example.com");
      expect(result.ttlSeconds).toBe(300);
    });

    it("leaves a non-AUTH_OTP_REQUESTED payload untouched", () => {
      const payload = { email: "user@example.com", fullName: "Ada Lovelace" };
      const result = redactPayload("USER_CREATED", payload);

      expect(result).toEqual(payload);
    });

    it("does not mutate the original payload object", () => {
      const original = { email: "user@example.com", code: "042817", ttlSeconds: 300 };
      redactPayload("AUTH_OTP_REQUESTED", original);

      expect(original.code).toBe("042817");
    });
  });
  ```
  Run it now:
  ```bash
  cd functions/events-pipeline && nvm use && npm test -- redact-payload.test.ts
  ```
  Expect **FAIL** with `Cannot find module '#domain/redact-payload'`.

- [ ] **Step 2: Write `redactPayload`.**
  Create `functions/events-pipeline/src/domain/redact-payload.ts`:
  ```typescript
  // Applied ONCE, at the exact point process-record.ts builds the document it
  // persists to DocumentDB (doc.payload = ...), never at the envelope the
  // handler receives later. Every other event type persists its payload
  // verbatim (the audit trail, by design) — AUTH_OTP_REQUESTED is the one
  // exception: a live, unexpired OTP code sitting in the events collection
  // would be a second, weaker copy of the authentication surface. See
  // docs/superpowers/specs/2026-08-05-passwordless-otp-auth-design.md's
  // "Email delivery" section.
  //
  // A per-type map (rather than a blanket "strip any field named code") keeps
  // this explicit and auditable: adding a new event type never accidentally
  // redacts a legitimate field just because it happens to share a name.
  const REDACTED_FIELDS: Record<string, readonly string[]> = {
    AUTH_OTP_REQUESTED: ["code"],
  };

  export function redactPayload(
    type: string,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    const fields = REDACTED_FIELDS[type];
    if (!fields || fields.length === 0) return payload;

    const redacted = { ...payload };
    for (const field of fields) {
      delete redacted[field];
    }
    return redacted;
  }
  ```

- [ ] **Step 3: Run the `redactPayload` test, expect PASS.**
  ```bash
  cd functions/events-pipeline && nvm use && npm test -- redact-payload.test.ts
  ```
  Expect all three tests to pass.

- [ ] **Step 4: Write the failing integration-level test on `processRecord` proving the persisted
  doc is redacted while the handler still sees the real code.**
  Open `functions/events-pipeline/tests/pipeline/process-record.test.ts` and add (using whatever
  fake `EventsRepositoryPort`/`HandlerMap` helpers the existing tests in that file already use —
  read the file first to match its exact fixture style, then add):
  ```typescript
  it("persists AUTH_OTP_REQUESTED with the code redacted, but hands the handler the real code", async () => {
    const insertedDocs: EventDocument[] = [];
    const repository: EventsRepositoryPort = {
      insertStarted: async (doc) => {
        insertedDocs.push(doc);
      },
      transition: async () => {},
    };
    let handlerSawCode: unknown;
    const handlers: HandlerMap = {
      AUTH_OTP_REQUESTED: async (envelope) => {
        handlerSawCode = (envelope.payload as { code: unknown }).code;
      },
    };
    const envelope: Envelope = {
      event_id: "evt_otp_1",
      type: "AUTH_OTP_REQUESTED",
      source: "users",
      user_id: "usr_1",
      order_id: null,
      author: { actor: "cognito:create_auth_challenge" },
      payload: { email: "user@example.com", code: "042817", ttlSeconds: 300 },
    };

    const result = await processRecord(envelope, { repository, handlers });

    expect(result.ok).toBe(true);
    expect(insertedDocs).toHaveLength(1);
    expect(insertedDocs[0]!.payload).not.toHaveProperty("code");
    expect(insertedDocs[0]!.payload.email).toBe("user@example.com");
    expect(handlerSawCode).toBe("042817");
  });
  ```
  Run it now:
  ```bash
  cd functions/events-pipeline && nvm use && npm test -- process-record.test.ts
  ```
  Expect **FAIL**: `insertedDocs[0]!.payload` still has the `code` property, because
  `process-record.ts` has not been changed yet.

- [ ] **Step 5: Apply `redactPayload` at the exact point `doc.payload` is built.**
  In `functions/events-pipeline/src/pipeline/process-record.ts`, add the import:
  ```typescript
  import { redactPayload } from "#domain/redact-payload";
  ```
  Change the line that currently reads:
  ```typescript
      payload: envelope.payload,
  ```
  to:
  ```typescript
      payload: redactPayload(envelope.type, envelope.payload),
  ```
  Everything downstream of this — `deps.handlers[envelope.type](envelope)` — continues to receive
  the original, untouched `envelope`, not `doc`, so the handler (Task 7) still sees the real code.

- [ ] **Step 6: Run both new tests plus the full pipeline suite, expect PASS.**
  ```bash
  cd functions/events-pipeline && nvm use && npm test
  ```
  Expect all tests green, including the pre-existing `process-record.test.ts` cases (which use
  event types with no entry in `REDACTED_FIELDS`, so `redactPayload` is a no-op for them and their
  assertions on `doc.payload` are unaffected).

- [ ] **Step 7: Commit.**
  ```bash
  git add functions/events-pipeline/src/domain/redact-payload.ts \
          functions/events-pipeline/tests/domain/redact-payload.test.ts \
          functions/events-pipeline/src/pipeline/process-record.ts \
          functions/events-pipeline/tests/pipeline/process-record.test.ts
  git commit -m "feat(events-pipeline): redact the OTP code before persisting the event document"
  ```

---

### Task 9: `AuthProvider.startOtpChallenge`/`respondToOtpChallenge` + commands + routes + schemas + public-routes + openapi regen

**Files:**
- Modify: `services/users/src/shared/auth/auth-provider.ts`
- Modify: `services/users/src/shared/auth/cognito-auth-provider.ts`
- Modify: `services/users/src/shared/auth/auth-errors.ts`
- Create: `services/users/src/features/users/commands/start-otp-challenge.ts`
- Create: `services/users/src/features/users/commands/verify-otp-challenge.ts`
- Create: `services/users/tests/features/users/commands/start-otp-challenge.test.ts`
- Create: `services/users/tests/features/users/commands/verify-otp-challenge.test.ts`
- Modify: `services/users/src/shared/di/awilix-container.ts`
- Modify: `services/users/src/features/users/http/schemas.ts`
- Modify: `services/users/src/features/users/http/routes.ts`
- Modify: `services/users/src/shared/http/public-routes.ts`
- Modify: `services/users/tests/features/users/http/routes.test.ts`
- Modify: `services/users/openapi.yaml` (regenerated)

**Interfaces:**
- Produces: `AuthProvider.startOtpChallenge(email: string): Promise<{ session: string }>`;
  `AuthProvider.respondToOtpChallenge(email: string, session: string, code: string):
  Promise<AuthTokens>`; `InvalidOtpError extends AuthError` (401, `invalid_otp`);
  `StartOtpChallengeCommand.execute({ email }): Promise<{ session: string }>`;
  `VerifyOtpChallengeCommand.execute({ email, session, code }): Promise<AuthTokens>`;
  `POST /v1/users/otp/start`, `POST /v1/users/otp/verify`.

- [ ] **Step 1: Add the two methods to the `AuthProvider` interface.**
  In `services/users/src/shared/auth/auth-provider.ts`, add to the `AuthProvider` interface:
  ```typescript
  export interface AuthProvider {
    signUp(email: string, password: string, appUserId: string): Promise<CognitoSignUpResult>;
    login(email: string, password: string): Promise<AuthTokens>;
    refresh(refreshToken: string): Promise<RefreshedTokens>;
    startOtpChallenge(email: string): Promise<{ session: string }>;
    respondToOtpChallenge(email: string, session: string, code: string): Promise<AuthTokens>;
  }
  ```

- [ ] **Step 2: Add `InvalidOtpError` to `auth-errors.ts`.**
  ```typescript
  export class InvalidOtpError extends AuthError {
    constructor() {
      super("invalid or expired one-time code", 401, "invalid_otp");
    }
  }
  ```
  No `setErrorHandler` change is needed in `routes.ts` — it already maps any `AuthError`
  subclass generically.

- [ ] **Step 3: Implement both methods on `CognitoAuthProvider`.**
  In `services/users/src/shared/auth/cognito-auth-provider.ts`, add the imports:
  ```typescript
  import {
    AdminCreateUserCommand,
    AdminSetUserPasswordCommand,
    AdminInitiateAuthCommand,
    RespondToAuthChallengeCommand,
    type CognitoIdentityProviderClient,
  } from "@aws-sdk/client-cognito-identity-provider";
  import type { AuthProvider, AuthTokens, CognitoSignUpResult, RefreshedTokens } from "./auth-provider.ts";
  import { InvalidCredentialsError, EmailAlreadyExistsError, InvalidOtpError } from "./auth-errors.ts";
  ```
  Add the two methods to the class body:
  ```typescript
    async startOtpChallenge(email: string): Promise<{ session: string }> {
      let res;
      try {
        res = await this.client.send(
          new AdminInitiateAuthCommand({
            UserPoolId: this.userPoolId,
            ClientId: this.clientId,
            AuthFlow: "CUSTOM_AUTH",
            AuthParameters: { USERNAME: email },
          }),
        );
      } catch (e: any) {
        if (e?.name === "UserNotFoundException") throw new InvalidCredentialsError();
        throw e;
      }
      if (!res.Session) throw new Error(`CUSTOM_AUTH InitiateAuth returned no session for ${email}`);
      return { session: res.Session };
    }

    async respondToOtpChallenge(email: string, session: string, code: string): Promise<AuthTokens> {
      let res;
      try {
        res = await this.client.send(
          new RespondToAuthChallengeCommand({
            ClientId: this.clientId,
            ChallengeName: "CUSTOM_CHALLENGE",
            Session: session,
            ChallengeResponses: { USERNAME: email, ANSWER: code },
          }),
        );
      } catch (e: any) {
        if (e?.name === "NotAuthorizedException" || e?.name === "UserNotFoundException") {
          throw new InvalidOtpError();
        }
        throw e;
      }
      if (!res.AuthenticationResult) {
        // Cognito accepted the answer but the flow is not complete (e.g.
        // returned a further challenge) — treated the same as an invalid code:
        // the caller gets no tokens either way, and this codebase has no
        // multi-step CUSTOM_AUTH beyond the single code challenge.
        throw new InvalidOtpError();
      }
      const r = res.AuthenticationResult;
      return {
        idToken: r.IdToken ?? "",
        accessToken: r.AccessToken ?? "",
        refreshToken: r.RefreshToken ?? "",
      };
    }
  ```

- [ ] **Step 4: Write the failing unit test for `StartOtpChallengeCommand`.**
  Create `services/users/tests/features/users/commands/start-otp-challenge.test.ts`:
  ```typescript
  import { describe, it, expect, vi } from "vitest";
  import { StartOtpChallengeCommand } from "#features/users/commands/start-otp-challenge";

  function deps(overrides: Partial<{ startOtpChallenge: any }> = {}) {
    return {
      auth: {
        startOtpChallenge: vi.fn(async () => ({ session: "sess_abc" })),
        ...overrides,
      },
    };
  }

  describe("StartOtpChallengeCommand", () => {
    it("returns the session from the auth provider", async () => {
      const command = new StartOtpChallengeCommand(deps() as any);
      const result = await command.execute({ email: "a@b.co" });
      expect(result).toEqual({ session: "sess_abc" });
    });

    it("propagates the auth provider's error untouched", async () => {
      const failing = deps({
        startOtpChallenge: vi.fn(async () => {
          throw new Error("cognito down");
        }),
      });
      const command = new StartOtpChallengeCommand(failing as any);
      await expect(command.execute({ email: "a@b.co" })).rejects.toThrow("cognito down");
    });
  });
  ```
  Run it now:
  ```bash
  cd services/users && nvm use && pnpm test -- start-otp-challenge.test.ts
  ```
  Expect **FAIL** with `Cannot find module '#features/users/commands/start-otp-challenge'`.

- [ ] **Step 5: Write `StartOtpChallengeCommand`, mirroring `login.ts`'s logging shape.**
  Create `services/users/src/features/users/commands/start-otp-challenge.ts`:
  ```typescript
  import type { AuthProvider } from "#shared/auth/auth-provider";
  import { appLogger } from "#shared/logging/app-logger";
  import { setLogContext } from "#shared/logging/log-context";
  import { hashEmail } from "#shared/logging/email-hash";
  import { maskEmail } from "#shared/logging/email-mask";

  export interface StartOtpChallengeInput {
    email: string;
  }

  export interface StartOtpChallengeResult {
    session: string;
  }

  // Constructor-injected from the Awilix cradle (PROXY injection mode).
  export class StartOtpChallengeCommand {
    private readonly auth: AuthProvider;

    constructor({ auth }: { auth: AuthProvider }) {
      this.auth = auth;
    }

    async execute(input: StartOtpChallengeInput): Promise<StartOtpChallengeResult> {
      setLogContext({ email_hash: hashEmail(input.email) });
      appLogger.info(
        { app_event: "otp_start_started", email: maskEmail(input.email) },
        "Starting OTP challenge",
      );

      try {
        const result = await this.auth.startOtpChallenge(input.email);
        // The session token is opaque and short-lived but is still a
        // credential-adjacent value (it is what respondToOtpChallenge trades
        // for tokens) — never logged, same treatment as AuthTokens in login.ts.
        appLogger.info(
          { app_event: "otp_start_succeeded", email: maskEmail(input.email) },
          "OTP challenge started",
        );
        return result;
      } catch (err) {
        appLogger.error(
          { err, app_event: "otp_start_failed", email: maskEmail(input.email), reason: "cognito_error" },
          "OTP challenge start failed: the identity provider rejected the request",
        );
        throw err;
      }
    }
  }
  ```

- [ ] **Step 6: Run the test, expect PASS.**
  ```bash
  cd services/users && nvm use && pnpm test -- start-otp-challenge.test.ts
  ```
  Expect both tests to pass.

- [ ] **Step 7: Write the failing unit test for `VerifyOtpChallengeCommand`.**
  Create `services/users/tests/features/users/commands/verify-otp-challenge.test.ts`:
  ```typescript
  import { describe, it, expect, vi } from "vitest";
  import { VerifyOtpChallengeCommand } from "#features/users/commands/verify-otp-challenge";
  import { InvalidOtpError } from "#shared/auth/auth-errors";

  const TOKENS = { idToken: "id1", accessToken: "acc1", refreshToken: "rt1" };

  function deps(overrides: Partial<{ respondToOtpChallenge: any }> = {}) {
    return {
      auth: {
        respondToOtpChallenge: vi.fn(async () => TOKENS),
        ...overrides,
      },
    };
  }

  describe("VerifyOtpChallengeCommand", () => {
    it("returns AuthTokens on a correct code", async () => {
      const command = new VerifyOtpChallengeCommand(deps() as any);
      const result = await command.execute({ email: "a@b.co", session: "sess_1", code: "042817" });
      expect(result).toEqual(TOKENS);
    });

    it("rethrows InvalidOtpError untouched on an incorrect code", async () => {
      const failing = deps({
        respondToOtpChallenge: vi.fn(async () => {
          throw new InvalidOtpError();
        }),
      });
      const command = new VerifyOtpChallengeCommand(failing as any);
      await expect(
        command.execute({ email: "a@b.co", session: "sess_1", code: "000000" }),
      ).rejects.toBeInstanceOf(InvalidOtpError);
    });

    it("never logs the submitted code", async () => {
      const { appLogger } = await import("#shared/logging/app-logger");
      const calls: unknown[] = [];
      const infoSpy = vi.spyOn(appLogger, "info").mockImplementation(((...args: unknown[]) => {
        calls.push(args);
      }) as never);
      const errorSpy = vi.spyOn(appLogger, "error").mockImplementation(((...args: unknown[]) => {
        calls.push(args);
      }) as never);

      const command = new VerifyOtpChallengeCommand(deps() as any);
      await command.execute({ email: "a@b.co", session: "sess_1", code: "042817" });

      const serialized = JSON.stringify(calls);
      expect(serialized).not.toContain("042817");

      infoSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });
  ```
  Run it now:
  ```bash
  cd services/users && nvm use && pnpm test -- verify-otp-challenge.test.ts
  ```
  Expect **FAIL** with `Cannot find module '#features/users/commands/verify-otp-challenge'`.

- [ ] **Step 8: Write `VerifyOtpChallengeCommand`.**
  Create `services/users/src/features/users/commands/verify-otp-challenge.ts`:
  ```typescript
  import type { AuthProvider, AuthTokens } from "#shared/auth/auth-provider";
  import { InvalidOtpError } from "#shared/auth/auth-errors";
  import { appLogger } from "#shared/logging/app-logger";
  import { setLogContext } from "#shared/logging/log-context";
  import { hashEmail } from "#shared/logging/email-hash";
  import { maskEmail } from "#shared/logging/email-mask";

  export interface VerifyOtpChallengeInput {
    email: string;
    session: string;
    code: string;
  }

  // Constructor-injected from the Awilix cradle (PROXY injection mode).
  export class VerifyOtpChallengeCommand {
    private readonly auth: AuthProvider;

    constructor({ auth }: { auth: AuthProvider }) {
      this.auth = auth;
    }

    async execute(input: VerifyOtpChallengeInput): Promise<AuthTokens> {
      setLogContext({ email_hash: hashEmail(input.email) });
      appLogger.info(
        { app_event: "otp_verify_started", email: maskEmail(input.email) },
        "Starting OTP verification",
      );

      try {
        // NOTE: `input.code` and `input.session` are deliberately never passed
        // to a log call anywhere in this method — the OTP code is a live
        // credential for its whole TTL (see the plan's Global Constraints).
        const tokens = await this.auth.respondToOtpChallenge(input.email, input.session, input.code);
        appLogger.info(
          { app_event: "otp_verify_succeeded", email: maskEmail(input.email) },
          "OTP verification completed",
        );
        return tokens;
      } catch (err) {
        const invalid = err instanceof InvalidOtpError;
        appLogger.error(
          {
            err,
            app_event: "otp_verify_failed",
            email: maskEmail(input.email),
            reason: invalid ? "invalid_otp" : "cognito_error",
          },
          invalid
            ? "OTP verification failed: invalid or expired code"
            : "OTP verification failed: the identity provider rejected the request",
        );
        throw err;
      }
    }
  }
  ```

- [ ] **Step 9: Run both new command tests, expect PASS.**
  ```bash
  cd services/users && nvm use && pnpm test -- start-otp-challenge.test.ts verify-otp-challenge.test.ts
  ```
  Expect all tests, including the "never logs the submitted code" one, to pass.

- [ ] **Step 10: Register both commands in the Awilix container.**
  In `services/users/src/shared/di/awilix-container.ts`, add imports:
  ```typescript
  import { StartOtpChallengeCommand } from "#features/users/commands/start-otp-challenge";
  import { VerifyOtpChallengeCommand } from "#features/users/commands/verify-otp-challenge";
  ```
  Add both to the ambient `Cradle` interface:
  ```typescript
    startOtpChallengeCommand: StartOtpChallengeCommand;
    verifyOtpChallengeCommand: VerifyOtpChallengeCommand;
  ```
  Add both to `registerServices()`:
  ```typescript
      startOtpChallengeCommand: asClass(StartOtpChallengeCommand, { lifetime: Lifetime.SCOPED }),
      verifyOtpChallengeCommand: asClass(VerifyOtpChallengeCommand, { lifetime: Lifetime.SCOPED }),
  ```

- [ ] **Step 11: Add the request/response schemas.**
  In `services/users/src/features/users/http/schemas.ts`, add:
  ```typescript
  export const OtpStartInputSchema = z.object({
    email: z.string().email(),
  });

  export const OtpStartResponseSchema = z.object({
    session: z.string(),
  });

  export const OtpVerifyInputSchema = z.object({
    email: z.string().email(),
    session: z.string().min(1),
    code: z.string().length(6).regex(/^\d{6}$/, "code must be 6 digits"),
  });
  ```
  Register them alongside the existing request-body registrations, at the bottom of the file:
  ```typescript
  z.globalRegistry.add(OtpStartInputSchema, { id: "OtpStart" });
  z.globalRegistry.add(OtpVerifyInputSchema, { id: "OtpVerify" });
  ```
  (`OtpStartResponseSchema` and `AuthTokensSchema` — reused as-is for the verify response — do
  not need a new response registration; `AuthTokensSchema` is already registered.)

- [ ] **Step 12: Add both routes in `routes.ts`, inside the existing `app.after(() => { ... })`.**
  Add the import at the top alongside the other schema imports:
  ```typescript
  import {
    RegisterInputSchema, LoginInputSchema, UpdateProfileInputSchema,
    RefreshInputSchema, RefreshedTokensSchema,
    OtpStartInputSchema, OtpStartResponseSchema, OtpVerifyInputSchema,
    UserSchema, AuthTokensSchema, ErrorSchema,
    HealthResponseSchema, E2ECleanupResponseSchema,
    UserIdHeader, WebhookSecretHeader,
  } from "./schemas.ts";
  ```
  Add the two routes, right after the existing `r.post("/v1/users/refresh", ...)` block:
  ```typescript
      r.post("/v1/users/otp/start", {
        schema: {
          tags: ["users"], operationId: "startOtpChallenge",
          summary: "Start an OTP login challenge (password or passwordless users)",
          body: OtpStartInputSchema,
          response: { 200: OtpStartResponseSchema, 401: ErrorSchema },
        },
      }, async (req, reply) => {
        const { startOtpChallengeCommand } = req.diScope.cradle;
        const result = await startOtpChallengeCommand.execute(req.body);
        return reply.send(result);
      });

      r.post("/v1/users/otp/verify", {
        schema: {
          tags: ["users"], operationId: "verifyOtpChallenge",
          summary: "Verify an OTP code and obtain tokens",
          body: OtpVerifyInputSchema,
          response: { 200: AuthTokensSchema, 401: ErrorSchema },
        },
      }, async (req, reply) => {
        const { verifyOtpChallengeCommand } = req.diScope.cradle;
        const tokens = await verifyOtpChallengeCommand.execute(req.body);
        return reply.send(tokens);
      });
  ```

- [ ] **Step 13: Add both routes to `public-routes.ts`'s `EXACT` allowlist.**
  In `services/users/src/shared/http/public-routes.ts`:
  ```typescript
  const EXACT: ReadonlyArray<{ method: string; path: string }> = [
    { method: "GET", path: "/v1/health" },
    { method: "POST", path: "/v1/users/login" },
    { method: "POST", path: "/v1/users/register" },
    { method: "POST", path: "/v1/users/refresh" },
    { method: "POST", path: "/v1/users/otp/start" },
    { method: "POST", path: "/v1/users/otp/verify" },
    { method: "DELETE", path: "/v1/users/e2e-cleanup" },
  ];
  ```

- [ ] **Step 14: Write failing route tests for both new endpoints in `routes.test.ts`.**
  In `services/users/tests/features/users/http/routes.test.ts`, first extend `testContainer()` to
  register the two new command keys (mocked), or every route test fails on resolution once
  `routes.ts` references them:
  ```typescript
  function testContainer(e2eEnabled: boolean) {
    const container = createContainer({ injectionMode: "PROXY" });
    container.register({
      db: asValue({ user: { findByIdOrCognitoSub: vi.fn(async () => null) } } as any),
      env: asValue({ E2E_TESTING_ENABLED: e2eEnabled } as any),
      registerUserCommand: asValue({
        execute: vi.fn(async (input: any) =>
          fakeUser({ id: "usr_1", tags: input.e2eSource ? ["E2E Source"] : [] }),
        ),
      } as any),
      loginUserCommand: asValue({ execute: vi.fn() } as any),
      startOtpChallengeCommand: asValue({ execute: vi.fn(async () => ({ session: "sess_1" })) } as any),
      verifyOtpChallengeCommand: asValue({
        execute: vi.fn(async () => ({ idToken: "id1", accessToken: "acc1", refreshToken: "rt1" })),
      } as any),
      userQueryService: asValue({ getMe: vi.fn(), getUserById: vi.fn() } as any),
      updateProfileCommand: asValue({ execute: vi.fn() } as any),
      e2eCleanupCommand: asValue({ execute: vi.fn(async () => ({ count: 3 })) } as any),
    });
    return container;
  }
  ```
  Then add the new tests, near the existing `/v1/users/login`/`/v1/users/refresh` tests:
  ```typescript
  it("POST /v1/users/otp/start returns 200 with a session", async () => {
    const app = buildApp(testContainer(false));
    const res = await app.inject({
      method: "POST", url: "/v1/users/otp/start",
      payload: { email: "a@b.co" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ session: "sess_1" });
  });

  it("POST /v1/users/otp/verify returns 200 with AuthTokens on a correct code", async () => {
    const app = buildApp(testContainer(false));
    const res = await app.inject({
      method: "POST", url: "/v1/users/otp/verify",
      payload: { email: "a@b.co", session: "sess_1", code: "042817" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ idToken: "id1", accessToken: "acc1", refreshToken: "rt1" });
  });

  it("POST /v1/users/otp/verify returns 401 invalid_otp on an incorrect code", async () => {
    const c = testContainer(false);
    c.register({
      verifyOtpChallengeCommand: asValue({
        execute: vi.fn(async () => { throw new InvalidOtpError(); }),
      } as any),
    });
    const app = buildApp(c);
    const res = await app.inject({
      method: "POST", url: "/v1/users/otp/verify",
      payload: { email: "a@b.co", session: "sess_1", code: "000000" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid_otp" });
  });

  it("POST /v1/users/otp/verify returns 400 when code is not 6 digits", async () => {
    const app = buildApp(testContainer(false));
    const res = await app.inject({
      method: "POST", url: "/v1/users/otp/verify",
      payload: { email: "a@b.co", session: "sess_1", code: "12" },
    });
    expect(res.statusCode).toBe(400);
  });
  ```
  Add `InvalidOtpError` to the existing auth-errors import at the top of the file:
  ```typescript
  import { InvalidCredentialsError, EmailAlreadyExistsError, InvalidOtpError } from "#shared/auth/auth-errors";
  ```
  Run the tests now:
  ```bash
  cd services/users && nvm use && pnpm test -- routes.test.ts
  ```
  Expect **FAIL**: `POST /v1/users/otp/start` and `/verify` do not exist yet (404), and the
  `testContainer` extension alone doesn't create the routes.

- [ ] **Step 15: Run again after Steps 10-13 above are in place, expect PASS.**
  ```bash
  cd services/users && nvm use && pnpm test -- routes.test.ts
  ```
  Expect all tests, including the four new ones, to pass.

- [ ] **Step 16: Regenerate the OpenAPI spec.**
  ```bash
  cd services/users && nvm use && pnpm generate:openapi
  ```
  Expect `openapi.yaml` to gain `/v1/users/otp/start` and `/v1/users/otp/verify` paths with named
  `OtpStartInput`/`OtpVerifyInput` request components.

- [ ] **Step 17: Run the full Users suite and build.**
  ```bash
  cd services/users && nvm use && pnpm test && pnpm build && pnpm lint
  ```
  Expect everything green.

- [ ] **Step 18: Commit.**
  ```bash
  git add services/users/src/shared/auth/auth-provider.ts \
          services/users/src/shared/auth/cognito-auth-provider.ts \
          services/users/src/shared/auth/auth-errors.ts \
          services/users/src/features/users/commands/start-otp-challenge.ts \
          services/users/src/features/users/commands/verify-otp-challenge.ts \
          services/users/tests/features/users/commands/start-otp-challenge.test.ts \
          services/users/tests/features/users/commands/verify-otp-challenge.test.ts \
          services/users/src/shared/di/awilix-container.ts \
          services/users/src/features/users/http/schemas.ts \
          services/users/src/features/users/http/routes.ts \
          services/users/src/shared/http/public-routes.ts \
          services/users/tests/features/users/http/routes.test.ts \
          services/users/openapi.yaml
  git commit -m "feat(users): add OTP start/verify endpoints backed by CUSTOM_AUTH"
  ```

---

### Task 10: `POST /v1/users/register/passwordless` (with the x-e2e-source tag logic)

**Files:**
- Create: `services/users/src/features/users/commands/register-passwordless.ts`
- Create: `services/users/tests/features/users/commands/register-passwordless.test.ts`
- Modify: `services/users/src/shared/di/awilix-container.ts`
- Modify: `services/users/src/shared/audit/audit-actor.ts`
- Modify: `services/users/src/features/users/http/schemas.ts`
- Modify: `services/users/src/features/users/http/routes.ts`
- Modify: `services/users/src/shared/http/public-routes.ts`
- Modify: `services/users/tests/features/users/http/routes.test.ts`
- Modify: `services/users/openapi.yaml` (regenerated)

**Interfaces:**
- Produces: `RegisterPasswordlessCommand.execute(input: RegisterPasswordlessInput): Promise<User>`;
  `POST /v1/users/register/passwordless`.

- [ ] **Step 1: Add the new `AuditActor` member.**
  In `services/users/src/shared/audit/audit-actor.ts`, add to the enum:
  ```typescript
  export enum AuditActor {
    Register = "users_api:register",
    RegisterPasswordless = "users_api:register_passwordless",
    UpdateProfile = "users_api:update_profile",
    IdentityCapture = "users_api:identity_capture",
    E2eCleanup = "users_api:e2e_cleanup",
  }
  ```

- [ ] **Step 2: Write the failing unit test for `RegisterPasswordlessCommand`.**
  Create `services/users/tests/features/users/commands/register-passwordless.test.ts`:
  ```typescript
  import { describe, it, expect, vi } from "vitest";
  import { RegisterPasswordlessCommand } from "#features/users/commands/register-passwordless";

  function deps(overrides: Record<string, any> = {}) {
    return {
      db: {
        user: {
          create: vi.fn(async ({ data }: any) => ({
            ...data,
            cognitoSub: "sub-1",
            createdBy: "users_api:register_passwordless",
            createdAt: new Date("2026-01-01"),
            updatedBy: "users_api:register_passwordless",
            updatedAt: new Date("2026-01-01"),
            deletedBy: null,
            deletedAt: null,
          })),
        },
      },
      auth: {
        signUp: vi.fn(async (_email: string, _password: string, appUserId: string) => ({
          sub: "sub-1",
          email: "a@b.co",
          userPoolId: "pool",
          clientId: "cli",
        })),
      },
      events: { publishUserCreated: vi.fn(async () => undefined) },
      env: { NODE_ENV: "test" },
      captureCognitoIdentityCommand: { execute: vi.fn(async () => ({ status: "captured" })) },
      ...overrides,
    };
  }

  describe("RegisterPasswordlessCommand", () => {
    it("creates a user with authType PASSWORDLESS", async () => {
      const d = deps();
      const command = new RegisterPasswordlessCommand(d as any);
      const user = await command.execute({ email: "a@b.co", fullName: "Ada", e2eSource: false });

      expect(user.authType).toBe("PASSWORDLESS");
      const createArgs = d.db.user.create.mock.calls[0][0];
      expect(createArgs.data.authType).toBe("PASSWORDLESS");
    });

    it("calls auth.signUp with a random password never exposed on the returned user", async () => {
      const d = deps();
      const command = new RegisterPasswordlessCommand(d as any);
      const user = await command.execute({ email: "a@b.co", fullName: "Ada", e2eSource: false });

      expect(d.auth.signUp).toHaveBeenCalledOnce();
      const [, password] = d.auth.signUp.mock.calls[0];
      expect(typeof password).toBe("string");
      expect(password.length).toBeGreaterThanOrEqual(20);
      expect(JSON.stringify(user)).not.toContain(password);
    });

    it("tags the row E2E Source only when e2eSource is true", async () => {
      const d = deps();
      const command = new RegisterPasswordlessCommand(d as any);
      await command.execute({ email: "a@b.co", fullName: "Ada", e2eSource: true });
      const createArgs = d.db.user.create.mock.calls[0][0];
      expect(createArgs.data.tags).toContain("E2E Source");
    });

    it("publishes USER_CREATED the same way register() does", async () => {
      const d = deps();
      const command = new RegisterPasswordlessCommand(d as any);
      await command.execute({ email: "a@b.co", fullName: "Ada", e2eSource: false });
      expect(d.events.publishUserCreated).toHaveBeenCalledWith(
        expect.objectContaining({ email: "a@b.co", fullName: "Ada" }),
      );
    });
  });
  ```
  Run it now:
  ```bash
  cd services/users && nvm use && pnpm test -- register-passwordless.test.ts
  ```
  Expect **FAIL** with `Cannot find module '#features/users/commands/register-passwordless'`.

- [ ] **Step 3: Write `RegisterPasswordlessCommand`, following `register.ts`'s exact structure
  (same log events, same e2e-tag logic, same best-effort identity capture and event publish).**
  Create `services/users/src/features/users/commands/register-passwordless.ts`:
  ```typescript
  import { randomBytes } from "node:crypto";
  import type { Db } from "#shared/db/prisma";
  import type { AuthProvider } from "#shared/auth/auth-provider";
  import type { EventPublisher } from "#shared/messaging/event-publisher";
  import type { Env } from "#shared/config/env";
  import { MODEL_ID_PREFIXES, generateId } from "#shared/id/nano-id";
  import { runAsActor } from "#shared/audit/actor-context";
  import { AuditActor } from "#shared/audit/audit-actor";
  import { appLogger } from "#shared/logging/app-logger";
  import { setLogContext } from "#shared/logging/log-context";
  import { hashEmail } from "#shared/logging/email-hash";
  import { maskEmail } from "#shared/logging/email-mask";
  import { EmailAlreadyExistsError } from "#shared/auth/auth-errors";
  import { toDomain, type User } from "../domain/user.ts";
  import type { CaptureCognitoIdentityCommand } from "../webhooks/capture-cognito-identity.ts";

  export interface RegisterPasswordlessInput {
    email: string;
    fullName: string;
    address?: unknown;
    phoneNumber?: string;
    e2eSource: boolean;
  }

  // Generates a random password the caller never sees and nothing stores
  // retrievably. Cognito requires every user to have SOME password internally
  // even on the passwordless path (see the design spec's "passwordless
  // guarantee" section) — this is that value, discarded immediately after
  // signUp() returns. 32 random bytes, base64url-encoded, comfortably clears
  // any password-policy minimum length.
  function generateRandomPassword(): string {
    return randomBytes(32).toString("base64url");
  }

  // Constructor-injected from the Awilix cradle (PROXY injection mode):
  // `new RegisterPasswordlessCommand(cradle)` — property names must match
  // cradle keys. Deliberately mirrors RegisterUserCommand's structure (same
  // log app_events with a `_passwordless` … no: SAME event names as register(),
  // since this is still fundamentally a registration) so the two code paths
  // read as siblings, not divergent implementations.
  export class RegisterPasswordlessCommand {
    private readonly db: Db;
    private readonly auth: AuthProvider;
    private readonly events: EventPublisher;
    private readonly env: Env;
    private readonly captureCognitoIdentityCommand: CaptureCognitoIdentityCommand;

    constructor({
      db,
      auth,
      events,
      env,
      captureCognitoIdentityCommand,
    }: {
      db: Db;
      auth: AuthProvider;
      events: EventPublisher;
      env: Env;
      captureCognitoIdentityCommand: CaptureCognitoIdentityCommand;
    }) {
      this.db = db;
      this.auth = auth;
      this.events = events;
      this.env = env;
      this.captureCognitoIdentityCommand = captureCognitoIdentityCommand;
    }

    async execute(input: RegisterPasswordlessInput): Promise<User> {
      setLogContext({ email_hash: hashEmail(input.email) });
      appLogger.info(
        { app_event: "register_started", email: maskEmail(input.email), auth_type: "PASSWORDLESS" },
        "Starting passwordless user registration",
      );

      const id = generateId(MODEL_ID_PREFIXES.User);
      const randomPassword = generateRandomPassword();

      let signUp;
      try {
        signUp = await this.auth.signUp(input.email, randomPassword, id);
      } catch (err) {
        appLogger.error(
          {
            err,
            app_event: "register_failed",
            email: maskEmail(input.email),
            reason: err instanceof EmailAlreadyExistsError ? "duplicate_email" : "cognito_error",
          },
          err instanceof EmailAlreadyExistsError
            ? "Passwordless registration failed: a user with this email already exists"
            : "Passwordless registration failed: could not create the user in Cognito",
        );
        throw err;
      }

      const tags = input.e2eSource ? ["E2E Source"] : [];
      let row;
      try {
        row = await runAsActor(AuditActor.RegisterPasswordless, () =>
          this.db.user.create({
            data: {
              id,
              email: input.email,
              cognitoSub: signUp.sub,
              fullName: input.fullName,
              address: (input.address as any) ?? null,
              phoneNumber: input.phoneNumber ?? null,
              authType: "PASSWORDLESS",
              tags,
            },
          }),
        );
      } catch (err) {
        appLogger.error(
          { err, app_event: "register_failed", email: maskEmail(input.email), reason: "database_error" },
          "Passwordless registration failed: could not persist the user",
        );
        throw err;
      }

      if (this.env.NODE_ENV !== "production") {
        try {
          await this.captureCognitoIdentityCommand.execute({
            version: "1",
            triggerSource: "PostConfirmation_ConfirmSignUp",
            region: this.env.AWS_REGION,
            userPoolId: signUp.userPoolId,
            userName: input.email,
            callerContext: { awsSdkVersion: "local", clientId: signUp.clientId },
            request: {
              userAttributes: {
                sub: signUp.sub,
                email: signUp.email,
                ...(signUp.emailVerified ? { email_verified: signUp.emailVerified } : {}),
              },
            },
          });
        } catch (err) {
          appLogger.warn(
            { err, app_event: "cognito_identity_capture_failed" },
            "cognito identity capture failed (non-fatal)",
          );
        }
      }

      await this.events.publishUserCreated({
        id,
        email: input.email,
        fullName: input.fullName,
        cognitoSub: signUp.sub,
      });

      setLogContext({ user_id: id });
      appLogger.info(
        { app_event: "register_succeeded", email: maskEmail(input.email), user_id: id, auth_type: "PASSWORDLESS" },
        "Passwordless user registration completed",
      );

      return toDomain(row as any);
    }
  }
  ```

- [ ] **Step 4: Run the test, expect PASS.**
  ```bash
  cd services/users && nvm use && pnpm test -- register-passwordless.test.ts
  ```
  Expect all four tests to pass.

- [ ] **Step 5: Register the command in the Awilix container.**
  In `services/users/src/shared/di/awilix-container.ts`:
  ```typescript
  import { RegisterPasswordlessCommand } from "#features/users/commands/register-passwordless";
  ```
  Add to `Cradle`:
  ```typescript
    registerPasswordlessCommand: RegisterPasswordlessCommand;
  ```
  Add to `registerServices()`:
  ```typescript
      registerPasswordlessCommand: asClass(RegisterPasswordlessCommand, { lifetime: Lifetime.SCOPED }),
  ```

- [ ] **Step 6: Add the request schema.**
  In `services/users/src/features/users/http/schemas.ts`, add:
  ```typescript
  export const RegisterPasswordlessInputSchema = z.object({
    email: z.string().email().describe("New passwordless user's email"),
    fullName: z.string().describe("Display name"),
    address: z.unknown().optional().describe("Free-form structured address (stored as JSON)"),
    phoneNumber: z.string().optional(),
  });
  ```
  Register it:
  ```typescript
  z.globalRegistry.add(RegisterPasswordlessInputSchema, { id: "RegisterPasswordless" });
  ```

- [ ] **Step 7: Add the route in `routes.ts`, right after `/v1/users/register`.**
  Add the import:
  ```typescript
  import {
    RegisterInputSchema, RegisterPasswordlessInputSchema, LoginInputSchema, UpdateProfileInputSchema,
    RefreshInputSchema, RefreshedTokensSchema,
    OtpStartInputSchema, OtpStartResponseSchema, OtpVerifyInputSchema,
    UserSchema, AuthTokensSchema, ErrorSchema,
    HealthResponseSchema, E2ECleanupResponseSchema,
    UserIdHeader, WebhookSecretHeader,
  } from "./schemas.ts";
  ```
  Add the route:
  ```typescript
      r.post("/v1/users/register/passwordless", {
        schema: {
          tags: ["users"], operationId: "registerPasswordlessUser",
          summary: "Register a new passwordless user (OTP-only login)",
          body: RegisterPasswordlessInputSchema,
          response: { 201: UserSchema, 409: ErrorSchema },
        },
      }, async (req, reply) => {
        const body = req.body; // typed from RegisterPasswordlessInputSchema
        const headerFlag = req.headers["x-e2e-source"] === "true";
        const { env, registerPasswordlessCommand } = req.diScope.cradle;
        const e2eSource = headerFlag && env.E2E_TESTING_ENABLED;
        const user = await registerPasswordlessCommand.execute({ ...body, e2eSource });
        return reply.code(201).send(serializeUser(user));
      });
  ```
  This replicates `/v1/users/register`'s exact `x-e2e-source` tag logic
  (`headerFlag && env.E2E_TESTING_ENABLED`), so passwordless E2E users are tagged and cleaned up
  by the same teardown, per this plan's Global Constraints.

- [ ] **Step 8: Add the route to `public-routes.ts`.**
  ```typescript
  const EXACT: ReadonlyArray<{ method: string; path: string }> = [
    { method: "GET", path: "/v1/health" },
    { method: "POST", path: "/v1/users/login" },
    { method: "POST", path: "/v1/users/register" },
    { method: "POST", path: "/v1/users/register/passwordless" },
    { method: "POST", path: "/v1/users/refresh" },
    { method: "POST", path: "/v1/users/otp/start" },
    { method: "POST", path: "/v1/users/otp/verify" },
    { method: "DELETE", path: "/v1/users/e2e-cleanup" },
  ];
  ```

- [ ] **Step 9: Write failing route tests.**
  In `routes.test.ts`, extend `testContainer()` with `registerPasswordlessCommand`:
  ```typescript
      registerPasswordlessCommand: asValue({
        execute: vi.fn(async (input: any) =>
          fakeUser({
            id: "usr_2",
            authType: "PASSWORDLESS",
            tags: input.e2eSource ? ["E2E Source"] : [],
          }),
        ),
      } as any),
  ```
  Add tests:
  ```typescript
  it("POST /v1/users/register/passwordless returns 201 with authType PASSWORDLESS", async () => {
    const app = buildApp(testContainer(false));
    const res = await app.inject({
      method: "POST", url: "/v1/users/register/passwordless",
      payload: { email: "a@b.co", fullName: "A" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().authType).toBe("PASSWORDLESS");
  });

  it("POST /v1/users/register/passwordless honors x-e2e-source only when the flag is enabled", async () => {
    const app = buildApp(testContainer(true));
    const res = await app.inject({
      method: "POST", url: "/v1/users/register/passwordless",
      headers: { "x-e2e-source": "true" },
      payload: { email: "a@b.co", fullName: "A" },
    });
    expect(res.json().tags).toContain("E2E Source");
  });

  it("POST /v1/users/register/passwordless returns 409 on duplicate email", async () => {
    const c = testContainer(false);
    c.register({
      registerPasswordlessCommand: asValue({
        execute: vi.fn(async () => { throw new EmailAlreadyExistsError(); }),
      } as any),
    });
    const app = buildApp(c);
    const res = await app.inject({
      method: "POST", url: "/v1/users/register/passwordless",
      payload: { email: "dup@b.co", fullName: "D" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "email_exists" });
  });
  ```
  Run now, before Steps 5-8 are wired: expect **FAIL** (404, and missing cradle key).
  ```bash
  cd services/users && nvm use && pnpm test -- routes.test.ts
  ```

- [ ] **Step 10: Re-run after Steps 5-8, expect PASS.**
  ```bash
  cd services/users && nvm use && pnpm test -- routes.test.ts
  ```
  Expect all tests, including the three new ones, to pass.

- [ ] **Step 11: Regenerate the OpenAPI spec.**
  ```bash
  cd services/users && nvm use && pnpm generate:openapi
  ```

- [ ] **Step 12: Run the full suite and build.**
  ```bash
  cd services/users && nvm use && pnpm test && pnpm build && pnpm lint
  ```
  Expect everything green.

- [ ] **Step 13: Commit.**
  ```bash
  git add services/users/src/features/users/commands/register-passwordless.ts \
          services/users/tests/features/users/commands/register-passwordless.test.ts \
          services/users/src/shared/di/awilix-container.ts \
          services/users/src/shared/audit/audit-actor.ts \
          services/users/src/features/users/http/schemas.ts \
          services/users/src/features/users/http/routes.ts \
          services/users/src/shared/http/public-routes.ts \
          services/users/tests/features/users/http/routes.test.ts \
          services/users/openapi.yaml
  git commit -m "feat(users): add POST /v1/users/register/passwordless"
  ```

---

### Task 11: Login guard — 401 generic + `reason: "passwordless_user"` log

**Files:**
- Modify: `services/users/src/features/users/commands/login.ts`
- Modify: `services/users/tests/features/users/commands/login.test.ts` (create if it does not
  exist yet — verify in Step 1)
- Modify: `services/users/src/shared/di/awilix-container.ts` (only if `LoginUserCommand` needs a
  new cradle dependency — see Step 2)

**Interfaces:**
- Consumes: `Db` (to look up `authType` before calling Cognito).
- Produces: `LoginUserCommand.execute` throws `InvalidCredentialsError` (401,
  `invalid_credentials`) for a `PASSWORDLESS` user, logging `reason: "passwordless_user"`.

- [ ] **Step 1: Check whether a `login.test.ts` unit test file already exists.**
  ```bash
  find services/users/tests/features/users/commands -iname "login.test.ts"
  ```
  If it does not exist, create it fresh in this task (it did not exist as of this plan's
  authoring — confirmed by the earlier repo scan). If it does exist, read it first and follow its
  existing fixture shape instead of the one below.

- [ ] **Step 2: Write the failing unit test.**
  Create `services/users/tests/features/users/commands/login.test.ts`:
  ```typescript
  import { describe, it, expect, vi } from "vitest";
  import { LoginUserCommand } from "#features/users/commands/login";
  import { InvalidCredentialsError } from "#shared/auth/auth-errors";
  import { appLogger } from "#shared/logging/app-logger";

  function deps(overrides: Record<string, any> = {}) {
    return {
      auth: { login: vi.fn(async () => ({ idToken: "id1", accessToken: "acc1", refreshToken: "rt1" })) },
      db: { user: { findUnique: vi.fn(async () => ({ authType: "PASSWORD" })) } },
      ...overrides,
    };
  }

  describe("LoginUserCommand", () => {
    it("returns AuthTokens for a PASSWORD user with correct credentials", async () => {
      const command = new LoginUserCommand(deps() as any);
      const tokens = await command.execute({ email: "a@b.co", password: "x" });
      expect(tokens).toEqual({ idToken: "id1", accessToken: "acc1", refreshToken: "rt1" });
    });

    it("rejects a PASSWORDLESS user with generic 401 invalid_credentials, before calling Cognito", async () => {
      const d = deps({
        db: { user: { findUnique: vi.fn(async () => ({ authType: "PASSWORDLESS" })) } },
      });
      const command = new LoginUserCommand(d as any);

      await expect(command.execute({ email: "a@b.co", password: "x" })).rejects.toBeInstanceOf(
        InvalidCredentialsError,
      );
      // The guard must short-circuit BEFORE any Cognito call — a passwordless
      // account's random password must never even be tried.
      expect(d.auth.login).not.toHaveBeenCalled();
    });

    it("logs reason: passwordless_user for the guard rejection, never a distinct status/code", async () => {
      const d = deps({
        db: { user: { findUnique: vi.fn(async () => ({ authType: "PASSWORDLESS" })) } },
      });
      const command = new LoginUserCommand(d as any);
      const calls: unknown[] = [];
      const spy = vi.spyOn(appLogger, "error").mockImplementation(((...args: unknown[]) => {
        calls.push(args);
      }) as never);

      try {
        await command.execute({ email: "a@b.co", password: "x" });
      } catch {
        // expected
      }

      spy.mockRestore();
      const [fields] = calls[0] as [Record<string, unknown>];
      expect(fields.app_event).toBe("login_failed");
      expect(fields.reason).toBe("passwordless_user");
    });

    it("still rejects with invalid_credentials when no user row exists for the email", async () => {
      const d = deps({ db: { user: { findUnique: vi.fn(async () => null) } } });
      const command = new LoginUserCommand(d as any);
      // No local row is not itself a passwordless rejection — Cognito is still
      // asked, and IT returns the usual invalid-credentials rejection.
      d.auth.login = vi.fn(async () => {
        throw new InvalidCredentialsError();
      });
      await expect(command.execute({ email: "nouser@b.co", password: "x" })).rejects.toBeInstanceOf(
        InvalidCredentialsError,
      );
    });
  });
  ```
  Run it now:
  ```bash
  cd services/users && nvm use && pnpm test -- login.test.ts
  ```
  Expect **FAIL**: the current `LoginUserCommand` constructor only destructures `{ auth }` (no
  `db`), so the passwordless-rejection and reason-logging assertions fail — the command currently
  always calls `this.auth.login` regardless of `authType`.

- [ ] **Step 3: Add the guard to `LoginUserCommand`.**
  Edit `services/users/src/features/users/commands/login.ts`:
  ```typescript
  import type { AuthProvider, AuthTokens } from "#shared/auth/auth-provider";
  import type { Db } from "#shared/db/prisma";
  import { InvalidCredentialsError } from "#shared/auth/auth-errors";
  import { appLogger } from "#shared/logging/app-logger";
  import { setLogContext } from "#shared/logging/log-context";
  import { hashEmail } from "#shared/logging/email-hash";
  import { maskEmail } from "#shared/logging/email-mask";

  export interface LoginInput {
    email: string;
    password: string;
  }

  // Constructor-injected from the Awilix cradle (PROXY injection mode).
  export class LoginUserCommand {
    private readonly auth: AuthProvider;
    private readonly db: Db;

    constructor({ auth, db }: { auth: AuthProvider; db: Db }) {
      this.auth = auth;
      this.db = db;
    }

    async execute(input: LoginInput): Promise<AuthTokens> {
      setLogContext({ email_hash: hashEmail(input.email) });
      appLogger.info(
        { app_event: "login_started", email: maskEmail(input.email) },
        "Starting user login",
      );

      // The passwordless guard: Cognito still holds a random, never-revealed
      // password for a PASSWORDLESS user (see the design spec), so relying on
      // "nobody knows it" alone is cosmetic. This check makes the property
      // structural — reject BEFORE any Cognito call, and reply with the SAME
      // generic 401 invalid_credentials a wrong password gets (per
      // auth-error-mapping's anti-enumeration rule: a distinct status/code
      // here would let a caller learn an account is passwordless from the
      // response alone). The real cause is recorded only in the log, never in
      // the HTTP response.
      const existing = await this.db.user.findUnique({ where: { email: input.email } });
      if (existing?.authType === "PASSWORDLESS") {
        appLogger.error(
          {
            app_event: "login_failed",
            email: maskEmail(input.email),
            reason: "passwordless_user",
          },
          "User login failed: account is passwordless",
        );
        throw new InvalidCredentialsError();
      }

      try {
        const tokens = await this.auth.login(input.email, input.password);
        appLogger.info(
          { app_event: "login_succeeded", email: maskEmail(input.email) },
          "User login completed",
        );
        return tokens;
      } catch (err) {
        const invalid = err instanceof InvalidCredentialsError;
        appLogger.error(
          {
            err,
            app_event: "login_failed",
            email: maskEmail(input.email),
            reason: invalid ? "invalid_credentials" : "cognito_error",
          },
          invalid
            ? "User login failed: invalid credentials"
            : "User login failed: the identity provider rejected the request",
        );
        throw err;
      }
    }
  }
  ```

- [ ] **Step 4: Run the test, expect PASS.**
  ```bash
  cd services/users && nvm use && pnpm test -- login.test.ts
  ```
  Expect all four tests to pass.

- [ ] **Step 5: Update `LoginUserCommand`'s registration — verify `db` is already a Cradle key
  (it is: `registerSingletons()` already registers `db: asValue(db)`), so no `awilix-container.ts`
  edit is needed. `asClass(LoginUserCommand, ...)`'s PROXY injection already resolves any cradle
  key the constructor destructures, including the newly added `db`. Confirm by reading
  `registerServices()` — do not add a redundant registration.**

- [ ] **Step 6: Fix `routes.test.ts`'s `testContainer()` — `LoginUserCommand` is mocked there
  (`loginUserCommand: asValue({...})`), so no `db` wiring is needed for THOSE tests (the mock
  bypasses the real class entirely). Confirm the existing login-related route tests
  (`"POST /v1/users/login returns 401 on invalid credentials"`) still pass unchanged.**
  ```bash
  cd services/users && nvm use && pnpm test -- routes.test.ts
  ```
  Expect no regressions.

- [ ] **Step 7: Run the full Users suite and build.**
  ```bash
  cd services/users && nvm use && pnpm test && pnpm build && pnpm lint
  ```
  Expect everything green.

- [ ] **Step 8: Commit.**
  ```bash
  git add services/users/src/features/users/commands/login.ts \
          services/users/tests/features/users/commands/login.test.ts
  git commit -m "fix(users): reject passwordless users at login with a generic 401"
  ```

---

### Task 12: Gateway routes (3 entries) + note the make clean/bootstrap requirement

**Files:**
- Modify: `infra/modules/api-gateway/main.tf`

**Interfaces:**
- Produces: three new entries in `locals.routes`, all `auth = false` (OTP start/verify and
  passwordless registration are, like `/v1/users/login`/`/v1/users/register`, unauthenticated by
  definition — the caller has no token yet).

- [ ] **Step 1: Add the three route entries.**
  In `infra/modules/api-gateway/main.tf`, inside `locals.routes`, add alongside the existing
  `register`/`login`/`refresh` entries:
  ```hcl
      otp_start                 = { key = "POST /v1/users/otp/start", path = "/v1/users/otp/start", auth = false }
      otp_verify                = { key = "POST /v1/users/otp/verify", path = "/v1/users/otp/verify", auth = false }
      register_passwordless     = { key = "POST /v1/users/register/passwordless", path = "/v1/users/register/passwordless", auth = false }
  ```
  No nginx change is needed: nginx's default `location /` already routes anything under
  `/v1/users/*` to the `users` service (per this repo's existing routing, confirmed by the
  pre-existing `register`/`login`/`refresh` entries needing no nginx edit either).

- [ ] **Step 2: Validate.**
  ```bash
  cd infra && terraform -chdir=modules/api-gateway validate
  ```
  Expect `Success!`.

- [ ] **Step 3: Note the required rebuild — do NOT run a bare `terraform apply` after this.**
  Adding gateway routes changes the API Gateway v2 route set, which triggers Floci's known
  `UpdateTags` failure on a second `terraform apply` (see `infra/CLAUDE.md`'s "Known limitation").
  The next full-stack bring-up after this task must be:
  ```bash
  make clean && make bootstrap
  ```
  This is a **note for whoever next brings up the local stack** (including Tasks 14/15's E2E
  runs) — it reassigns pool/client ids and DB ports, so any hardcoded local id from a previous
  session is stale afterward. This step has no separate command to run as part of this task;
  it documents a prerequisite for the tasks that follow.

- [ ] **Step 4: Commit.**
  ```bash
  git add infra/modules/api-gateway/main.tf
  git commit -m "feat(infra): add gateway routes for OTP and passwordless registration"
  ```

---

### Task 13: Unit tests for the three trigger branches (issued / correct accepted / incorrect REJECTED / attempts exhausted)

**Files:**
- Create: `infra/modules/cognito/otp-challenge-lambda/index.test.mjs`
- Modify: `infra/modules/cognito/otp-challenge-lambda/package.json` (add a test script + `vitest`
  devDependency, since this directory has no test runner yet)

**Interfaces:**
- Consumes: the exported `handler` from `index.mjs`.
- Produces: no new production interface — pure test coverage of the four trigger branches named
  in this plan's title.

- [ ] **Step 1: Add a test runner to the Lambda's `package.json`.**
  Edit `infra/modules/cognito/otp-challenge-lambda/package.json`:
  ```json
  {
    "name": "otp-challenge-lambda",
    "private": true,
    "type": "module",
    "scripts": {
      "test": "vitest run"
    },
    "dependencies": {
      "@aws-sdk/client-sqs": "^3.600.0"
    },
    "devDependencies": {
      "vitest": "^2.0.0"
    }
  }
  ```
  Install:
  ```bash
  cd infra/modules/cognito/otp-challenge-lambda && npm install
  ```

- [ ] **Step 2: Write the failing test file covering all four branches.**
  Create `infra/modules/cognito/otp-challenge-lambda/index.test.mjs`:
  ```javascript
  import { describe, it, expect, vi, beforeEach } from "vitest";

  const sendMock = vi.fn(async () => ({}));
  vi.mock("@aws-sdk/client-sqs", () => ({
    SQSClient: vi.fn(() => ({ send: sendMock })),
    SendMessageCommand: vi.fn((input) => ({ input })),
  }));

  const { handler } = await import("./index.mjs");

  function baseEvent(triggerSource, overrides = {}) {
    return {
      triggerSource,
      request: {
        userAttributes: { sub: "sub-1", email: "user@example.com" },
        session: [],
        ...overrides.request,
      },
      response: {},
      ...overrides,
    };
  }

  describe("otp-challenge-lambda", () => {
    beforeEach(() => {
      sendMock.mockClear();
      process.env.EVENTS_QUEUE_URL = "http://localhost:4566/000000000000/events";
    });

    it("DefineAuthChallenge issues a CUSTOM_CHALLENGE on the first attempt", async () => {
      const event = baseEvent("DefineAuthChallenge_Authentication");
      const result = await handler(event);
      expect(result.response.challengeName).toBe("CUSTOM_CHALLENGE");
      expect(result.response.failAuthentication).toBe(false);
      expect(result.response.issueTokens).toBe(false);
    });

    it("DefineAuthChallenge issues tokens after a correct answer", async () => {
      const event = baseEvent("DefineAuthChallenge_Authentication", {
        request: {
          userAttributes: { sub: "sub-1", email: "user@example.com" },
          session: [{ challengeName: "CUSTOM_CHALLENGE", challengeResult: true }],
        },
      });
      const result = await handler(event);
      expect(result.response.issueTokens).toBe(true);
      expect(result.response.failAuthentication).toBe(false);
    });

    it("DefineAuthChallenge fails authentication after attempts are exhausted", async () => {
      const event = baseEvent("DefineAuthChallenge_Authentication", {
        request: {
          userAttributes: { sub: "sub-1", email: "user@example.com" },
          session: [
            { challengeName: "CUSTOM_CHALLENGE", challengeResult: false },
            { challengeName: "CUSTOM_CHALLENGE", challengeResult: false },
            { challengeName: "CUSTOM_CHALLENGE", challengeResult: false },
          ],
        },
      });
      const result = await handler(event);
      expect(result.response.failAuthentication).toBe(true);
      expect(result.response.issueTokens).toBe(false);
    });

    it("CreateAuthChallenge generates a 6-digit numeric code and never puts it in publicChallengeParameters", async () => {
      const event = baseEvent("CreateAuthChallenge_Authentication");
      const result = await handler(event);
      const code = result.response.privateChallengeParameters.code;
      expect(code).toMatch(/^\d{6}$/);
      expect(JSON.stringify(result.response.publicChallengeParameters)).not.toContain(code);
    });

    it("CreateAuthChallenge publishes AUTH_OTP_REQUESTED to SQS with the code in the payload", async () => {
      const event = baseEvent("CreateAuthChallenge_Authentication");
      await handler(event);
      expect(sendMock).toHaveBeenCalledOnce();
      const sentInput = sendMock.mock.calls[0][0].input;
      const body = JSON.parse(sentInput.MessageBody);
      expect(body.type).toBe("AUTH_OTP_REQUESTED");
      expect(body.payload.email).toBe("user@example.com");
      expect(typeof body.payload.code).toBe("string");
    });

    it("CreateAuthChallenge reuses the same code on a same-session retry instead of generating a new one", async () => {
      const first = await handler(baseEvent("CreateAuthChallenge_Authentication"));
      const firstCode = first.response.privateChallengeParameters.code;

      const retryEvent = baseEvent("CreateAuthChallenge_Authentication", {
        request: {
          userAttributes: { sub: "sub-1", email: "user@example.com" },
          session: [
            {
              challengeName: "CUSTOM_CHALLENGE",
              challengeResult: false,
              challengeMetadata: JSON.stringify({ code: firstCode }),
            },
          ],
        },
      });
      const retry = await handler(retryEvent);
      expect(retry.response.privateChallengeParameters.code).toBe(firstCode);
    });

    it("VerifyAuthChallengeResponse accepts the correct code", async () => {
      const event = baseEvent("VerifyAuthChallengeResponse_Authentication", {
        request: {
          userAttributes: { sub: "sub-1", email: "user@example.com" },
          privateChallengeParameters: { code: "042817" },
          challengeAnswer: "042817",
        },
      });
      const result = await handler(event);
      expect(result.response.answerCorrect).toBe(true);
    });

    it("VerifyAuthChallengeResponse REJECTS an incorrect code", async () => {
      const event = baseEvent("VerifyAuthChallengeResponse_Authentication", {
        request: {
          userAttributes: { sub: "sub-1", email: "user@example.com" },
          privateChallengeParameters: { code: "042817" },
          challengeAnswer: "000000",
        },
      });
      const result = await handler(event);
      expect(result.response.answerCorrect).toBe(false);
    });

    it("VerifyAuthChallengeResponse rejects (not throws) on a wrong-length answer", async () => {
      const event = baseEvent("VerifyAuthChallengeResponse_Authentication", {
        request: {
          userAttributes: { sub: "sub-1", email: "user@example.com" },
          privateChallengeParameters: { code: "042817" },
          challengeAnswer: "1",
        },
      });
      const result = await handler(event);
      expect(result.response.answerCorrect).toBe(false);
    });
  });
  ```
  Run it now, before any prior fix:
  ```bash
  cd infra/modules/cognito/otp-challenge-lambda && nvm use && npm test
  ```
  Expect all tests to already **PASS** — `index.mjs` was written fully in Task 4, so this task is
  purely adding the missing test coverage against that already-correct implementation. If any
  test fails, that is a genuine defect in Task 4's implementation to fix now (e.g. an off-by-one
  in the attempts count, or the retry-reuse branch), not a pre-existing expectation to weaken.

- [ ] **Step 2: Confirm all tests pass.**
  ```bash
  cd infra/modules/cognito/otp-challenge-lambda && nvm use && npm test
  ```
  Expect all 10 tests green.

- [ ] **Step 3: Commit.**
  ```bash
  git add infra/modules/cognito/otp-challenge-lambda/index.test.mjs \
          infra/modules/cognito/otp-challenge-lambda/package.json \
          infra/modules/cognito/otp-challenge-lambda/package-lock.json
  git commit -m "test(infra): cover the otp-challenge-lambda's four trigger branches"
  ```

---

### Task 14: Internal E2E specs

**Files:**
- Create: `e2e/tests/otp-auth.spec.ts`

**Interfaces:**
- Consumes: `USERS_BASE_URL` (direct service URL, per the existing `internal` Playwright project);
  `waitForEmailTo`/`searchByRecipient` from `e2e/support/mailpit-client.ts`; `makeUser` from
  `e2e/support/chance-factory.ts`.

- [ ] **Step 1: Read one existing internal spec to match its exact request style (base client,
  assertions) before writing the new one.**
  ```bash
  ls e2e/tests/*.spec.ts | head -5
  ```
  Open whichever spec already exercises `/v1/users/register` and `/v1/users/login` directly
  against `USERS_BASE_URL`, and match its `request.newContext`/`api-client.ts` usage pattern
  exactly (do not invent a different HTTP client style for this new spec).

- [ ] **Step 2: Write `e2e/tests/otp-auth.spec.ts`.**
  ```typescript
  import { test, expect, request } from "@playwright/test";
  import { makeUser } from "../support/chance-factory.js";
  import { waitForEmailTo, searchByRecipient } from "../support/mailpit-client.js";

  function usersBaseURL(): string {
    const raw = process.env.USERS_BASE_URL;
    if (!raw) throw new Error("USERS_BASE_URL is not set — run `make bootstrap`.");
    return raw.endsWith("/") ? raw : `${raw}/`;
  }

  // Extracts a 6-digit code from a Mailpit message's plain-text Snippet. The
  // auth-otp template renders the code as bare visible text (see Task 6), so a
  // simple digit-run match is sufficient and does not depend on any HTML markup
  // shape.
  function extractCode(snippet: string): string {
    const match = snippet.match(/\b\d{6}\b/);
    if (!match) throw new Error(`no 6-digit code found in Mailpit snippet: ${snippet}`);
    return match[0];
  }

  test.describe("Passwordless OTP auth (internal, direct service URL)", () => {
    test("register/passwordless -> otp/start -> otp/verify issues tokens usable like a normal login", async () => {
      const ctx = await request.newContext({ baseURL: usersBaseURL(), extraHTTPHeaders: { "x-e2e-source": "true" } });
      const user = makeUser();

      const reg = await ctx.post("v1/users/register/passwordless", {
        data: { email: user.email, fullName: user.fullName },
      });
      expect(reg.status()).toBe(201);
      expect((await reg.json()).authType).toBe("PASSWORDLESS");

      const start = await ctx.post("v1/users/otp/start", { data: { email: user.email } });
      expect(start.status()).toBe(200);
      const { session } = await start.json();
      expect(typeof session).toBe("string");

      const messages = await waitForEmailTo(user.email, {
        matching: (m) => m.Subject === "Your one-time code",
        description: "the OTP email",
      });
      const code = extractCode(messages[0]!.Snippet);

      const verify = await ctx.post("v1/users/otp/verify", { data: { email: user.email, session, code } });
      expect(verify.status()).toBe(200);
      const tokens = await verify.json();
      expect(tokens.accessToken).toBeTruthy();
      expect(tokens.idToken).toBeTruthy();
      expect(tokens.refreshToken).toBeTruthy();

      await ctx.dispose();
    });

    test("otp/start then otp/verify also works for an existing PASSWORD user (second login path)", async () => {
      const ctx = await request.newContext({ baseURL: usersBaseURL(), extraHTTPHeaders: { "x-e2e-source": "true" } });
      const user = makeUser();

      const reg = await ctx.post("v1/users/register", { data: user });
      expect(reg.status()).toBe(201);

      const start = await ctx.post("v1/users/otp/start", { data: { email: user.email } });
      expect(start.status()).toBe(200);
      const { session } = await start.json();

      const messages = await waitForEmailTo(user.email, {
        matching: (m) => m.Subject === "Your one-time code",
        description: "the OTP email",
      });
      const code = extractCode(messages[0]!.Snippet);

      const verify = await ctx.post("v1/users/otp/verify", { data: { email: user.email, session, code } });
      expect(verify.status()).toBe(200);

      await ctx.dispose();
    });

    // Mandatory anti-false-PASS guard #1 (per the design spec): a wrong code
    // must be rejected, not silently accepted.
    test("otp/verify rejects a wrong code with 401 invalid_otp", async () => {
      const ctx = await request.newContext({ baseURL: usersBaseURL(), extraHTTPHeaders: { "x-e2e-source": "true" } });
      const user = makeUser();

      await ctx.post("v1/users/register/passwordless", { data: { email: user.email, fullName: user.fullName } });
      const start = await ctx.post("v1/users/otp/start", { data: { email: user.email } });
      const { session } = await start.json();

      await waitForEmailTo(user.email, {
        matching: (m) => m.Subject === "Your one-time code",
        description: "the OTP email",
      });

      const verify = await ctx.post("v1/users/otp/verify", {
        data: { email: user.email, session, code: "000000" },
      });
      expect(verify.status()).toBe(401);
      expect((await verify.json()).error).toBe("invalid_otp");

      await ctx.dispose();
    });

    // Mandatory anti-false-PASS guard #2 (per the design spec): a PASSWORDLESS
    // user must not be able to log in with any password.
    test("login rejects a PASSWORDLESS user with generic 401 invalid_credentials", async () => {
      const ctx = await request.newContext({ baseURL: usersBaseURL(), extraHTTPHeaders: { "x-e2e-source": "true" } });
      const user = makeUser();

      await ctx.post("v1/users/register/passwordless", { data: { email: user.email, fullName: user.fullName } });

      const login = await ctx.post("v1/users/login", { data: { email: user.email, password: "AnyGuess123!" } });
      expect(login.status()).toBe(401);
      expect((await login.json()).error).toBe("invalid_credentials");

      await ctx.dispose();
    });

    test("the OTP email body does not otherwise appear in Mailpit before otp/start is called", async () => {
      const ctx = await request.newContext({ baseURL: usersBaseURL(), extraHTTPHeaders: { "x-e2e-source": "true" } });
      const user = makeUser();

      await ctx.post("v1/users/register/passwordless", { data: { email: user.email, fullName: user.fullName } });
      const messages = await searchByRecipient(user.email);
      expect(messages.find((m) => m.Subject === "Your one-time code")).toBeUndefined();

      await ctx.dispose();
    });
  });
  ```

- [ ] **Step 3: Run the internal E2E project against a stack rebuilt per Task 12's note.**
  ```bash
  cd e2e && nvm use && pnpm exec playwright test --project=internal otp-auth.spec.ts
  ```
  Expect all five tests to pass, given `make clean && make bootstrap` has been run since Task 12
  added the gateway routes (this test targets `USERS_BASE_URL` directly, but shares the same
  rebuilt Floci stack, Cognito pool/client, and events pipeline).

- [ ] **Step 4: Commit.**
  ```bash
  git add e2e/tests/otp-auth.spec.ts
  git commit -m "test(users): internal E2E for passwordless OTP auth"
  ```

---

### Task 15: Gateway E2E with Mailpit `getMessage(id)` code extraction + both mandatory negative tests

**Files:**
- Modify: `e2e/support/mailpit-client.ts` (add `getMessage(id)`)
- Create: `e2e/support/mailpit-client.test.ts` (unit test for the new helper, if this file
  already has sibling unit tests — verify in Step 1; otherwise skip straight to the E2E spec)
- Create: `e2e/tests/gateway/otp-auth.spec.ts`

**Interfaces:**
- Produces: `getMessage(id: string): Promise<MailpitFullMessage>` where `MailpitFullMessage`
  extends the existing summary shape with `Text: string` and `HTML: string`.

- [ ] **Step 1: Check whether `mailpit-client.ts` already has a unit test file.**
  ```bash
  find e2e -iname "mailpit-client*.test.ts"
  ```
  If none exists, this task adds the new helper without a dedicated unit test file (consistent
  with the rest of that module, which is exercised only through the E2E specs that call it) — go
  straight to Step 2. If one exists, add a test for `getMessage` there following its style
  instead of skipping to Step 2.

- [ ] **Step 2: Add `getMessage(id)` to `e2e/support/mailpit-client.ts`.**
  Add, near the top of the file, next to the existing `MailpitMessage` interface:
  ```typescript
  // The FULL message shape from `GET /message/{ID}` — a strict SUPERSET of the
  // search summary (MailpitMessage): it additionally carries `Text` and `HTML`,
  // the actual rendered bodies. The search endpoint only returns `Snippet` (a
  // flattened preview), which is too fragile to extract a 6-digit OTP code
  // from reliably — this is the endpoint that returns the real body.
  export interface MailpitFullMessage extends MailpitMessage {
    Text: string;
    HTML: string;
  }
  ```
  Add the function itself, near `searchByRecipient`:
  ```typescript
  // Fetches ONE message's full body by id (Mailpit's GET /message/{ID}), for
  // extracting content the search summary's Snippet cannot reliably carry —
  // e.g. a 6-digit OTP code embedded in the auth-otp template. Callers get an
  // id from searchByRecipient/waitForEmailTo first, then call this to read the
  // real Text/HTML.
  export async function getMessage(id: string): Promise<MailpitFullMessage> {
    const res = await fetch(`${mailpitApiUrl()}/message/${id}`);
    if (!res.ok) {
      throw new Error(
        `Mailpit GET /message/${id} failed with ${res.status} at ${mailpitApiUrl()} — ` +
          "is the mailpit container up? `docker compose up -d mailpit`.",
      );
    }
    return (await res.json()) as MailpitFullMessage;
  }
  ```

- [ ] **Step 3: Read one existing gateway spec to match its exact style (baseURL, headers,
  `getGatewayToken`) before writing the new one.**
  ```bash
  ls e2e/tests/gateway/*.spec.ts
  ```
  Open one and confirm: relative paths with no leading slash, `x-e2e-source` header via context,
  and how it builds its own request context (vs. reusing `getGatewayToken()` from `support/auth.ts`
  when a spec only needs ONE authenticated user upfront — this spec needs raw register/login-style
  calls instead, so it builds its own context the same way `getGatewayToken()` does internally).

- [ ] **Step 4: Write `e2e/tests/gateway/otp-auth.spec.ts`.**
  ```typescript
  import { test, expect, request } from "@playwright/test";
  import { makeUser } from "../../support/chance-factory.js";
  import { waitForEmailTo, getMessage } from "../../support/mailpit-client.js";

  function gatewayBaseURL(): string {
    const raw = process.env.API_GATEWAY_URL;
    if (!raw) throw new Error("API_GATEWAY_URL is not set — run `make bootstrap`.");
    return raw.endsWith("/") ? raw : `${raw}/`;
  }

  // Extracts the 6-digit code from the FULL message Text body (not the search
  // summary's Snippet — see mailpit-client.ts's getMessage). The auth-otp
  // template renders the code as bare visible text, so a digit-run match is
  // sufficient.
  function extractCode(text: string): string {
    const match = text.match(/\b\d{6}\b/);
    if (!match) throw new Error(`no 6-digit code found in Mailpit message body: ${text}`);
    return match[0];
  }

  test.describe("Passwordless OTP auth (gateway, real Cognito JWT)", () => {
    test("otp/start -> Mailpit getMessage(id) -> otp/verify -> the resulting token authorizes a protected gateway route", async () => {
      const ctx = await request.newContext({ baseURL: gatewayBaseURL(), extraHTTPHeaders: { "x-e2e-source": "true" } });
      const user = makeUser();

      const reg = await ctx.post("v1/users/register/passwordless", {
        data: { email: user.email, fullName: user.fullName },
      });
      expect(reg.status()).toBe(201);

      const start = await ctx.post("v1/users/otp/start", { data: { email: user.email } });
      expect(start.status()).toBe(200);
      const { session } = await start.json();

      const messages = await waitForEmailTo(user.email, {
        matching: (m) => m.Subject === "Your one-time code",
        description: "the OTP email",
      });
      const full = await getMessage(messages[0]!.ID);
      const code = extractCode(full.Text);

      const verify = await ctx.post("v1/users/otp/verify", { data: { email: user.email, session, code } });
      expect(verify.status()).toBe(200);
      const tokens = await verify.json();
      const bearer = tokens.accessToken ?? tokens.idToken;
      expect(bearer).toBeTruthy();

      // Proves the OTP-issued token is accepted through the gateway exactly
      // like a password-issued one — the JWT authorizer, njs, and nginx all
      // see a normal Cognito token with no awareness OTP was involved.
      const me = await ctx.get("v1/users/me", { headers: { Authorization: `Bearer ${bearer}` } });
      expect(me.status()).toBe(200);
      expect((await me.json()).email).toBe(user.email);

      await ctx.dispose();
    });

    // Mandatory anti-false-PASS guard #1, through the gateway this time: a
    // wrong code must be rejected at the real edge the user hits, not just
    // internally.
    test("otp/verify through the gateway rejects a wrong code with 401 invalid_otp", async () => {
      const ctx = await request.newContext({ baseURL: gatewayBaseURL(), extraHTTPHeaders: { "x-e2e-source": "true" } });
      const user = makeUser();

      await ctx.post("v1/users/register/passwordless", { data: { email: user.email, fullName: user.fullName } });
      const start = await ctx.post("v1/users/otp/start", { data: { email: user.email } });
      const { session } = await start.json();

      await waitForEmailTo(user.email, {
        matching: (m) => m.Subject === "Your one-time code",
        description: "the OTP email",
      });

      const verify = await ctx.post("v1/users/otp/verify", {
        data: { email: user.email, session, code: "999999" },
      });
      expect(verify.status()).toBe(401);
      expect((await verify.json()).error).toBe("invalid_otp");

      await ctx.dispose();
    });

    // Mandatory anti-false-PASS guard #2, through the gateway: a passwordless
    // account must be unreachable via the password login route at the real
    // edge, not just internally.
    test("login through the gateway rejects a PASSWORDLESS user with generic 401 invalid_credentials", async () => {
      const ctx = await request.newContext({ baseURL: gatewayBaseURL(), extraHTTPHeaders: { "x-e2e-source": "true" } });
      const user = makeUser();

      await ctx.post("v1/users/register/passwordless", { data: { email: user.email, fullName: user.fullName } });

      const login = await ctx.post("v1/users/login", { data: { email: user.email, password: "GuessedPassword1!" } });
      expect(login.status()).toBe(401);
      expect((await login.json()).error).toBe("invalid_credentials");

      await ctx.dispose();
    });
  });
  ```

- [ ] **Step 5: Run the gateway E2E project against the rebuilt stack.**
  ```bash
  cd e2e && nvm use && pnpm exec playwright test --project=gateway otp-auth.spec.ts
  ```
  Expect all three tests to pass. This requires `make bootstrap` to have completed (real
  Cognito pool/client, real gateway routes from Task 12, real events pipeline) — per this repo's
  standing convention that gateway E2E is what proves a route reachable at the URL the user
  actually hits, not just internally.

- [ ] **Step 6: Run the full E2E suite (both projects) once more, to confirm no regressions from
  the new routes/DI keys/schema changes across all prior tasks.**
  ```bash
  cd e2e && nvm use && pnpm exec playwright test
  ```
  Expect the full suite green.

- [ ] **Step 7: Commit.**
  ```bash
  git add e2e/support/mailpit-client.ts e2e/tests/gateway/otp-auth.spec.ts
  git commit -m "test(users): gateway E2E for passwordless OTP auth with Mailpit code extraction"
  ```

---

### Task 16: Vault propagation

**Files:**
- Modify: `docs/domains/users/specs/users-service-design.md`
- Modify: `docs/domains/events-pipeline/specs/events-pipeline-design.md`
- Modify: `docs/domains/users/decisions/auth-error-mapping.md`
- Modify: `docs/shared/conventions/testing.md` (only if it tracks per-flow examples; otherwise
  link back without duplicating content — verify in Step 1)
- Modify: `docs/superpowers/specs/2026-08-05-passwordless-otp-auth-design.md` (bidirectional link
  back from `## Related` if not already present, and reconcile it with this plan's route/status-
  code overrides)

**Interfaces:** none (documentation only).

> **Note:** this task is written as a checklist for whoever executes this plan, but per this
> repo's CLAUDE.md, actual vault writes route through the `obsidian-vault` agent — the sole
> writer of `docs/`. This task's steps describe WHAT must be propagated; the executing agent
> should hand this list to `obsidian-vault` rather than editing `docs/` directly.

- [ ] **Step 1: Read the current state of every target note listed above before editing anything,
  to see what already exists vs. what this milestone adds.**
  ```bash
  cat docs/domains/users/specs/users-service-design.md
  cat docs/domains/events-pipeline/specs/events-pipeline-design.md
  cat docs/domains/users/decisions/auth-error-mapping.md
  ```

- [ ] **Step 2: Update `docs/domains/users/specs/users-service-design.md`.**
  Add a section documenting: the `AuthType` enum and `authType` field (Task 1-2); the three new
  routes `POST /v1/users/otp/start`, `POST /v1/users/otp/verify`, `POST
  /v1/users/register/passwordless` (Tasks 9-10) with their request/response shapes and status
  codes (200/401 for the OTP pair, 201/409 for passwordless register); the `CUSTOM_AUTH`-only
  decision with a one-line pointer to why (native `EMAIL_OTP` is bypassed on Floci — link to
  [[2026-08-05-passwordless-otp-auth-design]] rather than re-explaining the empirical evidence);
  and the login guard's 401-not-403 override of the original design spec proposal, stated
  explicitly as the shipped behavior. Bump `updated:` to `2026-08-05`. Add
  `[[2026-08-05-passwordless-otp-auth-design]]` and
  `[[2026-08-05-passwordless-otp-auth]]` to its `## Related` section.

- [ ] **Step 3: Update `docs/domains/events-pipeline/specs/events-pipeline-design.md`.**
  Add: the `AUTH_OTP_REQUESTED` event type and its handler/catalog entry (Tasks 6-7); the
  `redactPayload()` mechanism and why `AUTH_OTP_REQUESTED` is the one type whose payload is
  redacted before persistence (Task 8). Bump `updated:` to `2026-08-05`. Add
  `[[2026-08-05-passwordless-otp-auth-design]]` and `[[2026-08-05-passwordless-otp-auth]]` to its
  `## Related` section.

- [ ] **Step 4: Update `docs/domains/users/decisions/auth-error-mapping.md`.**
  Add `InvalidOtpError` (401, `invalid_otp`) to its catalog of typed auth errors, and record the
  passwordless-login guard as a deliberate application of its anti-enumeration rule: a
  `PASSWORDLESS` user gets the SAME generic 401 `invalid_credentials` as a wrong password, never a
  distinct code — explicitly citing this as the reason the design spec's original 403 proposal was
  overridden. Bump `updated:` to `2026-08-05`. Add `[[2026-08-05-passwordless-otp-auth]]` to its
  `## Related` section.

- [ ] **Step 5: Reconcile `docs/superpowers/specs/2026-08-05-passwordless-otp-auth-design.md`.**
  Confirm its `## Related` section already lists `[[users-service-design]]` and
  `[[events-pipeline-design]]` (it does, per this plan's earlier verification) — add
  `[[2026-08-05-passwordless-otp-auth]]` (this plan) if not already present, so the spec and the
  plan link to each other bidirectionally.

- [ ] **Step 6: Run the vault validator.**
  ```bash
  nvm use && node scripts/validate-vault.mjs
  ```
  Expect no errors: required frontmatter present on every touched note, no broken wikilinks, and
  the propagation gate satisfied (this plan's own `propagates-to:` frontmatter, set at the top of
  this file, lists `[[users-service-design]]`, `[[events-pipeline-design]]`, `[[testing]]`,
  `[[logging-context]]` — all four resolve to real notes). Fix anything reported before
  considering this task done.

- [ ] **Step 7: Commit the vault changes separately from code (vault writes are a distinct
  concern per this repo's CLAUDE.md).**
  ```bash
  git add docs/domains/users/specs/users-service-design.md \
          docs/domains/events-pipeline/specs/events-pipeline-design.md \
          docs/domains/users/decisions/auth-error-mapping.md \
          docs/superpowers/specs/2026-08-05-passwordless-otp-auth-design.md
  git commit -m "docs(vault): propagate passwordless OTP auth decisions into the organized vault"
  ```

---

## Related

- [[2026-08-05-passwordless-otp-auth-design]]
- [[ADR-0017-floci-local]]
- [[auth-error-mapping]]
- [[testing]]
- [[logging-context]]
- [[passwordless-auth-type]] — the shipped `AuthType`/login-guard/error-code decision record.
- [[cognito-custom-auth-triggers]] — the shipped infra decision record.
