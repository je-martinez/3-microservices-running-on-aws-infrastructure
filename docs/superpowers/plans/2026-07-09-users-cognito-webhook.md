---
title: "JE-38 — Cognito identity webhook + identity tables — Implementation Plan"
type: plan
area: users
status: draft
created: 2026-07-09
updated: 2026-07-10
tags: [type/plan, area/users, status/draft, issue/JE-38]
related: ["[[2026-07-09-users-cognito-webhook-design]]", "[[users-service-milestone]]", "[[ADR-0017-floci-local]]", "[[soft-delete]]", "[[audit-fields]]", "[[nano-id]]", "[[db-naming]]", "[[floci-rds-apigw-limits]]"]
---

# JE-38 Cognito Identity Webhook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture Cognito identity data into two Users-service tables through one shared use-case class, reachable from an HTTP webhook (prod) and from `register()` in-process (local).

**Architecture:** A thin Fastify route `POST /v1/webhooks/cognito` verifies a shared secret, parses the payload with Zod, and delegates to `CaptureCognitoIdentityCommand`. `register()` calls that same command directly through Awilix when `NODE_ENV !== "production"`, because Floci never invokes Cognito Lambda triggers. Idempotency comes from a derived, length-prefixed `message_id = sha256(`${sub.length}:${sub}:${triggerSource.length}:${triggerSource}`)`.

**Tech Stack:** Fastify, Zod, Prisma v7 (driver adapters), Awilix DI, Vitest, Playwright, Postgres on Floci.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-09-users-cognito-webhook-design.md` (decisions D1–D8). Idempotency key: `message_id = sha256(`${sub.length}:${sub}:${triggerSource.length}:${triggerSource}`)` — length-prefixed so it stays injective regardless of caller (see D4).
- Scope is **PostConfirmation only**: `PostConfirmation_ConfirmSignUp`, `PostConfirmation_ConfirmForgotPassword`. Do NOT add recurring triggers — D4's key would silently drop them (see the spec's D5 warning).
- The Prisma client extension stamps `id` (from `MODEL_ID_PREFIXES`), audit fields, and enforces soft-delete. It intercepts `create`, `createMany`, `update`, `updateMany`, `upsert`, `delete`, `deleteMany`, `find*`, `count`. Never hand-generate ids or audit fields.
- DB role `users_app` has SELECT/INSERT/UPDATE and **no DELETE** (ADR-0004). New tables inherit this via `ALTER DEFAULT PRIVILEGES` in `infra/environments/local/bootstrap.sh` — no infra change needed.
- Migrations run via `make migrate` (`prisma migrate deploy`, superuser), which `make bootstrap` invokes. Never `prisma migrate dev`.
- Columns are snake_case via `@map`; timestamps are `@db.Timestamptz(6)`. See `services/users/prisma/schema.prisma`.
- `readReplicas` is the outermost Prisma extension: reads route to the replica, writes to the primary. Locally both URLs point at `floci:7001`.
- Node is pinned by `.nvmrc` (24.18.0) — run `nvm use` before any node/pnpm command.
- Implementers write **source code only**. Never run git, never touch Linear. The main session commits via the A/B/C/D/E menu.
- `pnpm lint` must exit 0 (ESLint 9 flat config, added in JE-40).
- E2E-only routes (`e2e-cleanup`, `e2e-identity`) are registered ONLY inside the
  `if (container.cradle.env.E2E_TESTING_ENABLED)` block in `routes.ts`. They must
  never be reachable in production.

---

### Task 1: Add NODE_ENV and WEBHOOK_SECRET to the env schema

**Files:**
- Modify: `services/users/src/shared/config/env.ts`
- Modify: `docker-compose.yml` (the `users` service `environment:` block)
- Test: `services/users/tests/shared/config/env.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `env.NODE_ENV: "development" | "test" | "production"`, `env.WEBHOOK_SECRET: string`.

- [ ] **Step 1: Write the failing test**

Create `services/users/tests/shared/config/env.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseEnv } from "#shared/config/env";

const base = {
  DATABASE_WRITER_URL: "postgres://u:p@h:5432/d",
  DATABASE_READER_URL: "postgres://u:p@h:5432/d",
  COGNITO_USER_POOL_ID: "pool",
  COGNITO_CLIENT_ID: "client",
  AWS_ENDPOINT_URL: "http://localhost:4566",
  AWS_REGION: "us-east-1",
  WEBHOOK_SECRET: "s3cret",
};

describe("env", () => {
  it("defaults NODE_ENV to development", () => {
    expect(parseEnv(base).NODE_ENV).toBe("development");
  });

  it("accepts production", () => {
    expect(parseEnv({ ...base, NODE_ENV: "production" }).NODE_ENV).toBe("production");
  });

  it("rejects an unknown NODE_ENV", () => {
    expect(() => parseEnv({ ...base, NODE_ENV: "staging" })).toThrow();
  });

  it("requires WEBHOOK_SECRET", () => {
    const { WEBHOOK_SECRET: _omit, ...without } = base;
    expect(() => parseEnv(without)).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd services/users && nvm use && pnpm vitest run tests/shared/config/env.test.ts`
Expected: FAIL — `NODE_ENV` is undefined and `WEBHOOK_SECRET` is not rejected, because neither is in the schema yet.

- [ ] **Step 3: Add both fields to the schema**

In `services/users/src/shared/config/env.ts`, add to the `z.object({...})`:

```ts
  // Gates the local identity capture in register() (spec D7). Defaults to
  // "development": if a prod deploy forgets to set it, register() also captures,
  // but the Lambda and register() derive the same message_id (D4), so the
  // duplicate is swallowed by ON CONFLICT DO NOTHING. Benign, not data loss.
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Guards POST /v1/webhooks/cognito (spec D1, D8). Required in EVERY
  // environment so the endpoint can never be deployed unprotected by omission.
  // Prod sources it from Secrets Manager (ADR-0007); compose supplies a
  // development value.
  WEBHOOK_SECRET: z.string().min(1),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd services/users && pnpm vitest run tests/shared/config/env.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Supply the secret in compose**

In `docker-compose.yml`, in the `users` service `environment:` list, after `E2E_TESTING_ENABLED`:

```yaml
      # Guards POST /v1/webhooks/cognito. Local-only value: the endpoint is not
      # exposed outside the compose network. Prod reads this from Secrets
      # Manager (ADR-0007) — see the separate infra issue.
      - WEBHOOK_SECRET=local-dev-secret
```

- [ ] **Step 6: Verify the service still boots**

Run: `docker compose up -d --build users && sleep 5 && curl -s http://localhost:3000/v1/health`
Expected: `{"status":"ok"}` — Zod validation passes with the new required field.

- [ ] **Step 7: Lint and hand off for commit**

Run: `cd services/users && pnpm lint`
Expected: exit 0. Leave the change in the working tree; the main session commits.

---

### Task 2: Add the two Prisma models and their id prefixes

**Files:**
- Modify: `services/users/prisma/schema.prisma`
- Modify: `services/users/src/shared/id/nano-id.ts`
- Create: `services/users/prisma/migrations/<timestamp>_cognito_identity/migration.sql` (generated)

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma models `UsersCognitoData` and `UsersCognitoEvent`; `MODEL_ID_PREFIXES.UsersCognitoData = "ucd_"`, `MODEL_ID_PREFIXES.UsersCognitoEvent = "cge_"`; `User.cognitoSub String? @unique` (denormalized convenience, see spec [Data model](../specs/2026-07-09-users-cognito-webhook-design.md#data-model)).

**Note (additive change to `User`):** this task's migration now also ALTERs the existing `users`
table — adding the nullable, unique `cognito_sub` column plus its unique index — in addition to
CREATEing the two new tables. Nullable because the migration runs over a table that may already
hold rows; see the spec's [Data model](../specs/2026-07-09-users-cognito-webhook-design.md#data-model)
for the full rationale (including why `User.cognitoSub` and `UsersCognitoData.cognitoSub` cannot
diverge). This does not touch the existing `users_cognito_data`/`users_cognito_events` chain.

- [ ] **Step 1: Add the id prefixes**

`services/users/src/shared/id/nano-id.ts` — the file's own comment already anticipates these names:

```ts
export const MODEL_ID_PREFIXES: Record<string, string> = {
  User: "usr_",
  UsersCognitoData: "ucd_",
  UsersCognitoEvent: "cge_",
};
```

- [ ] **Step 2: Add the models**

Append to `services/users/prisma/schema.prisma`:

```prisma
// 1:1 identity snapshot per user. Upserted on every accepted webhook event.
model UsersCognitoData {
  id            String    @id
  userId        String    @unique @map("user_id")
  cognitoSub    String    @unique @map("cognito_sub")
  email         String
  clientId      String    @map("client_id")
  lastEventType String    @map("last_event_type")
  rawPayload    Json      @map("raw_payload")
  createdBy     String?   @map("created_by")
  createdAt     DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedBy     String?   @map("updated_by")
  updatedAt     DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)
  deletedBy     String?   @map("deleted_by")
  deletedAt     DateTime? @map("deleted_at") @db.Timestamptz(6)

  user   User                 @relation(fields: [userId], references: [id])
  events UsersCognitoEvent[]

  @@map("users_cognito_data")
  @@index([deletedAt])
}

// Event log. `messageId` is derived (spec D4): a length-prefixed sha256 of
// (sub, triggerSource) — see message-id.ts. At PostConfirmation-only scope
// this yields one row per (user, trigger type).
model UsersCognitoEvent {
  id         String    @id
  cognitoSub String    @map("cognito_sub")
  eventType  String    @map("event_type")
  messageId  String    @unique @map("message_id")
  rawPayload Json      @map("raw_payload")
  createdBy  String?   @map("created_by")
  createdAt  DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedBy  String?   @map("updated_by")
  updatedAt  DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)
  deletedBy  String?   @map("deleted_by")
  deletedAt  DateTime? @map("deleted_at") @db.Timestamptz(6)

  data UsersCognitoData @relation(fields: [cognitoSub], references: [cognitoSub])

  @@map("users_cognito_events")
  @@index([deletedAt])
}
```

Add the back-relation to the existing `User` model (Prisma requires both sides), plus the new
`cognitoSub` column (additive — see the spec's [Data
model](../specs/2026-07-09-users-cognito-webhook-design.md#data-model) for the nullable/unique
rationale and why it cannot diverge from `UsersCognitoData.cognitoSub`):

```prisma
  cognitoSub  String?           @unique @map("cognito_sub")
  cognitoData UsersCognitoData?
```

- [ ] **Step 3: Generate the migration**

Run from the repo root:

```bash
nvm use
docker build --target deps -t 3mrai-users:deps -f services/users/Dockerfile .
docker run --rm --network 3mrai_3mrai-network \
  -e DATABASE_WRITER_URL="postgres://test:test@floci:7001/users" \
  -v "$PWD/services/users/prisma:/app/services/users/prisma" \
  -w /app/services/users 3mrai-users:deps \
  node node_modules/prisma/build/index.js migrate dev --name cognito_identity --create-only --schema=./prisma/schema.prisma
```

`--create-only` writes the SQL without applying it. Read the generated
`services/users/prisma/migrations/*_cognito_identity/migration.sql` and confirm it
creates both tables with `TIMESTAMPTZ(6)` columns and the two unique indexes
(`users_cognito_data_cognito_sub_key`, `users_cognito_events_message_id_key`) — and this time also
confirm it ALTERs the existing `users` table: `ADD COLUMN "cognito_sub" TEXT` (nullable — no
`NOT NULL`) plus its own unique index (`users_cognito_sub_key`). If the `users` ALTER is missing,
the `User.cognitoSub` field from Step 2 wasn't picked up — re-check the schema before applying.

- [ ] **Step 4: Apply it**

Run: `make migrate`
Expected: `1 migration found` → applies the new one → `Prisma migrations applied.`

- [ ] **Step 5: Verify the tables and the grant inheritance**

```bash
docker run --rm --network 3mrai_3mrai-network postgres:14.6-alpine sh -c \
  "PGPASSWORD=test psql -h floci -p 7001 -U test -d users -tAc \"select tablename from pg_tables where schemaname='public' order by 1\""
```
Expected: `_prisma_migrations`, `users`, `users_cognito_data`, `users_cognito_events`.

Then confirm `users_app` inherited SELECT/INSERT/UPDATE but still cannot DELETE
(the password is in the git-ignored `infra/environments/local/.app-db-secret`):

```bash
PW=$(sed 's/.*=//' infra/environments/local/.app-db-secret | tr -d '\n')
docker run --rm --network 3mrai_3mrai-network -e PW="$PW" postgres:14.6-alpine sh -c \
  'PGPASSWORD="$PW" psql -h floci -p 7001 -U users_app -d users -c "delete from users_cognito_events"'
```
Expected: `ERROR: permission denied for table users_cognito_events`.

- [ ] **Step 6: Regenerate the client and typecheck**

Run: `cd services/users && pnpm prisma generate && pnpm build`
Expected: both exit 0. `pnpm build` proves the generated types compile.

---

### Task 3: The Zod payload contract

**Files:**
- Create: `services/users/src/features/users/webhooks/cognito-payload.ts`
- Test: `services/users/tests/features/users/webhooks/cognito-payload.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `cognitoWebhookPayloadSchema` (Zod schema) and `type CognitoWebhookPayload`.

- [ ] **Step 1: Write the failing test**

Create `services/users/tests/features/users/webhooks/cognito-payload.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { cognitoWebhookPayloadSchema } from "#features/users/webhooks/cognito-payload";

const valid = {
  version: "1",
  triggerSource: "PostConfirmation_ConfirmSignUp",
  region: "us-east-1",
  userPoolId: "us-east-1_abc123",
  userName: "a@b.com",
  callerContext: { awsSdkVersion: "aws-sdk-unknown", clientId: "cli_1" },
  request: {
    userAttributes: {
      sub: "7904d681-f590-4b4d-bbce-15348a898873",
      email: "a@b.com",
      email_verified: "true",
    },
  },
};

describe("cognitoWebhookPayloadSchema", () => {
  it("accepts a real PostConfirmation event", () => {
    expect(cognitoWebhookPayloadSchema.parse(valid).request.userAttributes.sub)
      .toBe("7904d681-f590-4b4d-bbce-15348a898873");
  });

  it("accepts ConfirmForgotPassword", () => {
    const p = { ...valid, triggerSource: "PostConfirmation_ConfirmForgotPassword" };
    expect(() => cognitoWebhookPayloadSchema.parse(p)).not.toThrow();
  });

  it("rejects an unsupported trigger (spec D5)", () => {
    const p = { ...valid, triggerSource: "PostAuthentication_Authentication" };
    expect(() => cognitoWebhookPayloadSchema.parse(p)).toThrow();
  });

  it("rejects a non-uuid sub", () => {
    const p = { ...valid, request: { userAttributes: { ...valid.request.userAttributes, sub: "nope" } } };
    expect(() => cognitoWebhookPayloadSchema.parse(p)).toThrow();
  });

  it("keeps unknown custom attributes (raw_payload must retain everything)", () => {
    const p = {
      ...valid,
      request: { userAttributes: { ...valid.request.userAttributes, "custom:tier": "gold" } },
    };
    const parsed = cognitoWebhookPayloadSchema.parse(p);
    expect((parsed.request.userAttributes as Record<string, unknown>)["custom:tier"]).toBe("gold");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd services/users && pnpm vitest run tests/features/users/webhooks/cognito-payload.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the schema**

Create `services/users/src/features/users/webhooks/cognito-payload.ts`:

```ts
import { z } from "zod";

// Mirrors the real Cognito PostConfirmation event (verified against the AWS docs
// and a live Floci pool). The event carries NO timestamp and no per-delivery
// unique field — a retry is byte-identical. That is why the idempotency key is
// derived rather than transmitted (spec D4).
//
// The triggerSource enum is the gate enforcing spec D5: PostConfirmation only.
// Adding a recurring trigger (e.g. PostAuthentication) requires reworking the
// derived message_id first, or only the first occurrence would ever be stored.
export const cognitoWebhookPayloadSchema = z.object({
  version: z.string(),
  triggerSource: z.enum([
    "PostConfirmation_ConfirmSignUp",
    "PostConfirmation_ConfirmForgotPassword",
  ]),
  region: z.string(),
  userPoolId: z.string(),
  userName: z.string(),
  callerContext: z.object({
    awsSdkVersion: z.string(),
    clientId: z.string(),
  }),
  request: z.object({
    // passthrough: raw_payload must retain custom attributes we don't model.
    userAttributes: z
      .object({
        sub: z.string().uuid(),
        email: z.string().email(),
        email_verified: z.union([z.boolean(), z.string()]).optional(),
      })
      .passthrough(),
  }),
});

export type CognitoWebhookPayload = z.infer<typeof cognitoWebhookPayloadSchema>;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd services/users && pnpm vitest run tests/features/users/webhooks/cognito-payload.test.ts`
Expected: PASS, 5 tests.

---

### Task 4: Derive the idempotency key

**Files:**
- Create: `services/users/src/features/users/webhooks/message-id.ts`
- Test: `services/users/tests/features/users/webhooks/message-id.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `deriveMessageId(sub: string, triggerSource: string): string`.

- [ ] **Step 1: Write the failing test**

Create `services/users/tests/features/users/webhooks/message-id.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deriveMessageId } from "#features/users/webhooks/message-id";

describe("deriveMessageId", () => {
  it("is deterministic — a Cognito retry hashes identically", () => {
    const a = deriveMessageId("sub-1", "PostConfirmation_ConfirmSignUp");
    const b = deriveMessageId("sub-1", "PostConfirmation_ConfirmSignUp");
    expect(a).toBe(b);
  });

  it("differs by sub", () => {
    expect(deriveMessageId("sub-1", "PostConfirmation_ConfirmSignUp"))
      .not.toBe(deriveMessageId("sub-2", "PostConfirmation_ConfirmSignUp"));
  });

  it("differs by triggerSource", () => {
    expect(deriveMessageId("sub-1", "PostConfirmation_ConfirmSignUp"))
      .not.toBe(deriveMessageId("sub-1", "PostConfirmation_ConfirmForgotPassword"));
  });

  it("returns a 64-char lowercase hex sha256", () => {
    expect(deriveMessageId("sub-1", "PostConfirmation_ConfirmSignUp")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is injective across the delimiter — ('a:b','c') and ('a','b:c') must differ", () => {
    expect(deriveMessageId("a:b", "c")).not.toBe(deriveMessageId("a", "b:c"));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd services/users && pnpm vitest run tests/features/users/webhooks/message-id.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `services/users/src/features/users/webhooks/message-id.ts`:

```ts
import { createHash } from "node:crypto";

// Spec D4. The Cognito event carries no timestamp and no per-delivery unique
// field, so the key is derived from what the event *does* carry. A retry
// produces the same hash and is swallowed by ON CONFLICT DO NOTHING — exactly
// the duplicate we mean to prevent.
//
// Length-prefixed, NOT a naive `${sub}:${triggerSource}` join — do not
// "simplify" this back. A plain `:` join is not injective:
// deriveMessageId("a:b", "c") and deriveMessageId("a", "b:c") both hash the
// identical string "a:b:c", producing the identical digest. That collision is
// unreachable through the current Zod-validated caller (sub is a uuid,
// triggerSource is a closed enum, neither can contain ":"), but this function
// must not depend on its caller for correctness.
//
// Consequence (spec D5 warning): at PostConfirmation-only scope this stores one
// row per (user, trigger type). A recurring trigger would collide with itself.
export function deriveMessageId(sub: string, triggerSource: string): string {
  return createHash("sha256")
    .update(`${sub.length}:${sub}:${triggerSource.length}:${triggerSource}`)
    .digest("hex");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd services/users && pnpm vitest run tests/features/users/webhooks/message-id.test.ts`
Expected: PASS, 5 tests.

---

### Task 5: The shared CaptureCognitoIdentityCommand

> [!danger] Redesigned after code review — read before implementing
> The original design had this command write the `users_cognito_events` row **before** looking up
> the user, on the theory that a `pending_user` outcome should still leave an audit trail. A code
> review found that cannot work: `users_cognito_events.cognito_sub` is a **NOT NULL** foreign key
> to `users_cognito_data.cognito_sub`. Verified live against Floci Postgres — inserting an event
> whose snapshot doesn't exist yet throws a foreign-key violation (constraint
> `users_cognito_events_cognito_sub_fkey`), not the `P2002` the original code expected. The
> event-first ordering and the `pending_user` outcome were both dead against the real schema. See
> the design spec's [Persistence: a single nested
> write](../specs/2026-07-09-users-cognito-webhook-design.md#persistence-a-single-nested-write)
> for the fix, verified live on both paths (first delivery and retry). This task below reflects
> that fix — implement it as written, not as an older reading of the spec might suggest.

**Files:**
- Create: `services/users/src/features/users/webhooks/capture-cognito-identity.ts`
- Modify: `services/users/src/shared/di/awilix-container.ts`
- Test: `services/users/tests/features/users/webhooks/capture-cognito-identity.test.ts`

**Interfaces:**
- Consumes: `deriveMessageId` (Task 4), `CognitoWebhookPayload` (Task 3), the Prisma models (Task 2).
- Produces: `class CaptureCognitoIdentityCommand` with
  `execute(payload: CognitoWebhookPayload): Promise<{ status: "captured" | "duplicate" }>`
  (no `pending_user` — see below), plus a thrown `NoMatchingUserError` when no `users` row matches.
  Registered in the Awilix cradle as `captureCognitoIdentityCommand`.

**Semantics (from the spec's error table):**
- `captured` — a single `usersCognitoData.upsert` ran, with the event nested via
  `events: { create: [...] }` in both the `create` and `update` branches. Snapshot and event are
  written in one transaction (Prisma's nested-write guarantee), so the event is always a child of
  its snapshot — no FK ordering problem.
- `duplicate` — the nested `events.create` collided on the unique `message_id` index (`P2002`).
  Idempotent, not an error (spec D4).
- No matching `users` row for the payload email — **not** a result status. The command throws
  before writing anything. Both real flows (local `register.ts`, prod's PostConfirmation Lambda)
  guarantee the `users` row already exists before capture runs, so this is an unexpected
  condition, not a routine outcome to model as a success variant. `pending_user` is **removed**.

Note: the lookup below is by email; now that `User.cognitoSub` exists it could look up by sub
instead, but that's a future refactor, out of scope here — the email lookup stays as-is.

- [ ] **Step 1: Write the failing test**

Create `services/users/tests/features/users/webhooks/capture-cognito-identity.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { CaptureCognitoIdentityCommand, NoMatchingUserError } from "#features/users/webhooks/capture-cognito-identity";
import { deriveMessageId } from "#features/users/webhooks/message-id";

const payload = {
  version: "1",
  triggerSource: "PostConfirmation_ConfirmSignUp" as const,
  region: "us-east-1",
  userPoolId: "pool",
  userName: "a@b.com",
  callerContext: { awsSdkVersion: "v3", clientId: "cli_1" },
  request: {
    userAttributes: {
      sub: "7904d681-f590-4b4d-bbce-15348a898873",
      email: "a@b.com",
      email_verified: "true",
    },
  },
};

function dbMock(over: Record<string, unknown> = {}) {
  return {
    user: { findFirst: vi.fn(async () => ({ id: "usr_1" })) },
    usersCognitoData: { upsert: vi.fn(async () => ({ id: "ucd_1" })) },
    ...over,
  } as any;
}

describe("CaptureCognitoIdentityCommand", () => {
  it("captures: a single upsert nests the event", async () => {
    const db = dbMock();
    const res = await new CaptureCognitoIdentityCommand({ db }).execute(payload);
    expect(res.status).toBe("captured");
    expect(db.usersCognitoData.upsert).toHaveBeenCalledOnce();
    const args = db.usersCognitoData.upsert.mock.calls[0][0];
    expect(args.create.events.create[0].messageId).toBe(
      deriveMessageId(payload.request.userAttributes.sub, payload.triggerSource),
    );
    expect(args.update.events.create[0].messageId).toBe(
      deriveMessageId(payload.request.userAttributes.sub, payload.triggerSource),
    );
  });

  it("returns duplicate when the nested event write collides on message_id (P2002)", async () => {
    const db = dbMock({
      usersCognitoData: {
        upsert: vi.fn(async () => {
          throw Object.assign(new Error("unique"), {
            code: "P2002",
            meta: { target: ["message_id"] },
          });
        }),
      },
    });
    const res = await new CaptureCognitoIdentityCommand({ db }).execute(payload);
    expect(res.status).toBe("duplicate");
  });

  it("re-throws a P2002 that does NOT target message_id (narrow-catch guard)", async () => {
    const db = dbMock({
      usersCognitoData: {
        upsert: vi.fn(async () => {
          throw Object.assign(new Error("unique"), {
            code: "P2002",
            meta: { target: ["users_cognito_data_pkey"] },
          });
        }),
      },
    });
    await expect(new CaptureCognitoIdentityCommand({ db }).execute(payload)).rejects.toThrow();
  });

  it("throws NoMatchingUserError and does not upsert when no users row matches", async () => {
    const db = dbMock({ user: { findFirst: vi.fn(async () => null) } });
    await expect(new CaptureCognitoIdentityCommand({ db }).execute(payload))
      .rejects.toBeInstanceOf(NoMatchingUserError);
    expect(db.usersCognitoData.upsert).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd services/users && pnpm vitest run tests/features/users/webhooks/capture-cognito-identity.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the command**

Create `services/users/src/features/users/webhooks/capture-cognito-identity.ts`:

```ts
import type { Db } from "#shared/db/prisma";
import { runAsActor } from "#shared/audit/actor-context";
import { MODEL_ID_PREFIXES, generateId } from "#shared/id/nano-id";
import { deriveMessageId } from "./message-id.ts";
import type { CognitoWebhookPayload } from "./cognito-payload.ts";

export type CaptureResult = { status: "captured" | "duplicate" };

// Thrown when no `users` row matches the payload's email. Both real flows
// guarantee the user already exists before capture runs (local: register.ts
// creates the user before calling this command; prod: Cognito's
// PostConfirmation trigger fires only after the users service already
// persisted the user during registration). This is therefore an unexpected
// condition, not a routine outcome — the route maps it to an error response,
// and in prod Cognito retries the trigger, so a transient race self-heals.
export class NoMatchingUserError extends Error {
  constructor(email: string) {
    super(`No users row found for email ${email}`);
    this.name = "NoMatchingUserError";
  }
}

// The single persistence path for Cognito identity capture (spec D2). Reached
// two ways: over HTTP from the prod Lambda shim, and in-process from register()
// when NODE_ENV !== "production". Nothing here knows about HTTP.
//
// Constructor-injected from the Awilix cradle (PROXY injection mode).
export class CaptureCognitoIdentityCommand {
  private readonly db: Db;

  constructor({ db }: { db: Db }) {
    this.db = db;
  }

  async execute(payload: CognitoWebhookPayload): Promise<CaptureResult> {
    const { sub, email } = payload.request.userAttributes;
    const messageId = deriveMessageId(sub, payload.triggerSource);

    // Reserve both ids up front. The generated Prisma create-input types
    // require `id` — these models have no `@default`, matching
    // register.ts:38 — so the extension's auto-stamp does NOT cover a
    // literal object-literal create like this one; omitting `id` here does
    // not compile (TS2322).
    const snapshotId = generateId(MODEL_ID_PREFIXES.UsersCognitoData);
    const eventId = generateId(MODEL_ID_PREFIXES.UsersCognitoEvent);

    // Audit fields (createdBy/updatedBy) are still stamped by the Prisma
    // extension; never set those here. `runAsActor` names the actor for this
    // non-request-bound write.
    return runAsActor("cognito-webhook", async () => {
      // No `users` row for this email is not a routine outcome (see
      // NoMatchingUserError) — fail before writing anything, rather than
      // persisting a partial snapshot or event.
      const user = await this.db.user.findFirst({ where: { email } });
      if (!user) throw new NoMatchingUserError(email);

      // One nested write: usersCognitoData.upsert with the event nested via
      // events: { create: [...] } in BOTH branches. Prisma runs this as a
      // single transaction (nested writes have transactional guarantees —
      // rollback on any failure), inserting the parent snapshot before the
      // child event, so the NOT NULL FK on
      // users_cognito_events.cognito_sub is satisfied by construction.
      // Verified live against Floci Postgres on both the first-delivery
      // (create) and retry (update) paths — spec "Persistence: a single
      // nested write".
      try {
        await this.db.usersCognitoData.upsert({
          where: { cognitoSub: sub },
          create: {
            id: snapshotId,
            userId: user.id,
            cognitoSub: sub,
            email,
            clientId: payload.callerContext.clientId,
            lastEventType: payload.triggerSource,
            rawPayload: payload as unknown as object,
            events: {
              create: [
                {
                  id: eventId,
                  eventType: payload.triggerSource,
                  messageId,
                  rawPayload: payload as unknown as object,
                },
              ],
            },
          },
          update: {
            email,
            clientId: payload.callerContext.clientId,
            lastEventType: payload.triggerSource,
            rawPayload: payload as unknown as object,
            events: {
              create: [
                {
                  id: eventId,
                  eventType: payload.triggerSource,
                  messageId,
                  rawPayload: payload as unknown as object,
                },
              ],
            },
          },
        });
        return { status: "captured" };
      } catch (err) {
        // P2002 on the message_id unique index = this exact event was
        // already recorded (spec D4). Idempotent, not an error. Narrow
        // catch: confirm it is the message_id constraint, not some other
        // unique (e.g. the snapshot's own pkey or its cognito_sub unique
        // index), before treating it as a duplicate — otherwise re-throw.
        const isP2002 = (err as { code?: string }).code === "P2002";
        const target = (err as { meta?: { target?: string[] | string } }).meta?.target;
        const targetsMessageId = Array.isArray(target)
          ? target.includes("message_id")
          : typeof target === "string" && target.includes("message_id");
        if (isP2002 && targetsMessageId) return { status: "duplicate" };
        throw err;
      }
    });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd services/users && pnpm vitest run tests/features/users/webhooks/capture-cognito-identity.test.ts`
Expected: PASS, 4 tests. If the actual count differs once written, record the real number here —
do not guess; run the suite and use what it reports.

- [ ] **Step 5: Register it in the DI container**

In `services/users/src/shared/di/awilix-container.ts`:

Add the import next to the other command imports:
```ts
import { CaptureCognitoIdentityCommand } from "#features/users/webhooks/capture-cognito-identity";
```

Add to the `Cradle` interface declaration:
```ts
    captureCognitoIdentityCommand: CaptureCognitoIdentityCommand;
```

Add inside `registerServices()`'s `diContainer.register({...})`:
```ts
    captureCognitoIdentityCommand: asClass(CaptureCognitoIdentityCommand, { lifetime: Lifetime.SCOPED }),
```

- [ ] **Step 6: Typecheck**

Run: `cd services/users && pnpm build`
Expected: exit 0.

---

### Task 6: The thin HTTP route

> [!danger] Redesigned after code review — read before implementing
> Task 5's `pending_user` outcome is gone (see that task's callout). This route no longer maps
> `pending_user` to `202`. Instead, `CaptureCognitoIdentityCommand.execute` throws
> `NoMatchingUserError` when no `users` row matches, and this route maps that to **`500`**: a
> confirmed Cognito identity with no matching `users` row is a server-side inconsistency, not a
> client error, given both real flows guarantee the user exists before capture runs (see Task 5).
> `404`/`409` are defensible alternatives (see below) but `500` was chosen; do not silently
> substitute one of the others without updating this note and the route tests.

**Files:**
- Create: `services/users/src/features/users/webhooks/verify-secret.ts`
- Modify: `services/users/src/features/users/http/routes.ts`
- Test: `services/users/tests/features/users/webhooks/verify-secret.test.ts`
- Test: `services/users/tests/features/users/http/routes.test.ts` (extend)

**Interfaces:**
- Consumes: `captureCognitoIdentityCommand` (Task 5), `cognitoWebhookPayloadSchema` (Task 3), `env.WEBHOOK_SECRET` (Task 1).
- Produces: `POST /v1/webhooks/cognito`; `verifyWebhookSecret(provided: string | undefined, expected: string): boolean`.

**Response mapping:**
- `401` — missing/incorrect `x-webhook-secret` (unchanged).
- `422` — payload fails Zod, including an unsupported `triggerSource` (unchanged).
- `200 { status: "captured" }` / `200 { status: "duplicate" }` — from the command (unchanged
  status codes, `pending_user` removed from the union).
- `500` — the command threw `NoMatchingUserError`. **Why 500, not 404/409:** the caller of this
  route is either the prod Cognito Lambda shim or the local in-process call from `register()` —
  never an end user submitting a resource identifier, so `404` ("resource not found") and `409`
  ("conflict with current state") both stretch their usual REST meaning here. A confirmed Cognito
  identity with no matching `users` row means something upstream is inconsistent (the two systems
  disagreed about whether the user exists), which is what `500` conventionally signals. Cognito
  retries the trigger in prod on a non-2xx, so a transient race self-heals without operator
  intervention.

- [ ] **Step 1: Write the failing test for the secret comparison**

Create `services/users/tests/features/users/webhooks/verify-secret.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { verifyWebhookSecret } from "#features/users/webhooks/verify-secret";

describe("verifyWebhookSecret", () => {
  it("accepts an exact match", () => {
    expect(verifyWebhookSecret("s3cret", "s3cret")).toBe(true);
  });
  it("rejects a mismatch", () => {
    expect(verifyWebhookSecret("wrong", "s3cret")).toBe(false);
  });
  it("rejects a missing header without throwing", () => {
    expect(verifyWebhookSecret(undefined, "s3cret")).toBe(false);
  });
  it("rejects a different-length value without throwing", () => {
    expect(verifyWebhookSecret("s", "s3cret")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd services/users && pnpm vitest run tests/features/users/webhooks/verify-secret.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the timing-safe comparison**

Create `services/users/src/features/users/webhooks/verify-secret.ts`:

```ts
import { timingSafeEqual } from "node:crypto";

// Spec D1. `timingSafeEqual` throws when the buffers differ in length, which
// would itself leak length — so compare lengths first and return false, and only
// then do the constant-time comparison on equal-length buffers.
export function verifyWebhookSecret(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd services/users && pnpm vitest run tests/features/users/webhooks/verify-secret.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing route tests**

Append to `services/users/tests/features/users/http/routes.test.ts`. Note the
existing `testContainer()` helper registers `env` as `asValue({...})` — extend it
to include `WEBHOOK_SECRET` and register `captureCognitoIdentityCommand`:

```ts
import { cognitoWebhookPayloadSchema } from "#features/users/webhooks/cognito-payload";

function webhookContainer(capture = vi.fn(async () => ({ status: "captured" as const }))) {
  const container = createContainer({ injectionMode: "PROXY" });
  container.register({
    env: asValue({ E2E_TESTING_ENABLED: false, WEBHOOK_SECRET: "s3cret" } as any),
    registerUserCommand: asValue({ execute: vi.fn() } as any),
    loginUserCommand: asValue({ execute: vi.fn() } as any),
    userQueryService: asValue({ getMe: vi.fn(), getUserById: vi.fn() } as any),
    updateProfileCommand: asValue({ execute: vi.fn() } as any),
    e2eCleanupCommand: asValue({ execute: vi.fn() } as any),
    captureCognitoIdentityCommand: asValue({ execute: capture } as any),
  });
  return { container, capture };
}

const validEvent = {
  version: "1",
  triggerSource: "PostConfirmation_ConfirmSignUp",
  region: "us-east-1",
  userPoolId: "pool",
  userName: "a@b.com",
  callerContext: { awsSdkVersion: "v3", clientId: "cli_1" },
  request: {
    userAttributes: {
      sub: "7904d681-f590-4b4d-bbce-15348a898873",
      email: "a@b.com",
      email_verified: "true",
    },
  },
};

describe("POST /v1/webhooks/cognito", () => {
  it("401s without the secret, and does not call the command", async () => {
    const { container, capture } = webhookContainer();
    const app = buildApp(container);
    const res = await app.inject({ method: "POST", url: "/v1/webhooks/cognito", payload: validEvent });
    expect(res.statusCode).toBe(401);
    expect(capture).not.toHaveBeenCalled();
  });

  it("401s with a wrong secret", async () => {
    const { container } = webhookContainer();
    const app = buildApp(container);
    const res = await app.inject({
      method: "POST", url: "/v1/webhooks/cognito",
      headers: { "x-webhook-secret": "wrong" }, payload: validEvent,
    });
    expect(res.statusCode).toBe(401);
  });

  it("422s on an unsupported trigger", async () => {
    const { container, capture } = webhookContainer();
    const app = buildApp(container);
    const res = await app.inject({
      method: "POST", url: "/v1/webhooks/cognito",
      headers: { "x-webhook-secret": "s3cret" },
      payload: { ...validEvent, triggerSource: "PostAuthentication_Authentication" },
    });
    expect(res.statusCode).toBe(422);
    expect(capture).not.toHaveBeenCalled();
  });

  it("200s on capture", async () => {
    const { container } = webhookContainer();
    const app = buildApp(container);
    const res = await app.inject({
      method: "POST", url: "/v1/webhooks/cognito",
      headers: { "x-webhook-secret": "s3cret" }, payload: validEvent,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "captured" });
  });

  it("200s on a duplicate — idempotent, not an error", async () => {
    const { container } = webhookContainer(vi.fn(async () => ({ status: "duplicate" as const })));
    const app = buildApp(container);
    const res = await app.inject({
      method: "POST", url: "/v1/webhooks/cognito",
      headers: { "x-webhook-secret": "s3cret" }, payload: validEvent,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "duplicate" });
  });

  it("500s when the command reports no matching users row (NoMatchingUserError)", async () => {
    const { container } = webhookContainer(
      vi.fn(async () => {
        throw new NoMatchingUserError("a@b.com");
      }),
    );
    const app = buildApp(container);
    const res = await app.inject({
      method: "POST", url: "/v1/webhooks/cognito",
      headers: { "x-webhook-secret": "s3cret" }, payload: validEvent,
    });
    expect(res.statusCode).toBe(500);
  });
});
```

`webhookContainer`'s import list at the top of the file needs `NoMatchingUserError` added:

```ts
import { NoMatchingUserError } from "#features/users/webhooks/capture-cognito-identity";
```

- [ ] **Step 6: Run them to verify they fail**

Run: `cd services/users && pnpm vitest run tests/features/users/http/routes.test.ts`
Expected: FAIL — the route 404s.

- [ ] **Step 7: Add the route**

In `services/users/src/features/users/http/routes.ts`, add the imports:

```ts
import { cognitoWebhookPayloadSchema } from "../webhooks/cognito-payload.ts";
import { verifyWebhookSecret } from "../webhooks/verify-secret.ts";
```

And register the route after `PATCH /v1/users/me`:

```ts
  // Thin layer (spec D2): verify the shared secret, validate, delegate. The
  // command is the single persistence path — register() calls the same class
  // in-process when NODE_ENV !== "production", because Floci never invokes
  // Cognito Lambda triggers (ADR-0017).
  //
  // This is a PUBLIC route at the API Gateway (no JWT authorizer): its callers
  // are the Cognito Lambda shim and the service itself, never a user with a JWT.
  // The shared secret is its only guard.
  app.post("/v1/webhooks/cognito", async (req, reply) => {
    const { env: e, captureCognitoIdentityCommand } = req.diScope.cradle;

    if (!verifyWebhookSecret(req.headers["x-webhook-secret"] as string | undefined, e.WEBHOOK_SECRET)) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const parsed = cognitoWebhookPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: "invalid_payload", details: parsed.error.issues });
    }

    try {
      const { status } = await captureCognitoIdentityCommand.execute(parsed.data);
      return reply.code(200).send({ status });
    } catch (err) {
      if (err instanceof NoMatchingUserError) {
        // A confirmed Cognito identity with no matching users row is a
        // server-side inconsistency, not a client error (see this task's
        // header note for the 404/409 alternatives considered). Cognito
        // retries the trigger in prod on a non-2xx, so a transient race
        // self-heals.
        req.log.error({ err }, "cognito webhook: no matching users row");
        return reply.code(500).send({ error: "no_matching_user" });
      }
      throw err;
    }
  });
```

Add the import for `NoMatchingUserError` alongside the other two:

```ts
import { NoMatchingUserError } from "../webhooks/capture-cognito-identity.ts";
```

- [ ] **Step 8: Run the route tests**

Run: `cd services/users && pnpm vitest run tests/features/users/http/routes.test.ts`
Expected: PASS — the six new tests (401 × 2, 422, 200 captured, 200 duplicate, 500 no-matching-user)
plus the existing ones. If the actual new-test count differs once written, record the real number
— do not guess.

---

### Task 7: Widen signUp() and wire the local trigger into register()

**Files:**
- Modify: `services/users/src/shared/auth/auth-provider.ts`
- Modify: `services/users/src/shared/auth/cognito-auth-provider.ts`
- Modify: `services/users/src/features/users/commands/register.ts`
- Test: `services/users/tests/features/users/commands/register.test.ts` (extend or create)

**Interfaces:**
- Consumes: `captureCognitoIdentityCommand` (Task 5), `env.NODE_ENV` (Task 1).
- Produces: `AuthProvider.signUp(email, password): Promise<CognitoSignUpResult>` where
  `CognitoSignUpResult = { sub: string; email: string; emailVerified?: string; userPoolId: string; clientId: string }`.

**Blocker this task fixes:** `cognito-auth-provider.ts:36` currently falls back to
returning the *email* when no `sub` attribute is found — a missing `sub` would
silently masquerade as one, and would then be hashed into a bogus `message_id`.
Make it throw instead.

- [ ] **Step 1: Write the failing tests**

Create `services/users/tests/features/users/commands/register.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { RegisterUserCommand } from "#features/users/commands/register";

function deps(nodeEnv: "development" | "production", capture = vi.fn(async () => ({ status: "captured" as const }))) {
  return {
    db: { user: { create: vi.fn(async (a: any) => ({ ...a.data, tags: a.data.tags })) } } as any,
    auth: {
      signUp: vi.fn(async () => ({
        sub: "7904d681-f590-4b4d-bbce-15348a898873",
        email: "a@b.com",
        emailVerified: "true",
        userPoolId: "pool",
        clientId: "cli_1",
      })),
      login: vi.fn(),
    } as any,
    events: { publishUserCreated: vi.fn() } as any,
    env: { NODE_ENV: nodeEnv, AWS_REGION: "us-east-1" } as any,
    captureCognitoIdentityCommand: { execute: capture } as any,
  };
}

const input = { email: "a@b.com", password: "P4ss!", fullName: "A B", e2eSource: false };

describe("RegisterUserCommand", () => {
  it("captures identity in-process when not production", async () => {
    const d = deps("development");
    await new RegisterUserCommand(d).execute(input);
    expect(d.captureCognitoIdentityCommand.execute).toHaveBeenCalledOnce();
    const evt = (d.captureCognitoIdentityCommand.execute as any).mock.calls[0][0];
    expect(evt.triggerSource).toBe("PostConfirmation_ConfirmSignUp");
    expect(evt.request.userAttributes.sub).toBe("7904d681-f590-4b4d-bbce-15348a898873");
  });

  it("stamps the created user's cognitoSub from signUp.sub (additive, spec Data model)", async () => {
    const d = deps("development");
    await new RegisterUserCommand(d).execute(input);
    const createArgs = (d.db.user.create as any).mock.calls[0][0];
    expect(createArgs.data.cognitoSub).toBe("7904d681-f590-4b4d-bbce-15348a898873");
  });

  it("does NOT capture in production — the Lambda shim does", async () => {
    const d = deps("production");
    await new RegisterUserCommand(d).execute(input);
    expect(d.captureCognitoIdentityCommand.execute).not.toHaveBeenCalled();
  });

  it("still returns the user when capture fails (best-effort, spec D3)", async () => {
    const d = deps("development", vi.fn(async () => { throw new Error("db down"); }));
    const user = await new RegisterUserCommand(d).execute(input);
    expect(user.email).toBe("a@b.com");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd services/users && pnpm vitest run tests/features/users/commands/register.test.ts`
Expected: FAIL — `RegisterUserCommand`'s constructor doesn't accept `env` or `captureCognitoIdentityCommand`.

- [ ] **Step 3: Widen the AuthProvider contract**

In `services/users/src/shared/auth/auth-provider.ts`, replace the `signUp` signature:

```ts
export interface CognitoSignUpResult {
  sub: string;
  email: string;
  emailVerified?: string;
  userPoolId: string;
  clientId: string;
}
```
and change the interface member to:
```ts
  signUp(email: string, password: string): Promise<CognitoSignUpResult>;
```

- [ ] **Step 4: Implement it, removing the silent fallback**

In `services/users/src/shared/auth/cognito-auth-provider.ts`, replace lines 36-37:

```ts
    // A missing `sub` used to fall back to the email. That is a silent
    // corruption: the email would be hashed into the idempotency key as if it
    // were a sub. Fail loudly instead.
    const sub = created.User?.Attributes?.find((a) => a.Name === "sub")?.Value;
    if (!sub) throw new Error(`Cognito AdminCreateUser returned no sub for ${email}`);
    const emailVerified = created.User?.Attributes?.find((a) => a.Name === "email_verified")?.Value;
    return { sub, email, emailVerified, userPoolId: this.userPoolId, clientId: this.clientId };
```

- [ ] **Step 5: Wire the trigger into register()**

In `services/users/src/features/users/commands/register.ts`, extend the class:

```ts
import type { Env } from "#shared/config/env";
import type { CaptureCognitoIdentityCommand } from "../webhooks/capture-cognito-identity.ts";

export class RegisterUserCommand {
  private readonly db: Db;
  private readonly auth: AuthProvider;
  private readonly events: EventPublisher;
  private readonly env: Env;
  private readonly captureCognitoIdentityCommand: CaptureCognitoIdentityCommand;

  constructor({ db, auth, events, env, captureCognitoIdentityCommand }: {
    db: Db; auth: AuthProvider; events: EventPublisher;
    env: Env; captureCognitoIdentityCommand: CaptureCognitoIdentityCommand;
  }) {
    this.db = db;
    this.auth = auth;
    this.events = events;
    this.env = env;
    this.captureCognitoIdentityCommand = captureCognitoIdentityCommand;
  }
```

Change line 31 to keep the result, and after the `runAsActor(...)` create block
and before `publishUserCreated`, add the capture:

```ts
    const signUp = await this.auth.signUp(input.email, input.password);
```

**Additive:** in that same `runAsActor(...)` block, the existing `user.create({ data: {...} })`
call already has `signUp.sub` in scope at this point (Task 7 widened `signUp` to include it) — add
`cognitoSub: signUp.sub` to its `data` object. No new dependency: `signUp` is already awaited
above the create call. See the spec's [Data
model](../specs/2026-07-09-users-cognito-webhook-design.md#data-model) for why this can't diverge
from `UsersCognitoData.cognitoSub` (same `signUp.sub`, same request). The capture call below still
runs after the create, unchanged.

```ts
    // Spec D2 + D7. Cognito never invokes its Lambda triggers on the local
    // emulator (ADR-0017), so outside production we synthesize the same event
    // and drive the same command the prod webhook route delegates to. In
    // production the Lambda shim owns this — calling it here too would be a
    // double capture (harmless: D4's derived message_id dedupes it).
    //
    // Best-effort (spec D3): identity capture is a secondary snapshot, never a
    // precondition for registration. A failure is logged, not propagated.
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
        console.error("cognito identity capture failed (non-fatal)", err);
      }
    }
```

- [ ] **Step 6: Run the tests**

Run: `cd services/users && pnpm vitest run tests/features/users/commands/register.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Full suite, lint, build**

Run: `cd services/users && pnpm test && pnpm lint && pnpm build`
Expected: all exit 0. The existing `routes.test.ts` `register` tests must still pass —
if they break, the DI mock there needs `env` and `captureCognitoIdentityCommand`.

---

### Task 8: E2E-only identity verification endpoint

**Files:**
- Create: `services/users/src/features/users/http/e2e-identity.ts`
- Modify: `services/users/src/features/users/http/routes.ts`
- Modify: `services/users/src/shared/di/awilix-container.ts`
- Test: `services/users/tests/features/users/http/routes.test.ts` (extend)

**Interfaces:**
- Consumes: the Prisma models from Task 2; `env.E2E_TESTING_ENABLED`.
- Produces: `class E2eIdentityQuery` with
  `execute(email: string): Promise<{ data: number; events: number; cognitoSub: string | null }>`,
  registered in the Awilix cradle as `e2eIdentityQuery`;
  route `GET /v1/users/e2e-identity?email=<email>`, registered ONLY when
  `E2E_TESTING_ENABLED`.

Why this exists: the E2E spec must prove identity capture actually happened, and
a Playwright spec should not shell out to `psql`. This mirrors the existing
`DELETE /v1/users/e2e-cleanup` pattern — a read-only counterpart, gated by the
same flag, so it cannot exist in production where `E2E_TESTING_ENABLED` is false.

**Why `cognitoSub` is exposed here (review fix):** Task 9's D4 idempotency test needs the
user's Cognito `sub` to replay the exact webhook event that produced it — nothing else
E2E-reachable carries it. Handing back the sub is acceptable ONLY because this endpoint
never exists in production: it is registered exclusively inside the
`if (env.E2E_TESTING_ENABLED)` block, which is false in prod, so the sub is never exposed
outside the local/E2E stack.

- [ ] **Step 1: Write the failing test**

Extend `services/users/tests/features/users/http/routes.test.ts` with a
`describe("GET /v1/users/e2e-identity")` block asserting:
  - it returns 404 when `E2E_TESTING_ENABLED` is false (route not registered)
  - it returns `{ data: 1, events: 1, cognitoSub: expect.any(String) }` when the query resolves a snapshot, with `E2E_TESTING_ENABLED` true
  - it returns 400 when the `email` query param is missing

Use the file's existing `createContainer` / `asValue` / `buildApp(container)` /
`app.inject()` pattern. Register `e2eIdentityQuery: asValue({ execute: vi.fn(async () => ({ data: 1, events: 1, cognitoSub: "7904d681-f590-4b4d-bbce-15348a898873" })) } as any)`.

- [ ] **Step 2: Run it, expect FAIL (route 404s / module not found)**

Run: `cd services/users && pnpm vitest run tests/features/users/http/routes.test.ts`

- [ ] **Step 3: Implement `services/users/src/features/users/http/e2e-identity.ts`**

```ts
import type { Db } from "#shared/db/prisma";

// Read-only counterpart to E2eCleanupCommand. Exists solely so the E2E suite can
// assert that Cognito identity capture actually wrote its rows, instead of
// shelling out to psql from a Playwright spec. Registered only when
// E2E_TESTING_ENABLED — it must never exist in production.
//
// Constructor-injected from the Awilix cradle (PROXY injection mode).
export class E2eIdentityQuery {
  private readonly db: Db;

  constructor({ db }: { db: Db }) {
    this.db = db;
  }

  async execute(email: string): Promise<{ data: number; events: number; cognitoSub: string | null }> {
    const snapshot = await this.db.usersCognitoData.findFirst({ where: { email } });
    if (!snapshot) return { data: 0, events: 0, cognitoSub: null };
    const events = await this.db.usersCognitoEvent.count({
      where: { cognitoSub: snapshot.cognitoSub },
    });
    return { data: 1, events, cognitoSub: snapshot.cognitoSub };
  }
}
```

Note for the implementer: `findFirst` and `count` are intercepted by the Prisma
extension, which injects `deletedAt: null` — soft-deleted rows are excluded
automatically. Do not add that filter by hand.

**Optional, not mandatory:** `cognitoSub` above is read from the snapshot (`UsersCognitoData`),
which still works and is what's implemented here. Now that `User.cognitoSub` also exists (see the
spec's [Data model](../specs/2026-07-09-users-cognito-webhook-design.md#data-model)), this query
could instead read it directly off `User`. Leave the snapshot-based source as written unless the
implementer finds the `User`-based read clearly cleaner — this is not a required change.

- [ ] **Step 4: Register in DI (`services/users/src/shared/di/awilix-container.ts`)**

Add the import, add `e2eIdentityQuery: E2eIdentityQuery;` to the `Cradle`
interface, and add
`e2eIdentityQuery: asClass(E2eIdentityQuery, { lifetime: Lifetime.SCOPED }),`
inside `registerServices()`.

- [ ] **Step 5: Add the route in `routes.ts`, inside the EXISTING
`if (container.cradle.env.E2E_TESTING_ENABLED) { ... }` block, alongside
`e2e-cleanup`**

```ts
    // Read-only: lets the E2E suite assert that identity capture wrote its rows.
    app.get("/v1/users/e2e-identity", async (req, reply) => {
      const { e2eIdentityQuery } = req.diScope.cradle;
      const email = (req.query as { email?: string }).email;
      if (!email) return reply.code(400).send({ error: "email_required" });
      return reply.send(await e2eIdentityQuery.execute(email));
    });
```

**Note on the response shape:** the JSON body is `{ data, events, cognitoSub }`. `cognitoSub`
is included so the E2E suite can replay the exact webhook event for the D4 idempotency test
(Task 9) — see this task's "Why `cognitoSub` is exposed here" note above.

- [ ] **Step 6: Run the tests, expect PASS**

Run: `cd services/users && pnpm vitest run tests/features/users/http/routes.test.ts`

- [ ] **Step 7: Typecheck and lint**

Run: `cd services/users && pnpm build && pnpm lint` — both exit 0.

---

### Task 9: End-to-end verification against Floci

**Files:**
- Modify: `e2e/tests/users.spec.ts`

**Interfaces:**
- Consumes: everything above, including `E2eIdentityQuery`'s response shape
  `{ data: number; events: number; cognitoSub: string | null }` (Task 8).
- Produces: nothing.

**Why not through the API Gateway:** Floci's API Gateway v2 HTTP_PROXY integration
drops the request path — the invoke URL returns 502 (`docs/lessons/floci-rds-apigw-limits.md`).
E2E drives the service directly on `USERS_BASE_URL`, as JE-37 established.

- [ ] **Step 1: Bring up a clean stack**

Run from the repo root:
```bash
docker compose down && rm -rf data/floci && mkdir -p data/floci
find infra/environments/local -maxdepth 1 -name 'terraform.tfstate*' -delete
rm -f infra/environments/local/.app-db-secret .env
make bootstrap
```
Expected: exits 0, `bootstrap.sh` reports `nginx-stable` proxying to users `/v1/health`.

- [ ] **Step 2: Write the failing E2E test**

Append to `e2e/tests/users.spec.ts`:

```ts
test("register captures Cognito identity into both tables", async () => {
  const api = await apiClient();
  const user = makeUser();
  const res = await api.post("/v1/users/register", { data: user });
  expect(res.status()).toBe(201);

  // The identity snapshot is written in-process by register() (spec D2), so it
  // is visible immediately — no polling. The e2e-identity endpoint exists only
  // when E2E_TESTING_ENABLED (see Task 8), mirroring e2e-cleanup.
  const identity = await api.get(`/v1/users/e2e-identity?email=${encodeURIComponent(user.email)}`);
  expect(identity.status()).toBe(200);
  expect(await identity.json()).toMatchObject({ data: 1, events: 1 });
});
```

Also add a second test immediately after it. **Review fix:** an earlier draft of this test
read the event count twice with no mutation between the reads — it would pass even if D4's
idempotency guard were deleted, giving D4 zero automated regression coverage. This version
performs a REAL replay through the webhook route, using the `cognitoSub` Task 8 now exposes:

```ts
test("replaying the same Cognito event does not add a second event row (D4)", async () => {
  const api = await apiClient();
  const user = makeUser();
  await api.post("/v1/users/register", { data: user });

  // The sub is the idempotency input; fetch it via the E2E-only endpoint.
  const identity = await (await api.get(`/v1/users/e2e-identity?email=${encodeURIComponent(user.email)}`)).json();
  expect(identity).toMatchObject({ data: 1, events: 1 });
  const sub: string = identity.cognitoSub;

  // Replay the exact PostConfirmation event through the real webhook route.
  // Same sub + triggerSource → same derived message_id → ON CONFLICT DO NOTHING.
  const replay = await api.post("/v1/webhooks/cognito", {
    headers: { "x-webhook-secret": process.env.WEBHOOK_SECRET ?? "local-dev-secret" },
    data: {
      version: "1",
      triggerSource: "PostConfirmation_ConfirmSignUp",
      region: "us-east-1",
      userPoolId: "local",
      userName: user.email,
      callerContext: { awsSdkVersion: "local", clientId: "local" },
      request: { userAttributes: { sub, email: user.email, email_verified: "true" } },
    },
  });
  expect(replay.status()).toBe(200);
  expect(await replay.json()).toEqual({ status: "duplicate" });

  // The event count must still be 1 — the replay was swallowed (spec D4).
  const after = await (await api.get(`/v1/users/e2e-identity?email=${encodeURIComponent(user.email)}`)).json();
  expect(after.events).toBe(1);
});
```

`WEBHOOK_SECRET` must be available to the e2e runner — the compose value is
`local-dev-secret` (Task 1, Step 5); the test falls back to it if the env var isn't set. This
test now WOULD fail if the `isMessageIdConflict` guard or the `ON CONFLICT` behavior broke
(the replay would either 500 or grow the count) — it is a real regression check for D4, not
just the manual curl in Step 4 below.

- [ ] **Step 3: Run it**

Run: `cd e2e && nvm use && pnpm test`
Expected: PASS, 8 tests (the 6 from JE-37 plus these two).

- [ ] **Step 4: Prove the rows exist and that a replay is idempotent**

The E2E assertion above proves registration still works; this step proves the
capture itself. Run from the repo root:

```bash
docker run --rm --network 3mrai_3mrai-network postgres:14.6-alpine sh -c \
  "PGPASSWORD=test psql -h floci -p 7001 -U test -d users -tAc \
   \"select (select count(*) from users_cognito_data), (select count(*) from users_cognito_events)\""
```
Expected: both counts ≥ 1.

Now replay the exact same event through the HTTP route and confirm the event
table does not grow — this is the idempotency guarantee of D4, end to end:

```bash
SUB=$(docker run --rm --network 3mrai_3mrai-network postgres:14.6-alpine sh -c \
  "PGPASSWORD=test psql -h floci -p 7001 -U test -d users -tAc 'select cognito_sub from users_cognito_data limit 1'" | tr -d ' \r\n')
BEFORE=$(docker run --rm --network 3mrai_3mrai-network postgres:14.6-alpine sh -c \
  "PGPASSWORD=test psql -h floci -p 7001 -U test -d users -tAc 'select count(*) from users_cognito_events'" | tr -d ' \r\n')

curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/v1/webhooks/cognito \
  -H 'content-type: application/json' -H 'x-webhook-secret: local-dev-secret' \
  -d "{\"version\":\"1\",\"triggerSource\":\"PostConfirmation_ConfirmSignUp\",\"region\":\"us-east-1\",\"userPoolId\":\"p\",\"userName\":\"x\",\"callerContext\":{\"awsSdkVersion\":\"v3\",\"clientId\":\"c\"},\"request\":{\"userAttributes\":{\"sub\":\"$SUB\",\"email\":\"x@y.com\"}}}"

AFTER=$(docker run --rm --network 3mrai_3mrai-network postgres:14.6-alpine sh -c \
  "PGPASSWORD=test psql -h floci -p 7001 -U test -d users -tAc 'select count(*) from users_cognito_events'" | tr -d ' \r\n')
echo "before=$BEFORE after=$AFTER"
```
Expected: the curl prints `200`, and `before == after` — the replay was swallowed.

- [ ] **Step 5: Confirm the secret actually guards the endpoint**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/v1/webhooks/cognito \
  -H 'content-type: application/json' -d '{}'
```
Expected: `401`.

---

## Follow-ups (not this plan)

- **New `area/infra` issue (spec D6):** the prod Cognito PostConfirmation Lambda shim and its Terraform, plus sourcing `WEBHOOK_SECRET` from Secrets Manager (ADR-0007). Not verifiable on Floci, which never invokes Cognito triggers.
- **`docs/plans/users-service-milestone.md` does not list JE-38** — it currently tracks JE-25 through JE-37 only. Add it.

## Related

- [[2026-07-09-users-cognito-webhook-design]]
- [[users-service-milestone]]
- [[ADR-0017-floci-local]]
- [[soft-delete]]
- [[audit-fields]]
- [[nano-id]]
- [[db-naming]]
- [[floci-rds-apigw-limits]]
