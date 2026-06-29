---
title: Users Service Implementation Plan
type: plan
area: users
status: active
created: 2026-06-28
updated: 2026-06-28
tags:
  - type/plan
  - area/users
  - status/active
  - milestone/users-service
  - issue/JE-25
  - issue/JE-26
  - issue/JE-27
  - issue/JE-28
  - issue/JE-29
  - issue/JE-30
  - issue/JE-31
  - issue/JE-32
  - issue/JE-33
  - issue/JE-34
  - issue/JE-35
  - issue/JE-36
  - issue/JE-37
related:
  - "[[2026-06-28-users-service-design]]"
  - "[[users-service-design]]"
  - "[[users-service-milestone]]"
---

# Users Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the Users service from empty scaffold to a working end-to-end slice on Ministack — provisioned AWS resources (Aurora Postgres, Cognito, networking, ECS task running Nginx reverse proxy, API Gateway), pnpm tooling, a Prisma schema with a new `tags` column, a Fastify API, and two layers of tests (Vitest unit + Playwright E2E).

**Architecture (local — proven by JE-25 spike):** API Gateway v2 (Cognito JWT authorizer) → ECS task running Nginx reverse proxy → `users` docker-compose `develop:watch` container → Aurora Postgres (writer/reader). The ECS task runs Nginx only; the service code runs in the hot-reload compose container, reached by Docker DNS (`proxy_pass http://users:3000`, resolver `127.0.0.11`). **No ALB in local** — Ministack's ALB emulator is unsupported for ip/instance targets; ALB is deferred to production. Auth lives at the edge (the gateway); the service trusts gateway-passed claims. The `USER_CREATED` SQS event is a no-op emission point this milestone. E2E-created users are marked with a `tags` value of `E2E Source`, gated by a `X-E2E-Source` header + `E2E_TESTING_ENABLED` flag.

**Tech Stack:** Terraform (cloudposse/label/null) on Ministack, Node 24.18.0, pnpm workspace, Fastify, Prisma (Aurora Postgres), Zod, Vitest, Playwright, chancejs.

## Global Constraints

- **Node:** 24.18.0 (repo `.nvmrc`); run `nvm use` before any node/pnpm command.
- **Package manager:** pnpm only (corepack-pinned via root `package.json` `packageManager`). No `npm`/`npx` for new work.
- **Language:** converse with the user in Spanish; all code, comments, and vault content in English.
- **Git:** never commit/push/merge/PR on your own initiative — implementers leave work in the working tree for `github-ops`; the user confirms every commit. The `git commit` steps below are written for the worker flow but MUST be proposed to the user, not auto-run.
- **Naming:** all Terraform resources via `cloudposse/label/null` → `module.label.id` (e.g. `3mrai-local-users`). See ADR-0001.
- **DB:** columns `snake_case`; app attributes `PascalCase` via Prisma `@map`. Primary keys are prefixed nano IDs (`usr_…`). Audit fields on every table. **No `DELETE`** — soft-delete only (DB user lacks `DELETE` privilege; queries filter `deleted_at IS NULL`).
- **API:** all routes under `/v1`. gRPC contracts versioned too.
- **Replicas:** writer endpoint for INSERT/UPDATE; reader endpoint for SELECT (ADR-0006).
- **Secrets:** DB credentials from Secret Manager, injected at container start — never plaintext task-def env (ADR-0007). Local may use test values.
- **Scope discipline:** SQS not provisioned; `production` env not instantiated (de-prioritized); **no ALB in local** (ALB emulation unsupported on Ministack — deferred to production); only `e2e/` + `services/users` join the pnpm workspace. YAGNI.

**Spec:** `docs/superpowers/specs/2026-06-28-users-service-design.md`

---

## File Structure

**Infra (Terraform, `infra/`)**
- `infra/modules/label/{main,variables,outputs}.tf` — cloudposse/label context
- `infra/modules/networking/{main,variables,outputs}.tf` — VPC, subnets, SGs
- `infra/modules/rds-aurora/{main,variables,outputs}.tf` — Aurora Postgres writer+reader
- `infra/modules/cognito/{main,variables,outputs}.tf` — User Pool + App Client
- `infra/modules/compute/{main,variables,outputs}.tf` — ECS Fargate cluster + service + task def
- `infra/modules/api-gateway/{main,variables,outputs}.tf` — API GW + Cognito authorizer + ALB integration
- `infra/environments/local/{main,variables,outputs,providers,terraform}.tf` — Ministack-targeted composition
- `infra/environments/local/spike/` — throwaway spike stack (deleted after Task 1)

**Root tooling**
- `package.json` (root) — `packageManager`, workspace scripts
- `pnpm-workspace.yaml` — members `e2e`, `services/users`
- `.npmrc` (root) — pnpm settings if needed

**Users service (`services/users/`)**
- `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `vitest.config.ts`, `Dockerfile`, `CLAUDE.md` (modify)
- `prisma/schema.prisma`, `prisma/migrations/**`
- `src/server.ts` — Fastify bootstrap + route registration
- `src/shared/config/env.ts` — Zod env schema (incl. `E2E_TESTING_ENABLED`)
- `src/shared/db/prisma.ts` — writer/reader PrismaClients
- `src/shared/di/container.ts` — DI container
- `src/shared/audit/audit.ts` — audit-field stamping + `isDeleted`
- `src/shared/messaging/event-publisher.ts` — no-op `EventPublisher`
- `src/shared/id/nano-id.ts` — `usr_` prefixed nano ID
- `src/features/users/domain/user.ts` — `User` entity + db mapping
- `src/features/users/commands/{register,login,update-profile}.ts`
- `src/features/users/queries/{get-me,get-user-by-id}.ts`
- `src/features/users/http/routes.ts` — `/v1/users/*` + `/v1/health` + `/v1/users/e2e-cleanup`
- `src/features/users/grpc/get-user-by-id.ts`
- `tests/**` — Vitest unit tests mirroring `src/`

**E2E (`e2e/`)**
- `e2e/package.json`, `e2e/playwright.config.ts`
- `e2e/support/{global-setup,global-teardown,chance-factory,api-client}.ts`
- `e2e/tests/users.spec.ts`

---

## Task 1: Ministack spike — validate API GW + Cognito authorizer + Nginx ECS reverse proxy

**COMPLETED — GATE PASS (JE-25).** The spike validated the full local auth chain.
Outcome: ALB is unusable on Ministack (ip/instance target_type unsupported); ALB replaced
by an ECS task running Nginx as a compose-network-aware reverse proxy. Docker embedded DNS
(`127.0.0.11`) resolves compose service names natively. The JWT authorizer config
(issuer AWS-format, audience = client id, `ADMIN_USER_PASSWORD_AUTH`) is proven and feeds
Tasks 12–13. The spike stack has been destroyed. Proceed directly to Task 2.

**Files:**
- Create: `infra/environments/local/spike/main.tf`
- Create: `infra/environments/local/spike/providers.tf`
- Create: `infra/environments/local/spike/README.md`
- Create: `infra/environments/local/spike/smoke-test.sh`

**Interfaces:**
- Produces: a verified answer to "does Ministack pass a Cognito JWT through an API Gateway authorizer to an ALB→Fargate target?" Later infra tasks (4–7) depend on the topology this confirms.

- [ ] **Step 1: Write the provider config targeting Ministack**

`infra/environments/local/spike/providers.tf`:
```hcl
provider "aws" {
  region                      = "us-east-1"
  access_key                  = "test"
  secret_key                  = "test"
  s3_use_path_style           = true
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requested_account_id   = true

  endpoints {
    apigateway     = "http://localhost:4566"
    apigatewayv2   = "http://localhost:4566"
    cognitoidp     = "http://localhost:4566"
    ec2            = "http://localhost:4566"
    ecs            = "http://localhost:4566"
    elbv2          = "http://localhost:4566"
    iam            = "http://localhost:4566"
    sts            = "http://localhost:4566"
  }
}
```

- [ ] **Step 2: Write a minimal spike stack**

`infra/environments/local/spike/main.tf` provisions the smallest possible chain: a Cognito user pool + app client, an HTTP API Gateway with a JWT authorizer pointed at the pool, and an integration forwarding to an ALB whose target is a single trivial Fargate task (use a public `hashicorp/http-echo`-style image or the simplest container that returns 200). Keep it self-contained — this stack is deleted after the spike.

```hcl
# Cognito
resource "aws_cognito_user_pool" "spike" {
  name = "3mrai-local-spike"
}

resource "aws_cognito_user_pool_client" "spike" {
  name                                 = "3mrai-local-spike-client"
  user_pool_id                         = aws_cognito_user_pool.spike.id
  explicit_auth_flows                  = ["ADMIN_NO_SRP_AUTH", "USER_PASSWORD_AUTH"]
  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = false
}

# HTTP API + JWT authorizer (Cognito)
resource "aws_apigatewayv2_api" "spike" {
  name          = "3mrai-local-spike-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_authorizer" "spike" {
  api_id           = aws_apigatewayv2_api.spike.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "3mrai-local-spike-jwt"

  jwt_configuration {
    audience = [aws_cognito_user_pool_client.spike.id]
    issuer   = "http://localhost:4566/${aws_cognito_user_pool.spike.id}"
  }
}
```
(Add the ALB + target group + a minimal ECS Fargate service + the `aws_apigatewayv2_integration`/`route` wiring the protected route to the ALB. Keep image and CPU/memory minimal.)

- [ ] **Step 3: Init and apply the spike against a running Ministack**

Run:
```bash
docker compose up -d ministack
cd infra/environments/local/spike && terraform init && terraform apply -auto-approve
```
Expected: apply completes; outputs include the API Gateway invoke URL and the Cognito pool/client IDs.

- [ ] **Step 4: Write and run the smoke test**

`infra/environments/local/spike/smoke-test.sh` should: create a Cognito user (admin), set a permanent password, authenticate via `USER_PASSWORD_AUTH` to get an `IdToken`, then `curl` the protected API Gateway route once **without** the token (expect 401) and once **with** `Authorization: Bearer <IdToken>` (expect 200 from the echo container).

Run: `bash infra/environments/local/spike/smoke-test.sh`
Expected: unauthenticated call → `401`; authenticated call → `200`.

- [ ] **Step 5: Decision gate**

- **If both assertions pass:** record the working authorizer/issuer/audience config in the spike `README.md` (these exact values feed Task 7), `terraform destroy` the spike, and proceed.
- **If anything fails:** STOP. Write what failed in `README.md` and escalate to the user. Do not continue to Task 4+.

- [ ] **Step 6: Commit (propose to user)**

```bash
git add infra/environments/local/spike
git commit -m "chore(infra): add Ministack auth-chain spike (API GW + Cognito authorizer + ALB→Fargate)"
```

---

## Task 2: pnpm workspace (root)

**Files:**
- Create: `package.json` (root)
- Create: `pnpm-workspace.yaml`
- Modify: `.gitignore` (ensure `node_modules`, pnpm store ignored)

**Interfaces:**
- Produces: a pnpm workspace with members `e2e` and `services/users`; corepack-pinned pnpm. Tasks 3 and 9 add packages into this workspace.

- [ ] **Step 1: Create the workspace manifest**

`pnpm-workspace.yaml`:
```yaml
packages:
  - "services/users"
  - "e2e"
```

- [ ] **Step 2: Create the root package.json**

`package.json`:
```json
{
  "name": "3mrai",
  "private": true,
  "packageManager": "pnpm@9.15.0",
  "engines": { "node": "24.18.0" },
  "scripts": {
    "users:dev": "pnpm --filter @3mrai/users dev",
    "users:test": "pnpm --filter @3mrai/users test",
    "e2e": "pnpm --filter @3mrai/e2e test"
  }
}
```

- [ ] **Step 3: Ensure ignores**

Confirm `.gitignore` contains `node_modules` and add `.pnpm-store/` if not present.

- [ ] **Step 4: Enable corepack and verify**

Run:
```bash
nvm use && corepack enable && pnpm -v
```
Expected: prints `9.15.0` (the pinned version).

- [ ] **Step 5: Commit (propose to user)**

```bash
git add package.json pnpm-workspace.yaml .gitignore
git commit -m "build: add pnpm workspace root (members: users, e2e)"
```

---

## Task 3: Users service pnpm package + TypeScript + Vitest config

**Files:**
- Create: `services/users/package.json`
- Create: `services/users/tsconfig.json`
- Create: `services/users/vitest.config.ts`
- Create: `services/users/.npmrc` (if pnpm hoisting needed for Prisma)
- Test: `services/users/tests/smoke.test.ts`

**Interfaces:**
- Produces: package `@3mrai/users` with scripts `dev`, `build`, `test`, `test:watch`, `lint`, `prisma`. Tasks 4–11 add files under `services/users/src` and `services/users/tests`.

- [ ] **Step 1: Create package.json**

`services/users/package.json`:
```json
{
  "name": "@3mrai/users",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node --watch --experimental-strip-types src/server.ts",
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint .",
    "prisma": "prisma"
  },
  "dependencies": {
    "fastify": "^5.0.0",
    "@prisma/client": "^6.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "prisma": "^6.0.0",
    "vitest": "^2.0.0",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

`services/users/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

`services/users/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 4: Write a smoke test**

`services/users/tests/smoke.test.ts`:
```ts
import { describe, it, expect } from "vitest";

describe("smoke", () => {
  it("runs vitest", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Install and run**

Run:
```bash
nvm use && pnpm install && pnpm --filter @3mrai/users test
```
Expected: 1 passing test.

- [ ] **Step 6: Commit (propose to user)**

```bash
git add services/users/package.json services/users/tsconfig.json services/users/vitest.config.ts services/users/tests/smoke.test.ts pnpm-lock.yaml
git commit -m "build(users): add pnpm package, TypeScript and Vitest config"
```

---

## Task 4: Prisma schema (users + tags) and writer/reader clients

**Files:**
- Create: `services/users/prisma/schema.prisma`
- Create: `services/users/src/shared/config/env.ts`
- Create: `services/users/src/shared/db/prisma.ts`
- Test: `services/users/tests/shared/env.test.ts`

**Interfaces:**
- Consumes: `@3mrai/users` package from Task 3.
- Produces:
  - `env`: parsed object with `DATABASE_WRITER_URL: string`, `DATABASE_READER_URL: string`, `E2E_TESTING_ENABLED: boolean`, `PORT: number`, plus Cognito fields `COGNITO_USER_POOL_ID: string`, `COGNITO_CLIENT_ID: string`, `AWS_ENDPOINT_URL: string`, `AWS_REGION: string`.
  - `writer: PrismaClient`, `reader: PrismaClient` from `src/shared/db/prisma.ts`.

- [ ] **Step 1: Write the failing env test**

`services/users/tests/shared/env.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseEnv } from "../../src/shared/config/env.js";

describe("parseEnv", () => {
  it("coerces E2E_TESTING_ENABLED and PORT", () => {
    const env = parseEnv({
      DATABASE_WRITER_URL: "postgres://w",
      DATABASE_READER_URL: "postgres://r",
      E2E_TESTING_ENABLED: "true",
      PORT: "3000",
      COGNITO_USER_POOL_ID: "pool",
      COGNITO_CLIENT_ID: "client",
      AWS_ENDPOINT_URL: "http://ministack:4566",
      AWS_REGION: "us-east-1",
    });
    expect(env.E2E_TESTING_ENABLED).toBe(true);
    expect(env.PORT).toBe(3000);
  });

  it("defaults E2E_TESTING_ENABLED to false when absent", () => {
    const env = parseEnv({
      DATABASE_WRITER_URL: "postgres://w",
      DATABASE_READER_URL: "postgres://r",
      PORT: "3000",
      COGNITO_USER_POOL_ID: "pool",
      COGNITO_CLIENT_ID: "client",
      AWS_ENDPOINT_URL: "http://ministack:4566",
      AWS_REGION: "us-east-1",
    });
    expect(env.E2E_TESTING_ENABLED).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @3mrai/users test env`
Expected: FAIL — `parseEnv` not found.

- [ ] **Step 3: Implement the Zod env schema**

`services/users/src/shared/config/env.ts`:
```ts
import { z } from "zod";

const schema = z.object({
  DATABASE_WRITER_URL: z.string().url(),
  DATABASE_READER_URL: z.string().url(),
  E2E_TESTING_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  PORT: z.coerce.number().default(3000),
  COGNITO_USER_POOL_ID: z.string(),
  COGNITO_CLIENT_ID: z.string(),
  AWS_ENDPOINT_URL: z.string().url(),
  AWS_REGION: z.string(),
});

export type Env = z.infer<typeof schema>;

export function parseEnv(source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Env {
  return schema.parse(source);
}

export const env = parseEnv();
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @3mrai/users test env`
Expected: PASS (both cases).

- [ ] **Step 5: Write the Prisma schema with the `tags` column**

`services/users/prisma/schema.prisma`:
```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_WRITER_URL")
}

model User {
  id          String    @id
  email       String    @unique
  fullName    String    @map("full_name")
  address     Json?
  phoneNumber String?   @map("phone_number")
  tags        String[]  @default([])
  createdBy   String?   @map("created_by")
  createdAt   DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedBy   String?   @map("updated_by")
  updatedAt   DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)
  deletedBy   String?   @map("deleted_by")
  deletedAt   DateTime? @map("deleted_at") @db.Timestamptz(6)

  @@map("users")
  @@index([deletedAt])
}
```

- [ ] **Step 6: Implement writer/reader clients**

`services/users/src/shared/db/prisma.ts`:
```ts
import { PrismaClient } from "@prisma/client";
import { env } from "../config/env.js";

export const writer = new PrismaClient({
  datasources: { db: { url: env.DATABASE_WRITER_URL } },
});

export const reader = new PrismaClient({
  datasources: { db: { url: env.DATABASE_READER_URL } },
});
```

- [ ] **Step 7: Generate the Prisma client**

Run: `cd services/users && pnpm prisma generate`
Expected: client generated; build/test still green (`pnpm --filter @3mrai/users test`).

- [ ] **Step 8: Commit (propose to user)**

```bash
git add services/users/prisma/schema.prisma services/users/src/shared/config/env.ts services/users/src/shared/db/prisma.ts services/users/tests/shared/env.test.ts
git commit -m "feat(users): add Prisma schema with tags column + Zod env + writer/reader clients"
```

---

## Task 5: Shared primitives — nano ID, audit stamping, no-op EventPublisher

**Files:**
- Create: `services/users/src/shared/id/nano-id.ts`
- Create: `services/users/src/shared/audit/audit.ts`
- Create: `services/users/src/shared/messaging/event-publisher.ts`
- Test: `services/users/tests/shared/nano-id.test.ts`
- Test: `services/users/tests/shared/audit.test.ts`
- Test: `services/users/tests/shared/event-publisher.test.ts`

**Interfaces:**
- Produces:
  - `newUserId(): string` → returns `usr_<nanoid>`.
  - `stampCreate(actor: string): { createdBy: string; updatedBy: string }` and `stampSoftDelete(actor: string): { deletedBy: string; deletedAt: Date }`; `isDeleted(row: { deletedAt: Date | null }): boolean`.
  - `EventPublisher` interface with `publishUserCreated(payload: { id: string; email: string }): Promise<void>`, and `NoopEventPublisher` implementing it (does nothing).

- [ ] **Step 1: Write failing nano-id test**

`services/users/tests/shared/nano-id.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { newUserId } from "../../src/shared/id/nano-id.js";

describe("newUserId", () => {
  it("returns a usr_-prefixed id", () => {
    const id = newUserId();
    expect(id.startsWith("usr_")).toBe(true);
    expect(id.length).toBeGreaterThan(10);
  });
  it("returns unique ids", () => {
    expect(newUserId()).not.toBe(newUserId());
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @3mrai/users test nano-id`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement nano-id**

Add `nanoid` to deps (`pnpm --filter @3mrai/users add nanoid`). `services/users/src/shared/id/nano-id.ts`:
```ts
import { nanoid } from "nanoid";

export function newUserId(): string {
  return `usr_${nanoid()}`;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @3mrai/users test nano-id`
Expected: PASS.

- [ ] **Step 5: Write failing audit test**

`services/users/tests/shared/audit.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { stampCreate, stampSoftDelete, isDeleted } from "../../src/shared/audit/audit.js";

describe("audit", () => {
  it("stamps creator on create", () => {
    expect(stampCreate("usr_a")).toEqual({ createdBy: "usr_a", updatedBy: "usr_a" });
  });
  it("stamps deleter + timestamp on soft delete", () => {
    const s = stampSoftDelete("usr_a");
    expect(s.deletedBy).toBe("usr_a");
    expect(s.deletedAt).toBeInstanceOf(Date);
  });
  it("derives isDeleted from deletedAt", () => {
    expect(isDeleted({ deletedAt: null })).toBe(false);
    expect(isDeleted({ deletedAt: new Date() })).toBe(true);
  });
});
```

- [ ] **Step 6: Run to verify failure, then implement**

Run: `pnpm --filter @3mrai/users test audit` → FAIL.
`services/users/src/shared/audit/audit.ts`:
```ts
export function stampCreate(actor: string): { createdBy: string; updatedBy: string } {
  return { createdBy: actor, updatedBy: actor };
}

export function stampSoftDelete(actor: string): { deletedBy: string; deletedAt: Date } {
  return { deletedBy: actor, deletedAt: new Date() };
}

export function isDeleted(row: { deletedAt: Date | null }): boolean {
  return row.deletedAt !== null;
}
```
Run again → PASS.

- [ ] **Step 7: Write failing EventPublisher test, then implement**

`services/users/tests/shared/event-publisher.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { NoopEventPublisher } from "../../src/shared/messaging/event-publisher.js";

describe("NoopEventPublisher", () => {
  it("resolves without throwing", async () => {
    const pub = new NoopEventPublisher();
    await expect(pub.publishUserCreated({ id: "usr_a", email: "a@b.c" })).resolves.toBeUndefined();
  });
});
```
Run → FAIL. `services/users/src/shared/messaging/event-publisher.ts`:
```ts
export interface EventPublisher {
  publishUserCreated(payload: { id: string; email: string }): Promise<void>;
}

// No-op for this milestone: the emission point exists; SQS wiring is deferred.
export class NoopEventPublisher implements EventPublisher {
  async publishUserCreated(_payload: { id: string; email: string }): Promise<void> {
    return;
  }
}
```
Run → PASS.

- [ ] **Step 8: Commit (propose to user)**

```bash
git add services/users/src/shared/id services/users/src/shared/audit services/users/src/shared/messaging services/users/tests/shared/nano-id.test.ts services/users/tests/shared/audit.test.ts services/users/tests/shared/event-publisher.test.ts pnpm-lock.yaml
git commit -m "feat(users): add nano-id, audit stamping, and no-op EventPublisher"
```

---

## Task 6: Auth provider (Cognito) behind an interface

**Files:**
- Create: `services/users/src/shared/auth/auth-provider.ts`
- Create: `services/users/src/shared/auth/cognito-auth-provider.ts`
- Test: `services/users/tests/shared/auth-provider.test.ts`

**Interfaces:**
- Consumes: `env` (Task 4).
- Produces: `AuthProvider` interface — `signUp(email: string, password: string): Promise<{ sub: string }>`, `login(email: string, password: string): Promise<{ idToken: string; accessToken: string; refreshToken: string }>`. `CognitoAuthProvider` implements it against the Cognito IDP SDK pointed at `AWS_ENDPOINT_URL`.

- [ ] **Step 1: Write the failing interface/contract test**

`services/users/tests/shared/auth-provider.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { CognitoAuthProvider } from "../../src/shared/auth/cognito-auth-provider.js";

describe("CognitoAuthProvider", () => {
  it("login maps Cognito tokens to the AuthProvider shape", async () => {
    const fakeClient = {
      send: vi.fn().mockResolvedValue({
        AuthenticationResult: { IdToken: "id", AccessToken: "acc", RefreshToken: "ref" },
      }),
    };
    const provider = new CognitoAuthProvider(fakeClient as any, "pool", "client");
    const tokens = await provider.login("a@b.c", "Passw0rd!");
    expect(tokens).toEqual({ idToken: "id", accessToken: "acc", refreshToken: "ref" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @3mrai/users test auth-provider`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the SDK and implement**

Run: `pnpm --filter @3mrai/users add @aws-sdk/client-cognito-identity-provider`

`services/users/src/shared/auth/auth-provider.ts`:
```ts
export interface AuthTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
}

export interface AuthProvider {
  signUp(email: string, password: string): Promise<{ sub: string }>;
  login(email: string, password: string): Promise<AuthTokens>;
}
```

`services/users/src/shared/auth/cognito-auth-provider.ts`:
```ts
import {
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminInitiateAuthCommand,
  type CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import type { AuthProvider, AuthTokens } from "./auth-provider.js";

export class CognitoAuthProvider implements AuthProvider {
  constructor(
    private readonly client: CognitoIdentityProviderClient,
    private readonly userPoolId: string,
    private readonly clientId: string,
  ) {}

  async signUp(email: string, password: string): Promise<{ sub: string }> {
    const created = await this.client.send(
      new AdminCreateUserCommand({
        UserPoolId: this.userPoolId,
        Username: email,
        MessageAction: "SUPPRESS",
        UserAttributes: [{ Name: "email", Value: email }, { Name: "email_verified", Value: "true" }],
      }),
    );
    await this.client.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: this.userPoolId,
        Username: email,
        Password: password,
        Permanent: true,
      }),
    );
    const sub = created.User?.Attributes?.find((a) => a.Name === "sub")?.Value ?? email;
    return { sub };
  }

  async login(email: string, password: string): Promise<AuthTokens> {
    const res = await this.client.send(
      new AdminInitiateAuthCommand({
        UserPoolId: this.userPoolId,
        ClientId: this.clientId,
        AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
        AuthParameters: { USERNAME: email, PASSWORD: password },
      }),
    );
    const r = res.AuthenticationResult;
    return { idToken: r?.IdToken ?? "", accessToken: r?.AccessToken ?? "", refreshToken: r?.RefreshToken ?? "" };
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @3mrai/users test auth-provider`
Expected: PASS.

- [ ] **Step 5: Commit (propose to user)**

```bash
git add services/users/src/shared/auth services/users/tests/shared/auth-provider.test.ts pnpm-lock.yaml
git commit -m "feat(users): add AuthProvider interface + Cognito implementation"
```

---

## Task 7: Domain entity + db mapping

**Files:**
- Create: `services/users/src/features/users/domain/user.ts`
- Test: `services/users/tests/features/users/domain/user.test.ts`

**Interfaces:**
- Consumes: `isDeleted` (Task 5).
- Produces: `User` type (PascalCase domain attrs) and `toDomain(row)` / `fromDomain(user)` mappers. `User` has `id, email, fullName, address, phoneNumber, tags, createdBy, createdAt, updatedBy, updatedAt, deletedBy, deletedAt, isDeleted`.

- [ ] **Step 1: Write the failing mapping test**

`services/users/tests/features/users/domain/user.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { toDomain } from "../../../../../src/features/users/domain/user.js";

describe("toDomain", () => {
  it("maps a db row to a domain user with derived isDeleted", () => {
    const row = {
      id: "usr_1", email: "a@b.c", fullName: "A B", address: null,
      phoneNumber: null, tags: ["E2E Source"], createdBy: "usr_1",
      createdAt: new Date(0), updatedBy: "usr_1", updatedAt: new Date(0),
      deletedBy: null, deletedAt: null,
    };
    const user = toDomain(row);
    expect(user.isDeleted).toBe(false);
    expect(user.tags).toEqual(["E2E Source"]);
  });
});
```

- [ ] **Step 2: Run → FAIL; implement**

`services/users/src/features/users/domain/user.ts`:
```ts
import { isDeleted as deriveIsDeleted } from "../../../shared/audit/audit.js";

export interface UserRow {
  id: string;
  email: string;
  fullName: string;
  address: unknown | null;
  phoneNumber: string | null;
  tags: string[];
  createdBy: string | null;
  createdAt: Date;
  updatedBy: string | null;
  updatedAt: Date;
  deletedBy: string | null;
  deletedAt: Date | null;
}

export interface User extends UserRow {
  isDeleted: boolean;
}

export function toDomain(row: UserRow): User {
  return { ...row, isDeleted: deriveIsDeleted(row) };
}
```

- [ ] **Step 3: Run → PASS. Commit (propose to user)**

```bash
git add services/users/src/features/users/domain services/users/tests/features/users/domain
git commit -m "feat(users): add User domain entity + db mapping"
```

---

## Task 8: Commands & queries (register, login, update-profile, get-me, get-user-by-id)

**Files:**
- Create: `services/users/src/features/users/commands/register.ts`
- Create: `services/users/src/features/users/commands/login.ts`
- Create: `services/users/src/features/users/commands/update-profile.ts`
- Create: `services/users/src/features/users/queries/get-me.ts`
- Create: `services/users/src/features/users/queries/get-user-by-id.ts`
- Test: `services/users/tests/features/users/commands/register.test.ts`
- Test: `services/users/tests/features/users/queries/get-me.test.ts`

**Interfaces:**
- Consumes: `writer`/`reader` (Task 4), `newUserId`/`stampCreate` (Task 5), `AuthProvider` (Task 6), `EventPublisher` (Task 5), `toDomain` (Task 7).
- Produces:
  - `registerUser(deps, input): Promise<User>` where `input = { email, password, fullName, address?, phoneNumber?, e2eSource: boolean }`. When `e2eSource` is true, `tags` includes `"E2E Source"`; otherwise `tags` is `[]`. Always calls `auth.signUp` then `writer.user.create`, then `events.publishUserCreated`.
  - `loginUser(deps, { email, password }): Promise<AuthTokens>`.
  - `getMe(deps, userId): Promise<User | null>` (reader; filters `deletedAt: null`).
  - `getUserById(deps, id): Promise<User | null>` (reader; filters `deletedAt: null`).

- [ ] **Step 1: Write the failing register test (E2E tag behavior)**

`services/users/tests/features/users/commands/register.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { registerUser } from "../../../../../src/features/users/commands/register.js";

function deps(overrides = {}) {
  const created: any = {};
  return {
    writer: { user: { create: vi.fn(async ({ data }: any) => { Object.assign(created, data); return data; }) } },
    auth: { signUp: vi.fn(async () => ({ sub: "sub_1" })), login: vi.fn() },
    events: { publishUserCreated: vi.fn(async () => {}) },
    _created: created,
    ...overrides,
  } as any;
}

describe("registerUser", () => {
  it("adds 'E2E Source' to tags when e2eSource is true", async () => {
    const d = deps();
    const user = await registerUser(d, { email: "a@b.c", password: "P!1", fullName: "A", e2eSource: true });
    expect(user.tags).toContain("E2E Source");
    expect(d.events.publishUserCreated).toHaveBeenCalledOnce();
  });

  it("leaves tags empty when e2eSource is false", async () => {
    const d = deps();
    const user = await registerUser(d, { email: "a@b.c", password: "P!1", fullName: "A", e2eSource: false });
    expect(user.tags).toEqual([]);
  });
});
```

- [ ] **Step 2: Run → FAIL; implement register**

`services/users/src/features/users/commands/register.ts`:
```ts
import type { PrismaClient } from "@prisma/client";
import type { AuthProvider } from "../../../shared/auth/auth-provider.js";
import type { EventPublisher } from "../../../shared/messaging/event-publisher.js";
import { newUserId } from "../../../shared/id/nano-id.js";
import { stampCreate } from "../../../shared/audit/audit.js";
import { toDomain, type User } from "../domain/user.js";

export interface RegisterDeps {
  writer: PrismaClient;
  auth: AuthProvider;
  events: EventPublisher;
}

export interface RegisterInput {
  email: string;
  password: string;
  fullName: string;
  address?: unknown;
  phoneNumber?: string;
  e2eSource: boolean;
}

export async function registerUser(deps: RegisterDeps, input: RegisterInput): Promise<User> {
  await deps.auth.signUp(input.email, input.password);
  const id = newUserId();
  const tags = input.e2eSource ? ["E2E Source"] : [];
  const row = await deps.writer.user.create({
    data: {
      id,
      email: input.email,
      fullName: input.fullName,
      address: (input.address as any) ?? null,
      phoneNumber: input.phoneNumber ?? null,
      tags,
      ...stampCreate(id),
    },
  });
  await deps.events.publishUserCreated({ id, email: input.email });
  return toDomain(row as any);
}
```

- [ ] **Step 3: Run → PASS**

Run: `pnpm --filter @3mrai/users test register`
Expected: PASS (both cases).

- [ ] **Step 4: Write the failing get-me test (soft-delete filter)**

`services/users/tests/features/users/queries/get-me.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { getMe } from "../../../../../src/features/users/queries/get-me.js";

describe("getMe", () => {
  it("queries reader filtering out soft-deleted rows", async () => {
    const findFirst = vi.fn(async () => null);
    const reader = { user: { findFirst } } as any;
    await getMe({ reader }, "usr_1");
    expect(findFirst).toHaveBeenCalledWith({ where: { id: "usr_1", deletedAt: null } });
  });
});
```

- [ ] **Step 5: Run → FAIL; implement queries + remaining commands**

`services/users/src/features/users/queries/get-me.ts`:
```ts
import type { PrismaClient } from "@prisma/client";
import { toDomain, type User } from "../domain/user.js";

export interface ReaderDeps { reader: PrismaClient }

export async function getMe(deps: ReaderDeps, userId: string): Promise<User | null> {
  const row = await deps.reader.user.findFirst({ where: { id: userId, deletedAt: null } });
  return row ? toDomain(row as any) : null;
}
```

`services/users/src/features/users/queries/get-user-by-id.ts`:
```ts
import type { PrismaClient } from "@prisma/client";
import { toDomain, type User } from "../domain/user.js";

export async function getUserById(deps: { reader: PrismaClient }, id: string): Promise<User | null> {
  const row = await deps.reader.user.findFirst({ where: { id, deletedAt: null } });
  return row ? toDomain(row as any) : null;
}
```

`services/users/src/features/users/commands/login.ts`:
```ts
import type { AuthProvider, AuthTokens } from "../../../shared/auth/auth-provider.js";

export async function loginUser(deps: { auth: AuthProvider }, input: { email: string; password: string }): Promise<AuthTokens> {
  return deps.auth.login(input.email, input.password);
}
```

`services/users/src/features/users/commands/update-profile.ts`:
```ts
import type { PrismaClient } from "@prisma/client";
import { toDomain, type User } from "../domain/user.js";

export interface UpdateProfileInput {
  fullName?: string;
  address?: unknown;
  phoneNumber?: string;
}

export async function updateProfile(
  deps: { writer: PrismaClient },
  userId: string,
  input: UpdateProfileInput,
): Promise<User> {
  const row = await deps.writer.user.update({
    where: { id: userId },
    data: {
      ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
      ...(input.address !== undefined ? { address: input.address as any } : {}),
      ...(input.phoneNumber !== undefined ? { phoneNumber: input.phoneNumber } : {}),
      updatedBy: userId,
    },
  });
  return toDomain(row as any);
}
```

- [ ] **Step 6: Run all → PASS**

Run: `pnpm --filter @3mrai/users test`
Expected: all green.

- [ ] **Step 7: Commit (propose to user)**

```bash
git add services/users/src/features/users/commands services/users/src/features/users/queries services/users/tests/features/users/commands services/users/tests/features/users/queries
git commit -m "feat(users): add register/login/update-profile commands + get-me/get-user-by-id queries"
```

---

## Task 9: HTTP layer (Fastify routes), DI container, server bootstrap, cleanup endpoint

**Files:**
- Create: `services/users/src/shared/di/container.ts`
- Create: `services/users/src/features/users/http/routes.ts`
- Create: `services/users/src/features/users/http/e2e-cleanup.ts`
- Create: `services/users/src/server.ts`
- Test: `services/users/tests/features/users/http/routes.test.ts`

**Interfaces:**
- Consumes: all commands/queries (Task 8), `env` (Task 4), `stampSoftDelete` (Task 5).
- Produces: `buildApp(deps): FastifyInstance` registering `/v1/health`, `/v1/users/register`, `/v1/users/login`, `/v1/users/me` (GET/PATCH), `/v1/users/e2e-cleanup` (DELETE). `register` reads `X-E2E-Source` header and passes `e2eSource = (header === "true") && env.E2E_TESTING_ENABLED`. The cleanup route returns 404 when `env.E2E_TESTING_ENABLED` is false.

- [ ] **Step 1: Write the failing routes test (health + E2E gate)**

`services/users/tests/features/users/http/routes.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { buildApp } from "../../../../../src/features/users/http/routes.js";

function fakeDeps(e2eEnabled: boolean) {
  return {
    env: { E2E_TESTING_ENABLED: e2eEnabled },
    registerUser: vi.fn(async (_d: any, input: any) => ({ id: "usr_1", tags: input.e2eSource ? ["E2E Source"] : [] })),
    loginUser: vi.fn(),
    getMe: vi.fn(),
    updateProfile: vi.fn(),
    softDeleteE2EUsers: vi.fn(async () => ({ count: 3 })),
  } as any;
}

describe("routes", () => {
  it("GET /v1/health returns ok", async () => {
    const app = buildApp(fakeDeps(false));
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("register honors X-E2E-Source only when flag enabled", async () => {
    const app = buildApp(fakeDeps(true));
    const res = await app.inject({
      method: "POST", url: "/v1/users/register",
      headers: { "x-e2e-source": "true" },
      payload: { email: "a@b.c", password: "P!1", fullName: "A" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().tags).toContain("E2E Source");
  });

  it("register ignores X-E2E-Source when flag disabled", async () => {
    const app = buildApp(fakeDeps(false));
    const res = await app.inject({
      method: "POST", url: "/v1/users/register",
      headers: { "x-e2e-source": "true" },
      payload: { email: "a@b.c", password: "P!1", fullName: "A" },
    });
    expect(res.json().tags).toEqual([]);
  });

  it("e2e-cleanup returns 404 when flag disabled", async () => {
    const app = buildApp(fakeDeps(false));
    const res = await app.inject({ method: "DELETE", url: "/v1/users/e2e-cleanup" });
    expect(res.statusCode).toBe(404);
  });

  it("e2e-cleanup soft-deletes when flag enabled", async () => {
    const app = buildApp(fakeDeps(true));
    const res = await app.inject({ method: "DELETE", url: "/v1/users/e2e-cleanup" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: 3 });
  });
});
```

- [ ] **Step 2: Run → FAIL; implement the cleanup use-case**

`services/users/src/features/users/http/e2e-cleanup.ts`:
```ts
import type { PrismaClient } from "@prisma/client";
import { stampSoftDelete } from "../../../shared/audit/audit.js";

// Soft-deletes (never hard-deletes) every user tagged "E2E Source".
export async function softDeleteE2EUsers(deps: { writer: PrismaClient }): Promise<{ count: number }> {
  const stamp = stampSoftDelete("e2e-cleanup");
  const res = await deps.writer.user.updateMany({
    where: { tags: { has: "E2E Source" }, deletedAt: null },
    data: { deletedAt: stamp.deletedAt, deletedBy: stamp.deletedBy },
  });
  return { count: res.count };
}
```

- [ ] **Step 3: Implement the routes**

`services/users/src/features/users/http/routes.ts`:
```ts
import Fastify, { type FastifyInstance } from "fastify";

export interface AppDeps {
  env: { E2E_TESTING_ENABLED: boolean };
  registerUser: (deps: unknown, input: unknown) => Promise<{ id: string; tags: string[] }>;
  loginUser: (deps: unknown, input: { email: string; password: string }) => Promise<unknown>;
  getMe: (deps: unknown, userId: string) => Promise<unknown>;
  updateProfile: (deps: unknown, userId: string, input: unknown) => Promise<unknown>;
  softDeleteE2EUsers: (deps: unknown) => Promise<{ count: number }>;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get("/v1/health", async () => ({ status: "ok" }));

  app.post("/v1/users/register", async (req, reply) => {
    const body = req.body as { email: string; password: string; fullName: string; address?: unknown; phoneNumber?: string };
    const headerFlag = req.headers["x-e2e-source"] === "true";
    const e2eSource = headerFlag && deps.env.E2E_TESTING_ENABLED;
    const user = await deps.registerUser(deps, { ...body, e2eSource });
    return reply.code(201).send(user);
  });

  app.post("/v1/users/login", async (req, reply) => {
    const tokens = await deps.loginUser(deps, req.body as { email: string; password: string });
    return reply.send(tokens);
  });

  // Identity comes from the API Gateway authorizer (claims forwarded as headers).
  app.get("/v1/users/me", async (req, reply) => {
    const userId = req.headers["x-user-id"] as string;
    const me = await deps.getMe(deps, userId);
    return me ? reply.send(me) : reply.code(404).send({ error: "not_found" });
  });

  app.patch("/v1/users/me", async (req, reply) => {
    const userId = req.headers["x-user-id"] as string;
    const updated = await deps.updateProfile(deps, userId, req.body);
    return reply.send(updated);
  });

  if (deps.env.E2E_TESTING_ENABLED) {
    app.delete("/v1/users/e2e-cleanup", async (_req, reply) => {
      const { count } = await deps.softDeleteE2EUsers(deps);
      return reply.send({ deleted: count });
    });
  }

  return app;
}
```

- [ ] **Step 4: Run → PASS**

Run: `pnpm --filter @3mrai/users test routes`
Expected: all 5 cases pass.

- [ ] **Step 5: Wire the DI container + server bootstrap**

`services/users/src/shared/di/container.ts`:
```ts
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { env } from "../config/env.js";
import { writer, reader } from "../db/prisma.js";
import { NoopEventPublisher } from "../messaging/event-publisher.js";
import { CognitoAuthProvider } from "../auth/cognito-auth-provider.js";
import { registerUser } from "../../features/users/commands/register.js";
import { loginUser } from "../../features/users/commands/login.js";
import { updateProfile } from "../../features/users/commands/update-profile.js";
import { getMe } from "../../features/users/queries/get-me.js";
import { softDeleteE2EUsers } from "../../features/users/http/e2e-cleanup.js";
import type { AppDeps } from "../../features/users/http/routes.js";

export function buildContainer(): AppDeps {
  const cognito = new CognitoIdentityProviderClient({ region: env.AWS_REGION, endpoint: env.AWS_ENDPOINT_URL });
  const auth = new CognitoAuthProvider(cognito, env.COGNITO_USER_POOL_ID, env.COGNITO_CLIENT_ID);
  const events = new NoopEventPublisher();
  return {
    env,
    registerUser: (_d, input) => registerUser({ writer, auth, events }, input as any),
    loginUser: (_d, input) => loginUser({ auth }, input),
    getMe: (_d, userId) => getMe({ reader }, userId),
    updateProfile: (_d, userId, input) => updateProfile({ writer }, userId, input as any),
    softDeleteE2EUsers: () => softDeleteE2EUsers({ writer }),
  };
}
```

`services/users/src/server.ts`:
```ts
import { env } from "./shared/config/env.js";
import { buildContainer } from "./shared/di/container.js";
import { buildApp } from "./features/users/http/routes.js";

const app = buildApp(buildContainer());
app.listen({ port: env.PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
```

Run: `pnpm --filter @3mrai/users test` and `pnpm --filter @3mrai/users build`
Expected: tests green, build succeeds.

- [ ] **Step 6: Commit (propose to user)**

```bash
git add services/users/src/shared/di services/users/src/features/users/http services/users/src/server.ts services/users/tests/features/users/http
git commit -m "feat(users): add Fastify routes, DI container, server bootstrap, flag-gated e2e-cleanup"
```

---

## Task 10: gRPC GetUserById

**Files:**
- Create: `services/users/src/features/users/grpc/get-user-by-id.ts`
- Test: `services/users/tests/features/users/grpc/get-user-by-id.test.ts`

**Interfaces:**
- Consumes: `getUserById` query (Task 8).
- Produces: `getUserByIdHandler(deps, call): Promise<{ user: User | null }>` — the gRPC adapter delegating to the query (filters soft-deleted).

- [ ] **Step 1: Write the failing test**

`services/users/tests/features/users/grpc/get-user-by-id.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { getUserByIdHandler } from "../../../../../src/features/users/grpc/get-user-by-id.js";

describe("getUserByIdHandler", () => {
  it("delegates to the query with the request id", async () => {
    const getUserById = vi.fn(async () => ({ id: "usr_1" }));
    const res = await getUserByIdHandler({ getUserById }, { request: { id: "usr_1" } } as any);
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), "usr_1");
    expect(res.user).toEqual({ id: "usr_1" });
  });
});
```

- [ ] **Step 2: Run → FAIL; implement**

`services/users/src/features/users/grpc/get-user-by-id.ts`:
```ts
import type { User } from "../domain/user.js";

export interface GrpcDeps {
  getUserById: (deps: unknown, id: string) => Promise<User | null>;
}

export async function getUserByIdHandler(
  deps: GrpcDeps,
  call: { request: { id: string } },
): Promise<{ user: User | null }> {
  const user = await deps.getUserById(deps, call.request.id);
  return { user };
}
```

- [ ] **Step 3: Run → PASS. Commit (propose to user)**

```bash
git add services/users/src/features/users/grpc services/users/tests/features/users/grpc
git commit -m "feat(users): add gRPC GetUserById handler"
```

---

## Task 11: Dockerfile (pnpm) + nested CLAUDE.md update + docker-compose adjust

**Files:**
- Modify: `services/users/Dockerfile`
- Modify: `services/users/CLAUDE.md` (Commands section)
- Modify: `docker-compose.yml` (users service env: DB urls, Cognito ids, E2E flag, PORT)

**Interfaces:**
- Consumes: the pnpm package (Task 3), `server.ts` (Task 9).
- Produces: a buildable `users` image that runs `node --experimental-strip-types src/server.ts`, compatible with compose `--watch`.

- [ ] **Step 1: Rewrite the Dockerfile for pnpm**

`services/users/Dockerfile`:
```dockerfile
# Users service — Fastify + Node 24 (pinned via repo .nvmrc), pnpm via corepack.
FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml package.json ./
COPY services/users/package.json ./services/users/
RUN pnpm install --frozen-lockfile --filter @3mrai/users...

FROM base AS runtime
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/services/users/node_modules ./services/users/node_modules
COPY services/users ./services/users
WORKDIR /app/services/users
RUN pnpm prisma generate
EXPOSE 3000
CMD ["node", "--experimental-strip-types", "src/server.ts"]
```
> Note: the build context for `users` in `docker-compose.yml` must be the **repo root** (so the lockfile is available). Adjust `build:` accordingly in Step 3.

- [ ] **Step 2: Update services/users/CLAUDE.md Commands**

In `services/users/CLAUDE.md` section "## 2. Commands", replace npm/npx commands:
```markdown
- Install: `nvm use && corepack enable && pnpm install --frozen-lockfile`
- Build: `pnpm build`
- Test: `pnpm test`
- Lint: `pnpm lint`
- Run local (docker-watch): `docker compose up users --watch` (from repo root)
- Migrate: `pnpm prisma migrate dev`
```

- [ ] **Step 3: Adjust docker-compose users service**

In `docker-compose.yml`, change the `users` service `build` to root context and add env:
```yaml
  users:
    build:
      context: .
      dockerfile: services/users/Dockerfile
    networks: [3mrai-network]
    depends_on:
      ministack:
        condition: service_healthy
    environment:
      - AWS_ENDPOINT_URL=http://ministack:4566
      - AWS_REGION=us-east-1
      - AWS_ACCESS_KEY_ID=test
      - AWS_SECRET_ACCESS_KEY=test
      - PORT=3000
      - DATABASE_WRITER_URL=postgres://test:test@ministack:4566/users
      - DATABASE_READER_URL=postgres://test:test@ministack:4566/users
      - COGNITO_USER_POOL_ID=${COGNITO_USER_POOL_ID}
      - COGNITO_CLIENT_ID=${COGNITO_CLIENT_ID}
      - E2E_TESTING_ENABLED=true
    develop:
      watch:
        - action: sync
          path: ./services/users/src
          target: /app/services/users/src
```
> The `DATABASE_*` and `COGNITO_*` values come from the Terraform `environments/local` outputs (Task 7). Wire them via a `.env` file or the documented apply→export flow; document this in the infra README.

- [ ] **Step 4: Build the image**

Run: `docker compose build users`
Expected: image builds successfully.

- [ ] **Step 5: Commit (propose to user)**

```bash
git add services/users/Dockerfile services/users/CLAUDE.md docker-compose.yml
git commit -m "build(users): pnpm Dockerfile, root build context, compose env wiring"
```

---

## Task 12: Terraform modules — label, networking, rds-aurora, cognito

**Files:**
- Create: `infra/modules/label/{main,variables,outputs}.tf`
- Create: `infra/modules/networking/{main,variables,outputs}.tf`
- Create: `infra/modules/rds-aurora/{main,variables,outputs}.tf`
- Create: `infra/modules/cognito/{main,variables,outputs}.tf`

**Interfaces:**
- Produces reusable modules. `rds-aurora` outputs `writer_endpoint`, `reader_endpoint`, `secret_arn`. `cognito` outputs `user_pool_id`, `client_id`, `issuer`. `label` outputs `id`, `tags`. `networking` outputs `vpc_id`, `subnet_ids`, `security_group_ids`.

- [ ] **Step 1: label module**

`infra/modules/label/main.tf`:
```hcl
module "this" {
  source      = "cloudposse/label/null"
  version     = "0.25.0"
  namespace   = var.namespace
  environment = var.environment
  stage       = var.stage
  name        = var.name
  attributes  = var.attributes
  tags        = var.tags
}
```
`variables.tf` declares `namespace` (default `"3mrai"`), `environment`, `stage` (default `""`), `name`, `attributes` (list(string), default `[]`), `tags` (map, default `{}`). `outputs.tf` exposes `id = module.this.id` and `tags = module.this.tags`.

- [ ] **Step 2: networking module**

`infra/modules/networking/main.tf` provisions a minimal VPC, two subnets, and a security group allowing intra-VPC + ALB ingress. Use `var.context` (label outputs) for naming/tags. `outputs.tf` exposes `vpc_id`, `subnet_ids`, `security_group_ids`.

- [ ] **Step 3: rds-aurora module**

`infra/modules/rds-aurora/main.tf` provisions an `aws_rds_cluster` (engine `aurora-postgresql`), one writer instance + one reader instance (`aws_rds_cluster_instance` ×2), a `aws_secretsmanager_secret` for credentials, and a DB subnet group. Critically, the application DB user must be created **without `DELETE`** (document this; the privilege grant runs via an init step since Terraform doesn't manage in-DB grants directly — note it in the module README). `outputs.tf` exposes `writer_endpoint`, `reader_endpoint`, `secret_arn`.

- [ ] **Step 4: cognito module**

`infra/modules/cognito/main.tf` — reuse the exact authorizer-compatible config validated in Task 1's spike (issuer/audience/auth flows). Provision `aws_cognito_user_pool` + `aws_cognito_user_pool_client` (`ADMIN_USER_PASSWORD_AUTH`, `USER_PASSWORD_AUTH`, no secret). `outputs.tf` exposes `user_pool_id`, `client_id`, `issuer = "https://cognito-idp.us-east-1.amazonaws.com/${aws_cognito_user_pool.this.id}"` (AWS-format issuer — **not** localhost, proven by spike).

- [ ] **Step 5: Validate**

Run: `cd infra && terraform fmt -recursive && terraform -chdir=modules/rds-aurora validate || true`
(Module-level validate may need a thin test harness; at minimum `terraform fmt` + a root validate in Task 14 covers it.)

- [ ] **Step 6: Commit (propose to user)**

```bash
git add infra/modules/label infra/modules/networking infra/modules/rds-aurora infra/modules/cognito
git commit -m "feat(infra): add label, networking, rds-aurora, cognito modules"
```

---

## Task 13: Terraform modules — compute (ECS Nginx proxy) + api-gateway (JWT authorizer, no ALB)

**Files:**
- Create: `infra/modules/compute/{main,variables,outputs}.tf`
- Create: `infra/modules/api-gateway/{main,variables,outputs}.tf`

**Interfaces:**
- Consumes: networking outputs (Task 12), cognito outputs (Task 12).
- Produces: `compute` outputs `cluster_arn`, `service_name`, `task_container_ip` (the
  Nginx container's IP on `3mrai-network`, discovered at apply time for bootstrap).
  `api-gateway` outputs `invoke_url`. The api-gateway module wires the JWT authorizer
  using the cognito `issuer`/`audience` proven in Task 1. **No ALB** in local — removed
  per spike outcome.

> **Production note (deferred):** in production the `compute` module would run the service
> code directly in the Fargate task, and the `api-gateway` module would integrate via an
> ALB listener ARN. Those paths are not implemented here.

- [ ] **Step 1: compute module (Nginx reverse proxy)**

`infra/modules/compute/main.tf` provisions an ECS Fargate cluster, a task definition
running **`nginx:alpine`** (not the service code). The Nginx configuration is injected via
the container `command` override:
```
nginx -g "daemon off;" with an inline nginx.conf that sets:
  resolver 127.0.0.11 valid=5s;
  set $backend http://users:3000;
  proxy_pass $backend;
```
This resolves the `users` compose service by Docker's embedded DNS at `127.0.0.11`.
CPU/memory: minimal (256/512). The ECS service attaches to the `3mrai_3mrai-network` Docker
network so Nginx and the compose `users` container share the same network. Health check:
`GET /v1/health`. **No ALB, no target group.** `outputs.tf` exposes `cluster_arn`,
`service_name`, `task_family`.

- [ ] **Step 2: api-gateway module (HTTP_PROXY to Nginx, no ALB)**

`infra/modules/api-gateway/main.tf` provisions:
- `aws_apigatewayv2_api` (HTTP protocol)
- `aws_apigatewayv2_authorizer` (JWT, issuer/audience from `var.cognito_issuer` /
  `var.cognito_audience` — AWS-format issuer proven in Task 1 spike)
- `aws_apigatewayv2_integration` (type `HTTP_PROXY`, integration URI
  `http://${var.nginx_container_ip}:80/{proxy}` — the Nginx container IP is provided as a
  variable, patched by the local bootstrap step after task launch)
- Routes: public `POST /v1/users/register`, `POST /v1/users/login`, `GET /v1/health`;
  protected (authorizer attached) `GET /v1/users/me`, `PATCH /v1/users/me`.

`outputs.tf` exposes `invoke_url`. Accept `var.nginx_container_ip` (string) so the local
bootstrap can patch it post-launch.

- [ ] **Step 3: Validate formatting**

Run: `cd infra && terraform fmt -recursive`
Expected: files formatted, no errors.

- [ ] **Step 4: Commit (propose to user)**

```bash
git add infra/modules/compute infra/modules/api-gateway
git commit -m "feat(infra): add compute (ECS Nginx proxy) and api-gateway (JWT authorizer, no ALB) modules"
```

---

## Task 14: environments/local composition + apply against Ministack + bootstrap

**Files:**
- Create: `infra/environments/local/{providers,terraform,variables,main,outputs}.tf`
- Create: `infra/environments/local/bootstrap.sh` — local-only bootstrap script

**Interfaces:**
- Consumes: all six modules (Tasks 12–13).
- Produces: a `terraform apply` + bootstrap that stands up the full Users chain on
  Ministack and outputs `api_invoke_url`, `database_writer_url`, `database_reader_url`,
  `cognito_user_pool_id`, `cognito_client_id`. The bootstrap patches the API GW
  integration URI with the Nginx container IP after task launch.

- [ ] **Step 1: Provider + backend config**

`infra/environments/local/providers.tf` — same Ministack endpoint block as the spike
(Task 1, Step 1) plus `rds`, `secretsmanager` endpoints. `terraform.tf` pins
`required_version >= 1.7` and the AWS provider.

- [ ] **Step 2: Compose the modules**

`infra/environments/local/main.tf` instantiates `label`, `networking`, `rds-aurora`,
`cognito`, then `compute` (passing networking), then `api-gateway` (passing cognito
issuer/audience + `nginx_container_ip = ""` as placeholder — bootstrapped in Step 5).
**No ALB or target-group wiring** — the integration target is the Nginx container IP
directly. Pass `context = module.label` to every module.

- [ ] **Step 3: Outputs**

`infra/environments/local/outputs.tf` exposes `api_invoke_url`, `database_writer_url`,
`database_reader_url`, `cognito_user_pool_id`, `cognito_client_id` (sourced from module
outputs; build the DB URLs from the rds endpoints + secret).

- [ ] **Step 4: Init, validate, apply (first pass)**

Run:
```bash
docker compose up -d ministack
cd infra/environments/local && terraform init && terraform validate && terraform apply -auto-approve
```
Expected: apply succeeds; the Nginx ECS task is launched; `terraform output` prints all
five values.

- [ ] **Step 5: Local bootstrap — discover Nginx IP + patch API GW integration**

`infra/environments/local/bootstrap.sh`:
```bash
#!/usr/bin/env bash
# Local-only bootstrap: discovers the Nginx ECS container IP on 3mrai-network
# and patches the API Gateway HTTP_PROXY integration URI.
set -euo pipefail

CONTAINER_NAME=$(docker ps --filter "name=nginx" --format "{{.Names}}" | head -1)
NGINX_IP=$(docker inspect "$CONTAINER_NAME" \
  --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')

echo "Nginx container: $CONTAINER_NAME  IP: $NGINX_IP"

# Re-apply Terraform with the discovered IP so the integration URI is patched.
terraform -chdir="$(dirname "$0")" apply -auto-approve \
  -var "nginx_container_ip=$NGINX_IP"

echo "Bootstrap complete. Integration URI → http://$NGINX_IP:80/{proxy}"
```

Run: `bash infra/environments/local/bootstrap.sh`
Expected: Nginx IP discovered; `terraform apply` patches the API GW integration URI;
`curl <api_invoke_url>/v1/health` returns 200 via the Nginx proxy.

> **Design note:** this bootstrap step is local-only. In production the API GW integration
> target is a stable ALB DNS name; no IP patching is needed. This step is required for
> JE-30/JE-36 implementation.

- [ ] **Step 6: Run the DB migration against the provisioned Aurora**

Run (from repo root, with the output URLs exported):
```bash
export DATABASE_WRITER_URL=$(terraform -chdir=infra/environments/local output -raw database_writer_url)
nvm use && pnpm --filter @3mrai/users prisma migrate deploy
```
Expected: the `users` table (incl. `tags`) is created.

- [ ] **Step 7: Commit (propose to user)**

```bash
git add infra/environments/local
git commit -m "feat(infra): compose local environment + Nginx bootstrap + apply Users chain on Ministack"
```

---

## Task 15: E2E harness (Playwright + chancejs, root)

**Files:**
- Create: `e2e/package.json`
- Create: `e2e/playwright.config.ts`
- Create: `e2e/support/chance-factory.ts`
- Create: `e2e/support/api-client.ts`
- Create: `e2e/support/global-setup.ts`
- Create: `e2e/support/global-teardown.ts`

**Interfaces:**
- Consumes: the running stack (Task 14) and the API Gateway invoke URL.
- Produces: a Playwright project `@3mrai/e2e` with Chance-based mock data, an API client targeting the API Gateway, global setup (compose up + health wait) and teardown (cleanup endpoint call).

- [ ] **Step 1: Create the package**

`e2e/package.json`:
```json
{
  "name": "@3mrai/e2e",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": { "test": "playwright test" },
  "devDependencies": {
    "@playwright/test": "^1.48.0",
    "chance": "^1.1.12",
    "@types/chance": "^1.1.6"
  }
}
```

- [ ] **Step 2: Chance factory (seeded)**

`e2e/support/chance-factory.ts`:
```ts
import Chance from "chance";

// Seed per run for reproducibility; emails made unique to avoid cross-run collisions.
const chance = new Chance(Number(process.env.E2E_SEED ?? 1));

export function makeUser() {
  const unique = `${Date.now()}.${chance.guid()}`;
  return {
    email: `e2e+${unique}@example.com`,
    password: `Aa1!${chance.string({ length: 10, alpha: true, numeric: true })}`,
    fullName: chance.name(),
    phoneNumber: chance.phone(),
    address: { line1: chance.address(), city: chance.city(), country: chance.country({ full: true }) },
  };
}
```

- [ ] **Step 3: API client (through API Gateway)**

`e2e/support/api-client.ts`:
```ts
import { request, type APIRequestContext } from "@playwright/test";

export async function apiClient(): Promise<APIRequestContext> {
  const baseURL = process.env.API_INVOKE_URL;
  if (!baseURL) throw new Error("API_INVOKE_URL is required for E2E (the API Gateway invoke URL)");
  return request.newContext({ baseURL, extraHTTPHeaders: { "X-E2E-Source": "true" } });
}
```

- [ ] **Step 4: Global setup (compose up + health)**

`e2e/support/global-setup.ts`:
```ts
import { execSync } from "node:child_process";

export default async function globalSetup() {
  execSync("docker compose up -d", { stdio: "inherit" });
  const base = process.env.API_INVOKE_URL;
  if (!base) throw new Error("API_INVOKE_URL is required");
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/v1/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Stack did not become healthy within 120s");
}
```

- [ ] **Step 5: Global teardown (cleanup endpoint)**

`e2e/support/global-teardown.ts`:
```ts
export default async function globalTeardown() {
  const base = process.env.API_INVOKE_URL;
  if (!base) return;
  // Soft-deletes every user tagged "E2E Source" (flag-gated endpoint).
  await fetch(`${base}/v1/users/e2e-cleanup`, { method: "DELETE" });
}
```

- [ ] **Step 6: Playwright config**

`e2e/playwright.config.ts`:
```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./support/global-setup.ts",
  globalTeardown: "./support/global-teardown.ts",
  use: { baseURL: process.env.API_INVOKE_URL },
  reporter: "list",
});
```

- [ ] **Step 7: Install browsers + verify config loads**

Run:
```bash
nvm use && pnpm install && pnpm --filter @3mrai/e2e exec playwright --version
```
Expected: Playwright version prints.

- [ ] **Step 8: Commit (propose to user)**

```bash
git add e2e/package.json e2e/playwright.config.ts e2e/support pnpm-lock.yaml
git commit -m "test(e2e): add Playwright harness with chancejs factory, API client, setup/teardown"
```

---

## Task 16: E2E specs (Users flows through the API Gateway)

**Files:**
- Create: `e2e/tests/users.spec.ts`

**Interfaces:**
- Consumes: the harness (Task 15) and the full running chain (Task 14).
- Produces: passing E2E coverage of register → login → me (through the authorizer) → health, with E2E-tagged data cleaned up by teardown.

- [ ] **Step 1: Write the spec**

`e2e/tests/users.spec.ts`:
```ts
import { test, expect } from "@playwright/test";
import { apiClient } from "../support/api-client.js";
import { makeUser } from "../support/chance-factory.js";

test("health is ok", async () => {
  const api = await apiClient();
  const res = await api.get("/v1/health");
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ status: "ok" });
});

test("register marks the user as E2E Source", async () => {
  const api = await apiClient();
  const res = await api.post("/v1/users/register", { data: makeUser() });
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body.tags).toContain("E2E Source");
});

test("login returns Cognito tokens", async () => {
  const api = await apiClient();
  const user = makeUser();
  await api.post("/v1/users/register", { data: user });
  const res = await api.post("/v1/users/login", { data: { email: user.email, password: user.password } });
  expect(res.status()).toBe(200);
  expect((await res.json()).idToken).toBeTruthy();
});

test("GET /v1/users/me requires a JWT (authorizer) and returns the profile", async () => {
  const api = await apiClient();
  const user = makeUser();
  await api.post("/v1/users/register", { data: user });
  const login = await api.post("/v1/users/login", { data: { email: user.email, password: user.password } });
  const { idToken } = await login.json();

  // Without a token → 401 from the API Gateway authorizer.
  const unauth = await api.get("/v1/users/me");
  expect(unauth.status()).toBe(401);

  // With a token → 200.
  const me = await api.get("/v1/users/me", { headers: { Authorization: `Bearer ${idToken}` } });
  expect(me.status()).toBe(200);
  expect((await me.json()).email).toBe(user.email);
});
```

- [ ] **Step 2: Run the suite end-to-end**

Run (with infra applied and outputs exported):
```bash
export API_INVOKE_URL=$(terraform -chdir=infra/environments/local output -raw api_invoke_url)
nvm use && pnpm --filter @3mrai/e2e test
```
Expected: all specs pass; teardown soft-deletes the E2E-tagged users.

- [ ] **Step 3: Verify cleanup worked**

Run: re-run only the register count assertion or query the DB to confirm E2E users have `deleted_at` set (none hard-deleted).
Expected: rows still exist with `deleted_at` populated.

- [ ] **Step 4: Commit (propose to user)**

```bash
git add e2e/tests/users.spec.ts
git commit -m "test(e2e): add Users flow specs through the API Gateway"
```

---

## Task 17: Vault sync — add `tags` to the canonical Users spec

**Files:**
- Modify (via `obsidian-vault` agent only): `docs/domains/users/specs/users-service-design.md`

**Interfaces:** documentation only.

- [ ] **Step 1: Route the edit through obsidian-vault**

Hand the `obsidian-vault` agent this change: add a `tags` row to the Data Model table in `users-service-design.md`:
```markdown
| `tags` | `text[]` | Array of labels; `E2E Source` marks records created by Playwright E2E (see [[2026-06-28-users-service-design]]) |
```
Plus a one-line note that the `E2E Source` tag is server-injected (header + `E2E_TESTING_ENABLED` flag), and add `[[2026-06-28-users-service-design]]` to the `## Related` section. Keep frontmatter/tags/wikilinks valid.

- [ ] **Step 2: Validate the vault**

Run: `nvm use && node scripts/validate-vault.mjs`
Expected: no frontmatter or broken-wikilink errors.

- [ ] **Step 3: Commit (propose to user)**

```bash
git add docs/domains/users/specs/users-service-design.md
git commit -m "docs(users): document tags column + E2E Source marking in service spec"
```

---

## Self-Review

**Spec coverage:**
- Infra modules (label/networking/rds-aurora/cognito/compute/api-gateway) → Tasks 12–13. ✅
- environments/local + apply + Nginx bootstrap + migration → Task 14. ✅
- API GW → Nginx ECS proxy → watch container → Aurora chain (local, proven) → Tasks 13–14; validated by spike Task 1. ✅
- ALB removed from local (production-only / deferred) → Tasks 13–14; Global Constraints. ✅
- Ministack spike DONE/GATE PASS → Task 1 (completed). ✅
- pnpm workspace (root + Users) + corepack → Tasks 2, 3, 11. ✅
- Schema with `tags text[]` + writer/reader → Task 4. ✅
- Soft-delete only / no DELETE → Task 12 (module note), Tasks 8–9 (query filters + soft-delete cleanup). ✅
- nano-id, audit, no-op EventPublisher → Task 5. ✅
- Cognito auth (signUp/login, `ADMIN_USER_PASSWORD_AUTH`) → Task 6; authorizer at the edge → Tasks 1, 13, 16. ✅
- API endpoints register/login/me/health + e2e-cleanup → Tasks 8–9. ✅
- E2E header + flag marking → Tasks 8 (use-case), 9 (route), tested 8/9 + E2E 16. ✅
- Vitest unit → Tasks 4–10. ✅
- Playwright E2E + chancejs + cleanup-by-tag → Tasks 15–16. ✅
- Vault sync of `tags` → Task 17. ✅
- SQS not provisioned / production not instantiated / no ALB in local / only e2e+users in workspace → respected throughout (Global Constraints). ✅

**Placeholder scan:** Terraform module bodies in Tasks 12–13 describe resources in prose where the exact HCL is environment-specific (RDS instance classes, subnet CIDRs) — these are deliberately parameterized, not TODO placeholders; the key authorizer config and Nginx DNS resolver config are pinned to the spike's proven values. No "TBD"/"implement later" in code steps. ✅

**Type consistency:** `registerUser`/`loginUser`/`getMe`/`updateProfile`/`softDeleteE2EUsers`/`getUserById` signatures match between definition (Task 8/9) and consumption (DI container Task 9, routes Task 9). `AuthProvider`/`AuthTokens`, `EventPublisher`, `User`/`toDomain` consistent across tasks. `e2eSource` boolean threaded register use-case → route. ✅

## Related

- [[2026-06-28-users-service-design]] — the design spec this plan implements.
- [[users-service-design]] — canonical service contract.
- [[phase-c-review-flow]] — batch review + dependency gates this plan's sequencing follows.
- [[milestone-plan]] — the milestone plan note convention (the `docs/plans/` note is produced in Phase B).
