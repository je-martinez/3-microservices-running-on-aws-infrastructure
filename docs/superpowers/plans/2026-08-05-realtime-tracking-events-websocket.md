---
title: Realtime Tracking Events over WebSocket — Implementation Plan
type: plan
area: events-pipeline
status: active
created: 2026-08-05
updated: 2026-08-06
tags:
  - type/plan
  - area/events-pipeline
  - status/active
propagates-to:
  - "[[events-pipeline-design]]"
  - "[[tracking-service-design]]"
  - "[[testing]]"
  - "[[terraform-modules]]"
related:
  - "[[2026-08-05-realtime-tracking-events-websocket-design]]"
  - "[[user-id-vs-cognito-sub-ownership-key]]"
  - "[[env-files]]"
  - "[[logging-context]]"
  - "[[ADR-0017-floci-local]]"
---

# Realtime Tracking Events over WebSocket Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push a realtime message to a user's connected WebSocket clients every time one of their trackings changes status, authenticated with Cognito.

**Architecture:** A new API Gateway **WebSocket** API authenticates `$connect` with a REQUEST Lambda authorizer that validates a Cognito JWT taken from the query string, then stores `{connection_id, cognito_sub}` in DynamoDB. The **existing** events-pipeline Lambda gains a second output on its existing `TRACKING_STATUS_CHANGED` handler: after sending the email it queries that table by `cognito_sub` and calls `PostToConnection` for each live connection, deleting rows that answer `410 Gone`. Tracking's existing publisher is extended to carry `author.cognito_sub` so the pipeline has a key to query by.

**Tech Stack:** TypeScript on `nodejs20.x` (esbuild → single CJS bundle), `@aws-sdk/client-dynamodb` + `@aws-sdk/client-apigatewaymanagementapi`, `aws-jwt-verify` for JWT validation, Terraform (AWS provider pinned `= 5.31.0`), Python/FastAPI on the Tracking side, Vitest and pytest.

**Design spec:** [[2026-08-05-realtime-tracking-events-websocket-design]] — read it before starting. Every decision here traces to it.

## Global Constraints

- **Node version:** run `nvm use` before ANY node/npm/npx/pnpm command. Repo pins **24.18.0** via `.nvmrc`. The Lambda *runtime* is `nodejs20.x` — that mismatch is deliberate and load-bearing (see the CJS bundling constraint below).
- **Lambda bundling:** every function ships as a **single CommonJS esbuild bundle**, following `functions/events-pipeline/scripts/build.mjs`. Plain `tsc` is not sufficient: it leaves `#` subpath imports unresolved, and `dist/` has no `package.json`, so Node throws `ERR_PACKAGE_IMPORT_NOT_DEFINED`. An ESM bundle emitted as `.js` also fails under `nodejs20.x` with `ERR_REQUIRE_CYCLE_MODULE` while passing under Node 24 — a Node-24-only test reports a false pass.
- **Terraform provider:** AWS provider is pinned `= 5.31.0` repo-wide. Do not bump it.
- **A second `terraform apply` against Floci FAILS.** To re-apply: `docker compose down && rm -rf data/floci && rm -f infra/environments/local/terraform.tfstate* && make bootstrap`. Plan for full-rebuild cycles, not incremental applies.
- **Env files are generated, never hand-edited.** New variables go into the generator (`make env-file`) and `.env.example`. Never hardcode a table name, endpoint, or URL.
- **Logging:** never log a token, a plaintext email, or a full payload. Use `email_hash`. Every line carries the shared context (`trace_id`, `user_id`, `order_id`, `event_id`). See [[logging-context]].
- **Scripting language:** new scripts are **Python** by default; JS only where the task already lives in the Node ecosystem. Zero `.sh` files in this repo.
- **The `cognito_sub` column on `Tracking` is NULLABLE** (`services/tracking/src/features/tracking/domain/models.py:95`). Every code path that reads it must handle `None`.

## Verified Floci facts (do not re-derive)

A POC on 2026-08-05 verified these against the live local environment. They are settled; build on them.

| Fact | Value |
|---|---|
| WebSocket data-plane URL | `ws://localhost:4566/ws/{apiId}/{stage}` |
| `@connections` management endpoint | `http://localhost:4566/execute-api/{apiId}/{stage}` — **undocumented prefix**, differs from real AWS |
| REQUEST authorizer on `$connect` | Invoked; returned `context` propagates intact to the handler |
| Dead connection | `PostToConnection` → HTTP **410**, `GoneException` |
| DynamoDB | Table + GSI + Query-by-GSI + DeleteItem all work |

Wrong management-API URLs return **HTTP 400 with an S3 XML error body**, because unrouted `:4566` paths fall through to Floci's S3 handler. If you see `<Error><Code>InvalidArgument</Code>`, your endpoint is wrong — it is not a credentials problem.

---

## File Structure

**New package `functions/realtime-events/`:**

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts` | Package config, mirroring `functions/events-pipeline/` |
| `scripts/build.mjs` | esbuild → three CJS bundles (`dist/authorizer.js`, `dist/connect.js`, `dist/disconnect.js`) |
| `src/authorizer.ts` | `$connect` REQUEST authorizer entrypoint |
| `src/connect.ts` | `$connect` entrypoint |
| `src/disconnect.ts` | `$disconnect` entrypoint |
| `src/default.ts` | `$default` entrypoint — rejects, never mutates state |
| `src/shared/jwt.ts` | Cognito JWT verification (wraps `aws-jwt-verify`) |
| `src/shared/connections-repository.ts` | The ONLY module that talks to the DynamoDB table |
| `src/shared/config/env.ts` | Typed env access |
| `src/shared/logging/logger.ts` | Pino logger, shared-context fields |
| `tests/*.test.ts` | One test file per entrypoint + the repository |

**Modified — `functions/events-pipeline/`:**

| File | Change |
|---|---|
| `src/shared/realtime/connections-reader.ts` (new) | Query the table by `cognito_sub`; delete a row on 410 |
| `src/shared/realtime/websocket-publisher.ts` (new) | `PostToConnection` fan-out, log-and-swallow |
| `src/handlers/tracking-status-changed.ts` | Call the publisher after `sendEmail`; fix the stale comment block |
| `src/shared/config/env.ts` | Add the three new env vars |
| `package.json` | Add the two AWS SDK deps |

**Modified — `services/tracking/`:**

| File | Change |
|---|---|
| `src/features/tracking/commands/update_status.py` | Pass `cognito_sub` from the persisted entity into `_emit_status_changed` |
| `src/shared/messaging/sqs_event_publisher.py` | Accept `cognito_sub`, set `author.cognito_sub` when present |
| `src/shared/messaging/event_publisher.py` | Widen the port's signature |

**Modified — infra:**

| File | Change |
|---|---|
| `infra/modules/dynamodb/` (new) | `main.tf`, `variables.tf`, `outputs.tf` — the connections table |
| `infra/modules/api-gateway-ws/` (new) | The WebSocket API, stage, authorizer, 4 routes, 4 Lambda functions + permissions |
| `infra/environments/local/main.tf` | Wire both modules |
| `infra/environments/local/post/` or the env-file generator | Emit the new vars |
| `.env.example` | Document the new vars |

---

## Task 1: DynamoDB Terraform module

**Files:**
- Create: `infra/modules/dynamodb/main.tf`, `infra/modules/dynamodb/variables.tf`, `infra/modules/dynamodb/outputs.tf`

**Interfaces:**
- Consumes: the repo's `label` module for naming (see any existing module, e.g. `infra/modules/messaging/main.tf`, for the `context` variable pattern).
- Produces: outputs `table_name` (string), `table_arn` (string), `gsi_name` (string, always `"by-cognito-sub"`).

- [ ] **Step 1: Read an existing module to copy the conventions**

Read `infra/modules/messaging/main.tf`, `variables.tf`, and `outputs.tf` in full. Note how `var.context` flows into the `label` module and how outputs are shaped. Match that style exactly — do not invent a new one.

- [ ] **Step 2: Write `variables.tf`**

```hcl
# Matches every other module in this repo: modules do NOT instantiate the
# `label` module themselves — they receive an already-resolved context object
# exposing `.id` and `.tags`, and derive names as "${var.context.id}-<suffix>".
# See infra/modules/docdb/variables.tf for the same declaration.
variable "context" {
  description = "Label context object from the label module (must expose .id and .tags)."
  type = object({
    id   = string
    tags = map(string)
  })
}

variable "ttl_attribute" {
  description = "Attribute holding the epoch expiry. Safety net only — real cleanup is the 410-Gone path in the events-pipeline."
  type        = string
  default     = "ttl"
}
```

- [ ] **Step 3: Write `main.tf`**

```hcl
locals {
  table_name = "${var.context.id}-ws-connections"
}

# Connection registry for the WebSocket API. Written by the $connect and
# $disconnect handlers; read (and pruned on 410 Gone) by the events-pipeline.
#
# The GSI hash key is `cognito_sub`, NOT `user_id`, and the name says so
# deliberately: the event envelope's `user_id` is the internal usr_ id, and
# querying this index with it would return zero rows with no error at all.
# See docs/superpowers/specs/2026-08-05-realtime-tracking-events-websocket-design.md
# and the user-id-vs-cognito-sub-ownership-key ADR.
resource "aws_dynamodb_table" "connections" {
  name         = local.table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "connection_id"

  attribute {
    name = "connection_id"
    type = "S"
  }

  attribute {
    name = "cognito_sub"
    type = "S"
  }

  global_secondary_index {
    name            = "by-cognito-sub"
    hash_key        = "cognito_sub"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = var.ttl_attribute
    enabled        = true
  }

  tags = merge(var.context.tags, { Name = local.table_name })
}
```

- [ ] **Step 4: Write `outputs.tf`**

```hcl
output "table_name" {
  description = "Name of the WebSocket connections table."
  value       = aws_dynamodb_table.connections.name
}

output "table_arn" {
  description = "ARN of the WebSocket connections table."
  value       = aws_dynamodb_table.connections.arn
}

output "gsi_name" {
  description = "Name of the by-cognito-sub GSI the events-pipeline queries."
  value       = "by-cognito-sub"
}
```

- [ ] **Step 5: Validate**

Run: `terraform -chdir=infra/modules/dynamodb init -backend=false && terraform -chdir=infra/modules/dynamodb validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 6: Commit**

```bash
git add infra/modules/dynamodb/
git commit -m "feat(infra): add dynamodb module for websocket connection registry"
```

---

## Task 2: `realtime-events` package scaffold + JWT verifier

**Files:**
- Create: `functions/realtime-events/package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`, `scripts/build.mjs`
- Create: `functions/realtime-events/src/shared/jwt.ts`, `src/shared/config/env.ts`
- Test: `functions/realtime-events/tests/jwt.test.ts`

**Interfaces:**
- Produces:
  - `verifyCognitoToken(token: string): Promise<{ sub: string }>` — resolves with the verified claims, **rejects** on any invalid token.
  - `getEnv(): { userPoolId: string; clientId: string; tableName: string; gsiName: string; awsRegion: string; dynamoEndpoint?: string }`

- [ ] **Step 1: Read the sibling package to copy its config**

Read `functions/events-pipeline/package.json`, `tsconfig.json`, `vitest.config.ts`, and `scripts/build.mjs`. Copy their structure. Key details to preserve: `"type": "module"`, the `imports` map for `#` subpaths, `engines.node` = `24.18.0`, and the build script's CJS output format.

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "@3mrai/realtime-events",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": "24.18.0" },
  "imports": {
    "#shared/*": {
      "types": "./src/shared/*.ts",
      "development": "./src/shared/*.ts",
      "default": "./dist/shared/*.js"
    }
  },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "build": "pnpm run typecheck && node scripts/build.mjs",
    "test": "vitest run",
    "lint": "eslint ."
  },
  "dependencies": {
    "@aws-sdk/client-dynamodb": "^3.1075.0",
    "@aws-sdk/lib-dynamodb": "^3.1075.0",
    "aws-jwt-verify": "^4.0.1",
    "pino": "^10.3.1"
  },
  "devDependencies": {
    "@eslint/js": "^10.0.1",
    "@types/aws-lambda": "^8.10.152",
    "@types/node": "^26.0.1",
    "esbuild": "^0.28.1",
    "eslint": "^10.6.0",
    "typescript": "^5.6.0",
    "typescript-eslint": "^8.63.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 3: Write `scripts/build.mjs` — three bundles, CJS**

Copy `functions/events-pipeline/scripts/build.mjs` and change it to emit four entrypoints. The critical settings, which must not be changed:

```javascript
// esbuild, not tsc: tsc leaves the `#` subpath imports unresolved and dist/
// has no package.json to resolve them against, so the first invocation dies
// with ERR_PACKAGE_IMPORT_NOT_DEFINED. format: "cjs" is equally load-bearing:
// an ESM bundle emitted as .js loads under Node 24 but fails under the
// nodejs20.x runtime with ERR_REQUIRE_CYCLE_MODULE.
await esbuild.build({
  entryPoints: [
    "src/authorizer.ts",
    "src/connect.ts",
    "src/disconnect.ts",
    "src/default.ts",
  ],
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: false,
});
```

- [ ] **Step 4: Write the failing test for the JWT verifier**

```typescript
// functions/realtime-events/tests/jwt.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockVerify = vi.fn();
vi.mock("aws-jwt-verify", () => ({
  CognitoJwtVerifier: { create: () => ({ verify: mockVerify }) },
}));

describe("verifyCognitoToken", () => {
  beforeEach(() => {
    mockVerify.mockReset();
    process.env.COGNITO_USER_POOL_ID = "us-east-1_test";
    process.env.COGNITO_CLIENT_ID = "testclient";
  });

  it("returns the sub for a valid token", async () => {
    mockVerify.mockResolvedValue({ sub: "abc-123", token_use: "access" });
    const { verifyCognitoToken } = await import("../src/shared/jwt.js");
    await expect(verifyCognitoToken("good")).resolves.toEqual({ sub: "abc-123" });
  });

  it("rejects when the verifier rejects", async () => {
    mockVerify.mockRejectedValue(new Error("expired"));
    const { verifyCognitoToken } = await import("../src/shared/jwt.js");
    await expect(verifyCognitoToken("bad")).rejects.toThrow();
  });

  it("rejects an empty token without calling the verifier", async () => {
    const { verifyCognitoToken } = await import("../src/shared/jwt.js");
    await expect(verifyCognitoToken("")).rejects.toThrow();
    expect(mockVerify).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `nvm use && cd functions/realtime-events && pnpm vitest run tests/jwt.test.ts`
Expected: FAIL — cannot resolve `../src/shared/jwt.js`.

- [ ] **Step 6: Write `src/shared/jwt.ts`**

```typescript
import { CognitoJwtVerifier } from "aws-jwt-verify";

// The verifier caches the pool's JWKS, so it is built once per container and
// reused across invocations — building it per call would fetch the JWKS on
// every connection.
let verifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;

function getVerifier() {
  if (verifier === null) {
    verifier = CognitoJwtVerifier.create({
      userPoolId: process.env.COGNITO_USER_POOL_ID ?? "",
      tokenUse: "access",
      clientId: process.env.COGNITO_CLIENT_ID ?? "",
    });
  }
  return verifier;
}

/**
 * Verify a Cognito access token and return its subject.
 *
 * Throws on ANY failure — absent, malformed, expired, wrong audience, bad
 * signature. Callers must treat a rejection as Deny and never distinguish the
 * reasons to the client: telling an unauthenticated caller *why* it failed
 * hands them a probing oracle.
 */
export async function verifyCognitoToken(token: string): Promise<{ sub: string }> {
  if (!token) {
    throw new Error("missing token");
  }
  const payload = await getVerifier().verify(token);
  return { sub: String(payload.sub) };
}
```

- [ ] **Step 7: Write `src/shared/config/env.ts`**

```typescript
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env var: ${name}`);
  }
  return value;
}

export function getEnv() {
  return {
    userPoolId: required("COGNITO_USER_POOL_ID"),
    clientId: required("COGNITO_CLIENT_ID"),
    tableName: required("WS_CONNECTIONS_TABLE"),
    gsiName: process.env.WS_CONNECTIONS_GSI ?? "by-cognito-sub",
    awsRegion: process.env.AWS_REGION ?? "us-east-1",
    // Set locally so the SDK talks to Floci; unset in production so the SDK
    // resolves the real AWS endpoint. See the env-files convention.
    dynamoEndpoint: process.env.AWS_ENDPOINT_URL || undefined,
  };
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `nvm use && cd functions/realtime-events && pnpm install && pnpm vitest run tests/jwt.test.ts`
Expected: 3 passed.

- [ ] **Step 9: Commit**

```bash
git add functions/realtime-events/
git commit -m "feat(events-pipeline): scaffold realtime-events package with cognito jwt verifier"
```

---

## Task 3: Connections repository

**Files:**
- Create: `functions/realtime-events/src/shared/connections-repository.ts`
- Test: `functions/realtime-events/tests/connections-repository.test.ts`

**Interfaces:**
- Consumes: `getEnv()` from Task 2.
- Produces:
  - `saveConnection(connectionId: string, cognitoSub: string): Promise<void>`
  - `deleteConnection(connectionId: string): Promise<void>`
  - `TTL_SECONDS: number` (exported constant, `7200`)

- [ ] **Step 1: Write the failing test**

```typescript
// functions/realtime-events/tests/connections-repository.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const send = vi.fn();
vi.mock("@aws-sdk/lib-dynamodb", async () => {
  const actual = await vi.importActual<typeof import("@aws-sdk/lib-dynamodb")>(
    "@aws-sdk/lib-dynamodb",
  );
  return {
    ...actual,
    DynamoDBDocumentClient: { from: () => ({ send }) },
  };
});

describe("connections repository", () => {
  beforeEach(() => {
    send.mockReset();
    send.mockResolvedValue({});
    process.env.COGNITO_USER_POOL_ID = "us-east-1_test";
    process.env.COGNITO_CLIENT_ID = "testclient";
    process.env.WS_CONNECTIONS_TABLE = "conns";
  });

  it("writes connection_id, cognito_sub, connected_at and ttl", async () => {
    const { saveConnection, TTL_SECONDS } = await import(
      "../src/shared/connections-repository.js"
    );
    await saveConnection("conn-1", "sub-1");

    expect(send).toHaveBeenCalledTimes(1);
    const item = send.mock.calls[0][0].input.Item;
    expect(item.connection_id).toBe("conn-1");
    expect(item.cognito_sub).toBe("sub-1");
    expect(typeof item.connected_at).toBe("number");
    // ttl must be in the future by roughly TTL_SECONDS
    const now = Math.floor(Date.now() / 1000);
    expect(item.ttl).toBeGreaterThan(now);
    expect(item.ttl).toBeLessThanOrEqual(now + TTL_SECONDS + 5);
  });

  it("deletes by connection_id only", async () => {
    const { deleteConnection } = await import(
      "../src/shared/connections-repository.js"
    );
    await deleteConnection("conn-1");
    expect(send.mock.calls[0][0].input.Key).toEqual({ connection_id: "conn-1" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `nvm use && cd functions/realtime-events && pnpm vitest run tests/connections-repository.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write the implementation**

```typescript
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { getEnv } from "#shared/config/env";

// Two hours: API Gateway's own hard cap on a WebSocket connection's lifetime,
// so a row older than this cannot correspond to a live connection.
//
// This is a SAFETY NET, not the cleanup mechanism. Real cleanup is reactive —
// the events-pipeline deletes a row the moment PostToConnection answers 410
// Gone. DynamoDB TTL deletes within a window of up to 48 hours, far too loose
// to rely on. See the design spec's "TTL is a safety net" section.
export const TTL_SECONDS = 7200;

let docClient: DynamoDBDocumentClient | null = null;

function client(): DynamoDBDocumentClient {
  if (docClient === null) {
    const env = getEnv();
    docClient = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        region: env.awsRegion,
        ...(env.dynamoEndpoint ? { endpoint: env.dynamoEndpoint } : {}),
      }),
    );
  }
  return docClient;
}

export async function saveConnection(
  connectionId: string,
  cognitoSub: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await client().send(
    new PutCommand({
      TableName: getEnv().tableName,
      Item: {
        connection_id: connectionId,
        cognito_sub: cognitoSub,
        connected_at: now,
        ttl: now + TTL_SECONDS,
      },
    }),
  );
}

export async function deleteConnection(connectionId: string): Promise<void> {
  await client().send(
    new DeleteCommand({
      TableName: getEnv().tableName,
      Key: { connection_id: connectionId },
    }),
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `nvm use && cd functions/realtime-events && pnpm vitest run tests/connections-repository.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add functions/realtime-events/src/shared/connections-repository.ts functions/realtime-events/tests/connections-repository.test.ts
git commit -m "feat(events-pipeline): add websocket connections repository"
```

---

## Task 4: The four Lambda entrypoints

**Files:**
- Create: `functions/realtime-events/src/authorizer.ts`, `src/connect.ts`, `src/disconnect.ts`, `src/default.ts`
- Test: `functions/realtime-events/tests/authorizer.test.ts`, `tests/connect.test.ts`, `tests/disconnect.test.ts`

**Interfaces:**
- Consumes: `verifyCognitoToken` (Task 2), `saveConnection`/`deleteConnection` (Task 3).
- Produces: four exported `handler` functions, one per file.

- [ ] **Step 1: Write the failing authorizer test**

```typescript
// functions/realtime-events/tests/authorizer.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyCognitoToken = vi.fn();
vi.mock("../src/shared/jwt.js", () => ({ verifyCognitoToken }));

const EVENT = (token?: string) => ({
  methodArn: "arn:aws:execute-api:us-east-1:000000000000:abc/dev/$connect",
  queryStringParameters: token === undefined ? null : { token },
});

describe("$connect authorizer", () => {
  beforeEach(() => verifyCognitoToken.mockReset());

  it("allows a valid token and puts cognito_sub in the context", async () => {
    verifyCognitoToken.mockResolvedValue({ sub: "sub-abc" });
    const { handler } = await import("../src/authorizer.js");
    const res = await handler(EVENT("good") as never);
    expect(res.policyDocument.Statement[0].Effect).toBe("Allow");
    expect(res.context.cognito_sub).toBe("sub-abc");
  });

  it("denies when verification fails", async () => {
    verifyCognitoToken.mockRejectedValue(new Error("expired"));
    const { handler } = await import("../src/authorizer.js");
    const res = await handler(EVENT("bad") as never);
    expect(res.policyDocument.Statement[0].Effect).toBe("Deny");
  });

  it("denies when the token is absent entirely", async () => {
    const { handler } = await import("../src/authorizer.js");
    const res = await handler(EVENT() as never);
    expect(res.policyDocument.Statement[0].Effect).toBe("Deny");
    expect(verifyCognitoToken).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `nvm use && cd functions/realtime-events && pnpm vitest run tests/authorizer.test.ts`
Expected: FAIL — cannot resolve `../src/authorizer.js`.

- [ ] **Step 3: Write `src/authorizer.ts`**

```typescript
import type {
  APIGatewayRequestAuthorizerEvent,
  APIGatewayAuthorizerResult,
} from "aws-lambda";
import { verifyCognitoToken } from "#shared/jwt";
import { logger } from "#shared/logging/logger";

// The token travels in the QUERY STRING, not a header. This is forced, not
// preferred: a browser's `new WebSocket(url)` cannot set custom headers, and a
// POC on 2026-08-05 confirmed the only headers reaching this authorizer are
// the handshake's own (Sec-WebSocket-Key, Connection, Sec-WebSocket-Version,
// Host, Upgrade) — no Authorization header arrives at all.
function policy(
  effect: "Allow" | "Deny",
  methodArn: string,
  context?: Record<string, string>,
): APIGatewayAuthorizerResult {
  return {
    principalId: context?.cognito_sub ?? "anonymous",
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        { Action: "execute-api:Invoke", Effect: effect, Resource: methodArn },
      ],
    },
    ...(context ? { context } : {}),
  };
}

export async function handler(
  event: APIGatewayRequestAuthorizerEvent,
): Promise<APIGatewayAuthorizerResult> {
  const token = event.queryStringParameters?.token;

  if (!token) {
    // Never log the token itself, present or not — see the logging convention.
    logger.warn({ app_event: "ws_connect_denied", reason: "missing_token" });
    return policy("Deny", event.methodArn);
  }

  try {
    const { sub } = await verifyCognitoToken(token);
    logger.info({ app_event: "ws_connect_authorized", cognito_sub: sub });
    return policy("Allow", event.methodArn, { cognito_sub: sub });
  } catch {
    // Deliberately does not distinguish expired / malformed / wrong-audience:
    // the client learns only that the handshake failed.
    logger.warn({ app_event: "ws_connect_denied", reason: "invalid_token" });
    return policy("Deny", event.methodArn);
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `nvm use && cd functions/realtime-events && pnpm vitest run tests/authorizer.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Write the failing connect/disconnect tests**

```typescript
// functions/realtime-events/tests/connect.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const saveConnection = vi.fn();
vi.mock("../src/shared/connections-repository.js", () => ({ saveConnection }));

describe("$connect handler", () => {
  beforeEach(() => {
    saveConnection.mockReset();
    saveConnection.mockResolvedValue(undefined);
  });

  it("persists the connection using the authorizer's cognito_sub", async () => {
    const { handler } = await import("../src/connect.js");
    const res = await handler({
      requestContext: {
        connectionId: "conn-1",
        authorizer: { cognito_sub: "sub-1" },
      },
    } as never);
    expect(saveConnection).toHaveBeenCalledWith("conn-1", "sub-1");
    expect(res.statusCode).toBe(200);
  });

  it("returns 500 without persisting when the authorizer context is missing", async () => {
    const { handler } = await import("../src/connect.js");
    const res = await handler({
      requestContext: { connectionId: "conn-1", authorizer: {} },
    } as never);
    expect(saveConnection).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
  });
});
```

```typescript
// functions/realtime-events/tests/disconnect.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const deleteConnection = vi.fn();
vi.mock("../src/shared/connections-repository.js", () => ({ deleteConnection }));

describe("$disconnect handler", () => {
  beforeEach(() => {
    deleteConnection.mockReset();
    deleteConnection.mockResolvedValue(undefined);
  });

  it("deletes the row for the closing connection", async () => {
    const { handler } = await import("../src/disconnect.js");
    const res = await handler({
      requestContext: { connectionId: "conn-1" },
    } as never);
    expect(deleteConnection).toHaveBeenCalledWith("conn-1");
    expect(res.statusCode).toBe(200);
  });

  it("still returns 200 when the delete fails", async () => {
    deleteConnection.mockRejectedValue(new Error("boom"));
    const { handler } = await import("../src/disconnect.js");
    const res = await handler({
      requestContext: { connectionId: "conn-1" },
    } as never);
    expect(res.statusCode).toBe(200);
  });
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `nvm use && cd functions/realtime-events && pnpm vitest run tests/connect.test.ts tests/disconnect.test.ts`
Expected: FAIL — cannot resolve the modules.

- [ ] **Step 7: Write the three remaining entrypoints**

```typescript
// src/connect.ts
import type { APIGatewayProxyResult } from "aws-lambda";
import { saveConnection } from "#shared/connections-repository";
import { logger } from "#shared/logging/logger";

interface ConnectEvent {
  requestContext: {
    connectionId: string;
    authorizer?: Record<string, string>;
  };
}

export async function handler(event: ConnectEvent): Promise<APIGatewayProxyResult> {
  const connectionId = event.requestContext.connectionId;
  // From the authorizer's returned context — verified on Floci to propagate
  // intact. NEVER read the token from the query string here: this handler does
  // not validate anything, so trusting a request value would let an unverified
  // caller choose whose events they receive.
  const cognitoSub = event.requestContext.authorizer?.cognito_sub;

  if (!cognitoSub) {
    // Should be unreachable: the route is behind the authorizer, so a missing
    // context means a wiring fault. Fail loudly rather than persisting a row
    // with no owner, which would be invisible until it silently received
    // nothing.
    logger.error({
      app_event: "ws_connect_failed",
      reason: "missing_authorizer_context",
      connection_id: connectionId,
    });
    return { statusCode: 500, body: "missing authorizer context" };
  }

  await saveConnection(connectionId, cognitoSub);
  logger.info({
    app_event: "ws_connected",
    connection_id: connectionId,
    cognito_sub: cognitoSub,
  });
  return { statusCode: 200, body: "connected" };
}
```

```typescript
// src/disconnect.ts
import type { APIGatewayProxyResult } from "aws-lambda";
import { deleteConnection } from "#shared/connections-repository";
import { logger } from "#shared/logging/logger";

interface DisconnectEvent {
  requestContext: { connectionId: string };
}

export async function handler(
  event: DisconnectEvent,
): Promise<APIGatewayProxyResult> {
  const connectionId = event.requestContext.connectionId;
  try {
    await deleteConnection(connectionId);
    logger.info({ app_event: "ws_disconnected", connection_id: connectionId });
  } catch (error) {
    // Swallowed: the socket is already gone, so there is nothing to fail back
    // to. A row left behind is harmless — the events-pipeline prunes it on the
    // next 410 Gone, and the TTL bounds it regardless.
    logger.error({
      app_event: "ws_disconnect_cleanup_failed",
      connection_id: connectionId,
      reason: error instanceof Error ? error.message : "unknown",
    });
  }
  return { statusCode: 200, body: "disconnected" };
}
```

```typescript
// src/default.ts
import type { APIGatewayProxyResult } from "aws-lambda";
import { logger } from "#shared/logging/logger";

interface DefaultEvent {
  requestContext: { connectionId: string };
}

/**
 * $default — the channel is server-to-client only.
 *
 * Declared rather than omitted deliberately: with no $default route an inbound
 * message vanishes silently, so a client that wrongly believes it can subscribe
 * gets no signal at all. This route mutates no connection state; it only tells
 * the caller its message went nowhere.
 */
export async function handler(
  event: DefaultEvent,
): Promise<APIGatewayProxyResult> {
  logger.warn({
    app_event: "ws_unexpected_inbound_message",
    connection_id: event.requestContext.connectionId,
  });
  return {
    statusCode: 400,
    body: JSON.stringify({
      error: "this channel is server-to-client only; inbound messages are ignored",
    }),
  };
}
```

- [ ] **Step 8: Write the logger**

```typescript
// src/shared/logging/logger.ts
import pino from "pino";

// Matches the events-pipeline's logger so both packages emit the same shape.
// Never log a token, a plaintext email, or a full payload — see the
// logging-context convention.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "realtime-events" },
});
```

- [ ] **Step 9: Run the full suite**

Run: `nvm use && cd functions/realtime-events && pnpm vitest run && pnpm run typecheck && pnpm run build`
Expected: all tests pass, typecheck clean, and `dist/authorizer.js`, `dist/connect.js`, `dist/disconnect.js`, `dist/default.js` all exist.

- [ ] **Step 10: Verify the bundles are really CommonJS**

Run: `head -5 functions/realtime-events/dist/connect.js`
Expected: CommonJS output (`"use strict"`, `require(...)`, `exports.` assignments) — **not** `import`/`export` statements. If you see ESM syntax the `format: "cjs"` setting was lost and the function will fail at runtime under `nodejs20.x`.

- [ ] **Step 11: Commit**

```bash
git add functions/realtime-events/
git commit -m "feat(events-pipeline): add websocket connect, disconnect, default and authorizer handlers"
```

---

## Task 5: WebSocket API Gateway Terraform module

**Files:**
- Create: `infra/modules/api-gateway-ws/main.tf`, `variables.tf`, `outputs.tf`

**Interfaces:**
- Consumes: `table_name`/`table_arn` from Task 1; the built `dist/` from Task 4.
- Produces: outputs `api_id`, `stage_name`, `ws_url` (the `ws://localhost:4566/ws/...` local form), `management_endpoint` (the `/execute-api/` form).

- [ ] **Step 1: Write `variables.tf`**

```hcl
# Same shape as every other module here — a resolved context, not the label
# module's inputs. See infra/modules/docdb/variables.tf.
variable "context" {
  description = "Label context object from the label module (must expose .id and .tags)."
  type = object({
    id   = string
    tags = map(string)
  })
}

variable "source_dir" {
  description = "Directory holding the built CJS bundles (functions/realtime-events/dist)."
  type        = string
}

variable "stage_name" {
  description = "WebSocket API stage name."
  type        = string
  default     = "dev"
}

variable "connections_table_name" {
  description = "DynamoDB connections table name."
  type        = string
}

variable "connections_table_arn" {
  description = "DynamoDB connections table ARN, for the handlers' IAM policy."
  type        = string
}

variable "cognito_user_pool_id" {
  description = "Cognito user pool the authorizer validates tokens against."
  type        = string
}

variable "cognito_client_id" {
  description = "Cognito app client id the authorizer validates the audience against."
  type        = string
}

variable "aws_endpoint_url" {
  description = "Local emulator endpoint for the AWS SDK inside the Lambdas. Empty in production so the SDK resolves the real endpoint."
  type        = string
  default     = ""
}

variable "log_retention_in_days" {
  description = "CloudWatch log retention for the four functions."
  type        = number
  default     = 7
}
```

- [ ] **Step 2: Write `main.tf`**

```hcl
locals {
  base_name = "${var.context.id}-ws"

  # One entry per entrypoint. `route_key` is null for the authorizer, which is
  # not a route.
  functions = {
    authorizer = { route_key = null }
    connect    = { route_key = "$connect" }
    disconnect = { route_key = "$disconnect" }
    default    = { route_key = "$default" }
  }
}

resource "aws_apigatewayv2_api" "this" {
  name                       = local.base_name
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.action"
  tags                       = var.context.tags
}

# One zip per entrypoint: archive_file zips the FILE, so each function gets a
# bare handler .js at the zip root with no package.json beside it — which is
# what makes the nodejs20.x runtime treat it as CommonJS. See the bundling
# constraint in the plan header.
data "archive_file" "fn" {
  for_each    = local.functions
  type        = "zip"
  source_file = "${var.source_dir}/${each.key}.js"
  output_path = "${var.source_dir}/${each.key}.zip"
}

resource "aws_iam_role" "lambda" {
  name = "${local.base_name}-lambda"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
  tags = var.context.tags
}

resource "aws_iam_role_policy" "lambda" {
  name = "${local.base_name}-lambda"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:PutItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
        ]
        Resource = [var.connections_table_arn, "${var.connections_table_arn}/index/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "*"
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "fn" {
  for_each          = local.functions
  name              = "/aws/lambda/${local.base_name}-${each.key}"
  retention_in_days = var.log_retention_in_days
  tags              = var.context.tags
}

resource "aws_lambda_function" "fn" {
  for_each = local.functions

  function_name    = "${local.base_name}-${each.key}"
  role             = aws_iam_role.lambda.arn
  handler          = "${each.key}.handler"
  runtime          = "nodejs20.x"
  filename         = data.archive_file.fn[each.key].output_path
  source_code_hash = data.archive_file.fn[each.key].output_base64sha256
  timeout          = 10

  environment {
    variables = {
      COGNITO_USER_POOL_ID  = var.cognito_user_pool_id
      COGNITO_CLIENT_ID     = var.cognito_client_id
      WS_CONNECTIONS_TABLE  = var.connections_table_name
      WS_CONNECTIONS_GSI    = "by-cognito-sub"
      AWS_ENDPOINT_URL      = var.aws_endpoint_url
    }
  }

  depends_on = [aws_cloudwatch_log_group.fn]
  tags       = var.context.tags
}

resource "aws_lambda_permission" "apigw" {
  for_each = local.functions

  statement_id  = "AllowExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn[each.key].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}

resource "aws_apigatewayv2_authorizer" "request" {
  api_id                     = aws_apigatewayv2_api.this.id
  name                       = "${local.base_name}-authorizer"
  authorizer_type            = "REQUEST"
  # The token rides in the query string: a browser cannot set headers on a
  # WebSocket handshake, and a POC confirmed no Authorization header reaches
  # the authorizer at all.
  identity_sources           = ["route.request.querystring.token"]
  authorizer_uri             = aws_lambda_function.fn["authorizer"].invoke_arn
  authorizer_payload_format_version = "1.0"
}

resource "aws_apigatewayv2_integration" "fn" {
  for_each = { for k, v in local.functions : k => v if v.route_key != null }

  api_id                    = aws_apigatewayv2_api.this.id
  integration_type          = "AWS_PROXY"
  integration_uri           = aws_lambda_function.fn[each.key].invoke_arn
  content_handling_strategy = "CONVERT_TO_TEXT"
}

resource "aws_apigatewayv2_route" "fn" {
  for_each = { for k, v in local.functions : k => v if v.route_key != null }

  api_id    = aws_apigatewayv2_api.this.id
  route_key = each.value.route_key
  target    = "integrations/${aws_apigatewayv2_integration.fn[each.key].id}"

  # Only $connect is authorized — $disconnect and $default run on an
  # already-authorized connection, and API Gateway rejects an authorizer on
  # either of them.
  authorization_type = each.value.route_key == "$connect" ? "CUSTOM" : "NONE"
  authorizer_id      = each.value.route_key == "$connect" ? aws_apigatewayv2_authorizer.request.id : null
}

resource "aws_apigatewayv2_stage" "this" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = var.stage_name
  auto_deploy = true
  tags        = var.context.tags
}
```

- [ ] **Step 3: Write `outputs.tf`**

```hcl
output "api_id" {
  description = "WebSocket API id."
  value       = aws_apigatewayv2_api.this.id
}

output "stage_name" {
  description = "WebSocket API stage name."
  value       = aws_apigatewayv2_stage.this.name
}

# Floci serves the data plane at /ws/{apiId}/{stage} — NOT the
# restapis/<id>/$default/_user_request_/ shape the HTTP API uses. Verified by
# POC on 2026-08-05.
output "ws_url_local" {
  description = "Local (Floci) WebSocket URL clients connect to."
  value       = "ws://localhost:4566/ws/${aws_apigatewayv2_api.this.id}/${aws_apigatewayv2_stage.this.name}"
}

# The @connections management endpoint on Floci carries an UNDOCUMENTED
# /execute-api/ prefix and differs from real AWS
# (https://{apiId}.execute-api.{region}.amazonaws.com/{stage}). Wrong shapes
# return HTTP 400 with an S3 XML body, because unrouted :4566 paths fall
# through to Floci's S3 handler. Verified by POC on 2026-08-05.
output "management_endpoint_local" {
  description = "Local (Floci) @connections management endpoint for the events-pipeline."
  value       = "http://floci:4566/execute-api/${aws_apigatewayv2_api.this.id}/${aws_apigatewayv2_stage.this.name}"
}
```

- [ ] **Step 4: Validate**

Run: `terraform -chdir=infra/modules/api-gateway-ws init -backend=false && terraform -chdir=infra/modules/api-gateway-ws validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 5: Commit**

```bash
git add infra/modules/api-gateway-ws/
git commit -m "feat(infra): add websocket api gateway module with request authorizer"
```

---

## Task 6: Pipeline-side WebSocket publisher

**Files:**
- Create: `functions/events-pipeline/src/shared/realtime/connections-reader.ts`, `src/shared/realtime/websocket-publisher.ts`
- Modify: `functions/events-pipeline/package.json` (add two deps), `src/shared/config/env.ts`
- Test: `functions/events-pipeline/tests/websocket-publisher.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks at compile time (the table is reached by name via env).
- Produces: `publishToUser(cognitoSub: string, message: unknown): Promise<void>` — never throws.

- [ ] **Step 0: Confirm the logger symbol before writing any import**

Run: `grep -rn "export const appLogger" functions/events-pipeline/src/shared/logging/app-logger.ts`
Expected: a match. The code below imports `appLogger` from `#shared/logging/app-logger` — **not** a `logger` export from `#shared/logging/logger`, which exports only `buildLoggerOptions` and `SEVERITY_NUMBER`. If this grep misses, find the current symbol with `grep -rn "^import.*logging" functions/events-pipeline/src/handler.ts` and use whatever that file imports.

- [ ] **Step 1: Add the dependencies**

```bash
nvm use && cd functions/events-pipeline && pnpm add @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb @aws-sdk/client-apigatewaymanagementapi
```

- [ ] **Step 2: Write the failing test**

```typescript
// functions/events-pipeline/tests/websocket-publisher.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const queryByCognitoSub = vi.fn();
const deleteConnection = vi.fn();
vi.mock("../src/shared/realtime/connections-reader.js", () => ({
  queryByCognitoSub,
  deleteConnection,
}));

const postSend = vi.fn();
vi.mock("@aws-sdk/client-apigatewaymanagementapi", () => ({
  ApiGatewayManagementApiClient: class {
    send = postSend;
  },
  PostToConnectionCommand: class {
    constructor(public input: unknown) {}
  },
}));

function goneError() {
  const e = new Error("gone") as Error & {
    $metadata: { httpStatusCode: number };
    name: string;
  };
  e.name = "GoneException";
  e.$metadata = { httpStatusCode: 410 };
  return e;
}

describe("publishToUser", () => {
  beforeEach(() => {
    queryByCognitoSub.mockReset();
    deleteConnection.mockReset();
    postSend.mockReset();
    postSend.mockResolvedValue({});
    process.env.WS_MANAGEMENT_ENDPOINT = "http://floci:4566/execute-api/abc/dev";
    process.env.WS_CONNECTIONS_TABLE = "conns";
  });

  it("posts to every connection the user has open", async () => {
    queryByCognitoSub.mockResolvedValue(["conn-1", "conn-2"]);
    const { publishToUser } = await import(
      "../src/shared/realtime/websocket-publisher.js"
    );
    await publishToUser("sub-1", { hello: "world" });
    expect(postSend).toHaveBeenCalledTimes(2);
    expect(deleteConnection).not.toHaveBeenCalled();
  });

  it("deletes only the dead connection on 410 and still posts to the rest", async () => {
    queryByCognitoSub.mockResolvedValue(["dead", "alive"]);
    postSend.mockImplementation((cmd: { input: { ConnectionId: string } }) =>
      cmd.input.ConnectionId === "dead"
        ? Promise.reject(goneError())
        : Promise.resolve({}),
    );
    const { publishToUser } = await import(
      "../src/shared/realtime/websocket-publisher.js"
    );
    await publishToUser("sub-1", { hello: "world" });
    expect(deleteConnection).toHaveBeenCalledTimes(1);
    expect(deleteConnection).toHaveBeenCalledWith("dead");
  });

  it("never throws when the query itself fails", async () => {
    queryByCognitoSub.mockRejectedValue(new Error("dynamo down"));
    const { publishToUser } = await import(
      "../src/shared/realtime/websocket-publisher.js"
    );
    await expect(publishToUser("sub-1", {})).resolves.toBeUndefined();
  });

  it("does nothing when the user has no open connections", async () => {
    queryByCognitoSub.mockResolvedValue([]);
    const { publishToUser } = await import(
      "../src/shared/realtime/websocket-publisher.js"
    );
    await publishToUser("sub-1", {});
    expect(postSend).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `nvm use && cd functions/events-pipeline && pnpm vitest run tests/websocket-publisher.test.ts`
Expected: FAIL — cannot resolve the modules.

- [ ] **Step 4: Write `connections-reader.ts`**

```typescript
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";

let docClient: DynamoDBDocumentClient | null = null;

function client(): DynamoDBDocumentClient {
  if (docClient === null) {
    docClient = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        region: process.env.AWS_REGION ?? "us-east-1",
        ...(process.env.AWS_ENDPOINT_URL
          ? { endpoint: process.env.AWS_ENDPOINT_URL }
          : {}),
      }),
    );
  }
  return docClient;
}

/**
 * Every open connection for one user.
 *
 * Queries the `by-cognito-sub` GSI. The argument MUST be a Cognito `sub` — the
 * envelope's `user_id` is the internal `usr_` id and querying with it returns
 * an empty list with no error whatsoever, which reads exactly like "user has no
 * connections". See the user-id-vs-cognito-sub-ownership-key ADR.
 */
export async function queryByCognitoSub(cognitoSub: string): Promise<string[]> {
  const result = await client().send(
    new QueryCommand({
      TableName: process.env.WS_CONNECTIONS_TABLE,
      IndexName: process.env.WS_CONNECTIONS_GSI ?? "by-cognito-sub",
      KeyConditionExpression: "cognito_sub = :s",
      ExpressionAttributeValues: { ":s": cognitoSub },
      ProjectionExpression: "connection_id",
    }),
  );
  return (result.Items ?? []).map((item) => String(item.connection_id));
}

export async function deleteConnection(connectionId: string): Promise<void> {
  await client().send(
    new DeleteCommand({
      TableName: process.env.WS_CONNECTIONS_TABLE,
      Key: { connection_id: connectionId },
    }),
  );
}
```

- [ ] **Step 5: Write `websocket-publisher.ts`**

```typescript
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { queryByCognitoSub, deleteConnection } from "#shared/realtime/connections-reader";
// `appLogger`, NOT a `logger` export from #shared/logging/logger — that module
// exports `buildLoggerOptions`/`SEVERITY_NUMBER` only. `app-logger` is what
// every other module in this package imports (see handler.ts,
// pipeline/process-record.ts).
import { appLogger } from "#shared/logging/app-logger";

let apiClient: ApiGatewayManagementApiClient | null = null;

function client(): ApiGatewayManagementApiClient {
  if (apiClient === null) {
    // Locally this is Floci's UNDOCUMENTED /execute-api/{apiId}/{stage} shape,
    // not the real-AWS https://{apiId}.execute-api.{region}.amazonaws.com/{stage}.
    // Generated into the env file, never hardcoded. A wrong endpoint answers
    // HTTP 400 with an S3 XML body (unrouted :4566 paths hit Floci's S3
    // handler), which looks nothing like an endpoint problem.
    apiClient = new ApiGatewayManagementApiClient({
      region: process.env.AWS_REGION ?? "us-east-1",
      endpoint: process.env.WS_MANAGEMENT_ENDPOINT,
    });
  }
  return apiClient;
}

function isGone(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === "GoneException" || e.$metadata?.httpStatusCode === 410;
}

/**
 * Fan a message out to every socket the user has open. NEVER throws.
 *
 * The WebSocket push must never change the outcome of event processing: the
 * email is the durable notification and this is an opportunistic enhancement on
 * top of it. Failing the event so SQS retries it would send a SECOND email for
 * a transition the user was already notified about — trading a realtime failure
 * for a duplicate email, which is the trade the pipeline's publish-failure
 * policy already rejects everywhere else.
 */
export async function publishToUser(
  cognitoSub: string,
  message: unknown,
): Promise<void> {
  try {
    const connectionIds = await queryByCognitoSub(cognitoSub);
    if (connectionIds.length === 0) {
      // Normal, not an error: the user simply has nothing open right now.
      return;
    }

    const data = Buffer.from(JSON.stringify(message));

    await Promise.all(
      connectionIds.map(async (connectionId) => {
        try {
          await client().send(
            new PostToConnectionCommand({ ConnectionId: connectionId, Data: data }),
          );
        } catch (error) {
          if (isGone(error)) {
            // The reactive cleanup the whole design leans on — the TTL is only
            // a backstop. A dead connection is expected, not a failure.
            await deleteConnection(connectionId).catch(() => undefined);
            return;
          }
          appLogger.error({
            app_event: "ws_push_failed",
            connection_id: connectionId,
            reason: error instanceof Error ? error.message : "unknown",
          });
        }
      }),
    );
  } catch (error) {
    appLogger.error({
      app_event: "ws_fanout_failed",
      reason: error instanceof Error ? error.message : "unknown",
    });
  }
}
```

- [ ] **Step 6: Add the `#shared/realtime/*` subpath to `package.json`**

Add to the `imports` map, matching the existing entries' shape:

```json
"#shared/realtime/*": {
  "types": "./src/shared/realtime/*.ts",
  "development": "./src/shared/realtime/*.ts",
  "default": "./dist/shared/realtime/*.js"
}
```

Note: the existing `#shared/*` entry already covers this path, so add this only if the build fails to resolve it — check first rather than adding a redundant entry.

- [ ] **Step 7: Run the tests**

Run: `nvm use && cd functions/events-pipeline && pnpm vitest run tests/websocket-publisher.test.ts`
Expected: 4 passed.

- [ ] **Step 8: Commit**

```bash
git add functions/events-pipeline/
git commit -m "feat(events-pipeline): add websocket fan-out publisher with 410-gone cleanup"
```

---

## Task 7: Wire the fan-out into the `TRACKING_STATUS_CHANGED` handler

**Files:**
- Modify: `functions/events-pipeline/src/handlers/tracking-status-changed.ts`
- Test: `functions/events-pipeline/tests/handlers/tracking-status-changed.test.ts` (extend the existing file)

**Interfaces:**
- Consumes: `publishToUser` (Task 6); `envelope.author.cognito_sub` (populated by Task 8).

- [ ] **Step 1: Read the existing handler and its test in full**

Read `functions/events-pipeline/src/handlers/tracking-status-changed.ts` and its existing test. Note the current flow: validate payload → pick template → render → `sendEmail`.

**Also note:** the long comment block at the top of that file claims Tracking "has no publisher at all for TRACKING_STATUS_CHANGED" and that Tracking does not resolve the user's email. **Both claims are stale** — `_emit_status_changed` exists in `services/tracking/src/features/tracking/commands/update_status.py` and `SqsEventPublisher._resolve_email` already resolves the email over gRPC. Delete the obsolete paragraphs as part of this task; leaving them would send the next reader to build something that already exists.

- [ ] **Step 2: Write the failing test**

```typescript
// add to functions/events-pipeline/tests/handlers/tracking-status-changed.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const publishToUser = vi.fn();
vi.mock("../../src/shared/realtime/websocket-publisher.js", () => ({
  publishToUser,
}));

const VALID_ENVELOPE = {
  event_id: "evt-1",
  type: "TRACKING_STATUS_CHANGED",
  source: "tracking",
  user_id: "usr_abc",
  order_id: "ord_xyz",
  author: { actor: "tracking_api:carrier_status_update", cognito_sub: "sub-1" },
  payload: {
    status: "DELIVERED",
    previous_status: "OUT_FOR_DELIVERY",
    changed_at: "2026-08-05T00:00:00Z",
    email: "user@example.com",
  },
};

describe("trackingStatusChangedHandler realtime fan-out", () => {
  beforeEach(() => publishToUser.mockReset());

  it("pushes to the websocket using author.cognito_sub, not user_id", async () => {
    const { trackingStatusChangedHandler } = await import(
      "../../src/handlers/tracking-status-changed.js"
    );
    await trackingStatusChangedHandler(VALID_ENVELOPE as never);

    expect(publishToUser).toHaveBeenCalledTimes(1);
    const [sub, message] = publishToUser.mock.calls[0];
    // The internal usr_ id would silently match nothing on the GSI.
    expect(sub).toBe("sub-1");
    expect(sub).not.toBe("usr_abc");
    expect(message).toMatchObject({
      type: "TRACKING_STATUS_CHANGED",
      order_id: "ord_xyz",
      status: "DELIVERED",
    });
  });

  it("skips the push when author.cognito_sub is absent, without failing", async () => {
    const withoutSub = {
      ...VALID_ENVELOPE,
      author: { actor: "tracking_api:carrier_status_update" },
    };
    const { trackingStatusChangedHandler } = await import(
      "../../src/handlers/tracking-status-changed.js"
    );
    await expect(
      trackingStatusChangedHandler(withoutSub as never),
    ).resolves.toBeUndefined();
    expect(publishToUser).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `nvm use && cd functions/events-pipeline && pnpm vitest run tests/handlers/tracking-status-changed.test.ts`
Expected: FAIL — `publishToUser` not called.

- [ ] **Step 4: Add the fan-out to the handler**

Append this after the existing `await sendEmail({...})` call:

```typescript
  // Realtime fan-out, AFTER the email. Secondary to it in every sense: the
  // email is the durable notification, this is opportunistic, and
  // `publishToUser` never throws — a push failure must not fail the event and
  // trigger an SQS retry that would send a duplicate email.
  //
  // Keyed by `author.cognito_sub`, NOT `envelope.user_id`. The latter is the
  // internal usr_ id; the connections GSI is keyed by the Cognito sub, so
  // querying with user_id returns an empty list indistinguishable from "no open
  // connections". See the user-id-vs-cognito-sub-ownership-key ADR.
  const cognitoSub = envelope.author.cognito_sub;
  if (cognitoSub) {
    await publishToUser(cognitoSub, {
      type: "TRACKING_STATUS_CHANGED",
      order_id: envelope.order_id,
      status: result.data.status,
      previous_status: result.data.previous_status,
      changed_at: result.data.changed_at,
    });
  }
```

Add the import at the top:

```typescript
import { publishToUser } from "#shared/realtime/websocket-publisher";
```

Note the deliberate omission: the pushed message carries **no email address**. It goes to an authenticated socket that already belongs to that user, so including PII would add exposure with no benefit.

- [ ] **Step 5: Run the tests**

Run: `nvm use && cd functions/events-pipeline && pnpm vitest run && pnpm run typecheck`
Expected: all pass, including the pre-existing tests in that file.

- [ ] **Step 6: Commit**

```bash
git add functions/events-pipeline/src/handlers/tracking-status-changed.ts functions/events-pipeline/tests/
git commit -m "feat(events-pipeline): fan out tracking status changes to websocket clients"
```

---

## Task 8: Tracking publishes `author.cognito_sub`

**Files:**
- Modify: `services/tracking/src/shared/messaging/event_publisher.py` (the port), `src/shared/messaging/sqs_event_publisher.py`, `src/features/tracking/commands/update_status.py`
- Test: extend the existing tests for `update_status` and the publisher

**Interfaces:**
- Produces: `publish_tracking_status_changed(..., cognito_sub: str | None)` — one new keyword-only parameter; sets `author.cognito_sub` on the envelope only when non-empty.

- [ ] **Step 1: Read the three files in full**

Read `event_publisher.py` (the abstract port), `sqs_event_publisher.py` (note `_resolve_email` and how the envelope's `author` is built), and `update_status.py` (note `_emit_status_changed`'s existing keyword arguments).

Confirm before editing: `Tracking.cognito_sub` is **nullable** (`models.py:95`). Rows created before that column existed, or by a caller that omitted it, hold `None` — the code must not assume a value.

- [ ] **Step 2: Write the failing test**

```python
# services/tracking/tests/.../test_update_status.py  (extend the existing file)
def test_emits_cognito_sub_from_the_persisted_row(session, fake_publisher):
    """The envelope's author.cognito_sub comes off the tracking entity.

    The carrier webhook carries no x-user-id at all — it is authenticated by an
    API key, not a Cognito JWT — so the persisted row is the only source.
    """
    tracking = make_tracking(
        session, order_id="ord_1", status="PROCESSING", cognito_sub="sub-abc"
    )

    update_tracking_status(
        session,
        UpdateStatusCommand(order_id="ord_1", status="SHIPPED"),
        actor=AuditActor.TRACKING_CARRIER,
        publisher=fake_publisher,
    )

    assert fake_publisher.calls[0]["cognito_sub"] == "sub-abc"


def test_emits_none_when_the_row_has_no_cognito_sub(session, fake_publisher):
    """A legacy row with a NULL cognito_sub still publishes — it just cannot be
    routed to a websocket. The email path is unaffected."""
    make_tracking(session, order_id="ord_2", status="PROCESSING", cognito_sub=None)

    update_tracking_status(
        session,
        UpdateStatusCommand(order_id="ord_2", status="SHIPPED"),
        actor=AuditActor.TRACKING_CARRIER,
        publisher=fake_publisher,
    )

    assert fake_publisher.calls[0]["cognito_sub"] is None
```

Adapt the fixtures/helpers to whatever the existing test file already uses — read it first rather than inventing new ones.

- [ ] **Step 3: Run it to verify it fails**

Run: `cd services/tracking && python -m pytest tests -k cognito_sub -v`
Expected: FAIL — `cognito_sub` is not a recognized key.

- [ ] **Step 4: Widen the port**

In `event_publisher.py`, add the keyword-only parameter to the abstract method signature, with a docstring line:

```python
        cognito_sub: str | None,
```

```
`cognito_sub` is the tracking row's persisted Cognito subject, or None for a
legacy row that predates the column. It becomes the envelope's optional
`author.cognito_sub`, which the events-pipeline uses to route the realtime
WebSocket push. Omitted (never null) from the envelope when None — the
envelope's AuthorSchema declares the field optional, so writing an explicit
null would fail validation downstream.
```

Update `NoopEventPublisher` (and any other implementation) to accept it.

- [ ] **Step 5: Set it on the envelope in `sqs_event_publisher.py`**

Where the `author` dict is built, add:

```python
        author: dict[str, str] = {"actor": actor.value}
        if cognito_sub:
            # Omitted, never null: the pipeline's AuthorSchema declares this
            # optional, and an explicit null fails Zod validation — which would
            # turn a routable event into a PermanentError.
            author["cognito_sub"] = cognito_sub
```

Adapt to however that dict is currently constructed — read the surrounding code and match it rather than pasting blindly.

- [ ] **Step 6: Pass it from `update_status.py`**

In the `_emit_status_changed(...)` call, add:

```python
        # Off the PERSISTED entity, same as user_id above — the carrier webhook
        # has no x-user-id to read. Nullable column, so this may be None; the
        # publisher omits the field in that case.
        cognito_sub=updated.cognito_sub,
```

And add the matching parameter to `_emit_status_changed`'s signature, threading it into the `publisher.publish_tracking_status_changed(...)` call.

- [ ] **Step 7: Run the tests**

Run: `cd services/tracking && python -m pytest tests -v`
Expected: all pass, including the two new ones and every pre-existing test.

- [ ] **Step 8: Commit**

```bash
git add services/tracking/
git commit -m "feat(tracking): carry author.cognito_sub on TRACKING_STATUS_CHANGED for realtime routing"
```

---

## Task 9: Wire the modules into the local environment

**Files:**
- Modify: `infra/environments/local/main.tf`, `outputs.tf`
- Modify: the env-file generator and `.env.example`

**Interfaces:**
- Consumes: Tasks 1 and 5's modules.
- Produces: `WS_CONNECTIONS_TABLE`, `WS_CONNECTIONS_GSI`, `WS_MANAGEMENT_ENDPOINT` in `.env.local.events`; `WS_URL` in `.env.local.debug` for the E2E harness.

- [ ] **Step 1: Read how an existing module is wired**

Read the `module "docdb"` and `module "lambda"` blocks in `infra/environments/local/main.tf`, plus how their outputs reach the env files. Match that pattern.

- [ ] **Step 2: Add both modules to `main.tf`**

First add a `label` instance for this component, following the file's existing
`module "label_<component>"` convention (see `label_events`, `label_cognito`):

```hcl
module "label_realtime" {
  source      = "../../modules/label"
  namespace   = "3mrai"
  environment = var.environment
  name        = "realtime"
}
```

(Exactly the shape of `module "label_events"` at `main.tf:39` — literal
`"3mrai"` namespace, no `stage`.)

Then wire both modules. Note the context shape — an inline `{ id, tags }`
object, **not** `module.label.context`; `main.tf`'s own header comment (line 8)
calls this out explicitly:

```hcl
module "ws_connections" {
  source  = "../../modules/dynamodb"
  context = { id = module.label_realtime.id, tags = module.label_realtime.tags }
}

module "api_gateway_ws" {
  source     = "../../modules/api-gateway-ws"
  context    = { id = module.label_realtime.id, tags = module.label_realtime.tags }
  source_dir = "${path.root}/../../../functions/realtime-events/dist"

  connections_table_name = module.ws_connections.table_name
  connections_table_arn  = module.ws_connections.table_arn

  # `client_id`, not `user_pool_client_id` — verified against
  # infra/modules/cognito/outputs.tf.
  cognito_user_pool_id = module.cognito.user_pool_id
  cognito_client_id    = module.cognito.client_id

  # In-network name: the Lambdas run as containers on the compose network, so
  # they reach the emulator as `floci`, not `localhost`.
  aws_endpoint_url = "http://floci:4566"
}
```

- [ ] **Step 3: Add the env vars to the events-pipeline Lambda's environment**

The events-pipeline Lambda needs three new variables to reach the table and the management API. Add to its `environment_variables` map in `main.tf`:

```hcl
    WS_CONNECTIONS_TABLE   = module.ws_connections.table_name
    WS_CONNECTIONS_GSI     = module.ws_connections.gsi_name
    WS_MANAGEMENT_ENDPOINT = module.api_gateway_ws.management_endpoint_local
```

Its IAM role also needs `dynamodb:Query` and `dynamodb:DeleteItem` on the table plus `execute-api:ManageConnections` — find where that role's policy is declared and extend it.

- [ ] **Step 4: Export the WebSocket URL for the E2E harness**

Add to `infra/environments/local/outputs.tf`:

```hcl
output "ws_url" {
  description = "WebSocket URL for E2E clients."
  value       = module.api_gateway_ws.ws_url_local
}
```

Then thread it into the generated `.env.local.debug` as `WS_URL`, following how other outputs reach that file.

- [ ] **Step 5: Document the new vars in `.env.example`**

Add, with comments, to the appropriate AUTO-GENERATED section:

```bash
# --- WebSocket realtime events (generated) ---
# Connections registry written by the $connect/$disconnect handlers and read
# by the events-pipeline fan-out.
WS_CONNECTIONS_TABLE=
WS_CONNECTIONS_GSI=by-cognito-sub
# Floci's @connections endpoint carries an UNDOCUMENTED /execute-api/ prefix
# and differs from real AWS. A wrong value answers HTTP 400 with an S3 XML
# body, not an obvious endpoint error.
WS_MANAGEMENT_ENDPOINT=
# ws://localhost:4566/ws/{apiId}/{stage} — NOT the restapis/.../_user_request_/
# shape the HTTP API uses.
WS_URL=
```

- [ ] **Step 6: Build the bundles, then rebuild the environment from scratch**

A second `terraform apply` against Floci fails, so this is a full rebuild:

```bash
nvm use
cd functions/realtime-events && pnpm install && pnpm run build && cd ../..
docker compose down
rm -rf data/floci
rm -f infra/environments/local/terraform.tfstate*
make bootstrap
```

Expected: bootstrap completes in one pass.

- [ ] **Step 7: Verify the resources exist**

```bash
aws --endpoint-url http://localhost:4566 dynamodb list-tables
aws --endpoint-url http://localhost:4566 apigatewayv2 get-apis --query "Items[?ProtocolType=='WEBSOCKET'].[ApiId,Name]"
```

Expected: the connections table is listed, and exactly one WEBSOCKET API exists.

- [ ] **Step 8: Commit**

```bash
git add infra/ .env.example
git commit -m "feat(infra): wire websocket api and connections table into the local environment"
```

---

## Task 10: Gateway E2E tests

**Files:**
- Create: `e2e/tests/realtime-tracking.spec.ts`
- Create: `e2e/support/ws-client.ts`

**Interfaces:**
- Consumes: `WS_URL` from Task 9; the existing E2E auth helpers.

- [ ] **Step 1: Read the existing E2E setup**

Read `e2e/support/` in full — particularly how a test obtains a real Cognito JWT and how `global-teardown.ts` cleans up. Reuse those helpers; do not write a second auth path.

- [ ] **Step 2: Write the WebSocket test client helper**

```typescript
// e2e/support/ws-client.ts
import WebSocket from "ws";

export interface CollectedSocket {
  messages: unknown[];
  close(): void;
  waitForCount(n: number, timeoutMs: number): Promise<void>;
}

/**
 * Open an authenticated socket and collect everything it receives.
 *
 * The token goes in the query string because a WebSocket handshake cannot
 * carry an Authorization header — see the design spec's decision 3.
 */
export async function openSocket(
  wsUrl: string,
  token: string,
): Promise<CollectedSocket> {
  const socket = new WebSocket(`${wsUrl}?token=${encodeURIComponent(token)}`);
  const messages: unknown[] = [];

  socket.on("message", (raw) => {
    try {
      messages.push(JSON.parse(raw.toString()));
    } catch {
      messages.push(raw.toString());
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });

  return {
    messages,
    close: () => socket.close(),
    async waitForCount(n, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (messages.length < n) {
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for ${n} messages; got ${messages.length}`,
          );
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    },
  };
}

/** Attempt a handshake and resolve with whether it succeeded. */
export async function tryOpen(wsUrl: string, token: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${wsUrl}?token=${encodeURIComponent(token)}`);
    socket.once("open", () => {
      socket.close();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}
```

- [ ] **Step 3: Write the E2E spec**

```typescript
// e2e/tests/realtime-tracking.spec.ts
import { test, expect } from "@playwright/test";
import { openSocket, tryOpen } from "../support/ws-client";

const WS_URL = process.env.WS_URL!;

test.describe("realtime tracking events over websocket", () => {
  test("delivers all four status transitions to the owner", async () => {
    const { token } = await loginAsNewUser();      // existing helper
    const socket = await openSocket(WS_URL, token);

    // x-test-mode drives the five-status progression (~40s total: PLACED at
    // creation, then four automatic advances), so every transition emits —
    // there is no suppression, DELIVERED included. PLACED is the creation
    // status, not a transition, so it never publishes.
    const orderId = await createOrder({ token, testMode: true });

    // 55s: the progression takes ~40s, with headroom for SQS + Lambda.
    await socket.waitForCount(4, 55_000);
    socket.close();

    // Assert the SET, not the sequence: the pipeline processes SQS records in
    // batches with no cross-record ordering guarantee, so demanding strict
    // order would be flaky independent of whether the feature works.
    const statuses = socket.messages.map((m: any) => m.status).sort();
    expect(statuses).toEqual(
      ["DELIVERED", "OUT_FOR_DELIVERY", "PROCESSING", "SHIPPED"].sort(),
    );
    for (const message of socket.messages as any[]) {
      expect(message.type).toBe("TRACKING_STATUS_CHANGED");
      expect(message.order_id).toBe(orderId);
    }
  });

  test("rejects an invalid token at the handshake", async () => {
    // Without this, a $connect that succeeded regardless of the token would
    // look identical to a working feature. This repo has a documented case of
    // an auth flow returning tokens with no challenge at all.
    expect(await tryOpen(WS_URL, "not-a-real-jwt")).toBe(false);
  });

  test("does not deliver one user's events to another user", async () => {
    const alice = await loginAsNewUser();
    const bob = await loginAsNewUser();

    const aliceSocket = await openSocket(WS_URL, alice.token);
    const bobSocket = await openSocket(WS_URL, bob.token);

    const orderId = await createOrder({ token: alice.token, testMode: true });

    await aliceSocket.waitForCount(4, 45_000);
    aliceSocket.close();
    bobSocket.close();

    // The only test that actually exercises the cognito_sub scoping.
    expect(bobSocket.messages).toHaveLength(0);
    expect(
      (aliceSocket.messages as any[]).every((m) => m.order_id === orderId),
    ).toBe(true);
  });
});
```

Replace `loginAsNewUser` and `createOrder` with the actual helper names found in Step 1.

- [ ] **Step 4: Add the `ws` dependency to the E2E package**

Run: `nvm use && cd e2e && pnpm add -D ws @types/ws`

- [ ] **Step 5: Run the E2E suite**

Run: `make e2e` (or the repo's documented E2E command — check the Makefile)
Expected: the three new tests pass, and every pre-existing E2E test still passes.

- [ ] **Step 6: Commit**

```bash
git add e2e/
git commit -m "test(events-pipeline): add gateway e2e coverage for realtime websocket events"
```

---

## Task 11: Propagate the design into the vault

**Files:**
- Modify: `docs/domains/events-pipeline/specs/events-pipeline-design.md`, `docs/domains/tracking/specs/tracking-service-design.md`, `docs/shared/conventions/testing.md`, `docs/infrastructure/specs/terraform-modules.md`
- Modify: `docs/plans/index.md`, `docs/00-overview/index.md`

**Interfaces:** none — documentation only.

> [!important] Route every one of these edits through the `obsidian-vault` agent
> It is the sole writer of `docs/`. Do not edit these files directly. The design spec declares
> these four notes in its `propagates-to:` frontmatter, and the propagation gate is why that key
> exists.

- [ ] **Step 1: Propagate to `events-pipeline-design.md`**

Add a section covering: the WebSocket fan-out as a second output of the `TRACKING_STATUS_CHANGED` handler; that it never changes event outcome; the connections table and its `by-cognito-sub` GSI; and the three new env vars. Link to the design spec.

- [ ] **Step 2: Propagate to `tracking-service-design.md`**

Update the Events section: the publisher now carries `author.cognito_sub` off the persisted row, why (realtime routing), and that it is `None` for a legacy row.

- [ ] **Step 3: Propagate to `testing.md`**

Record how the three-layer convention adapts to a WebSocket surface, and the two mandatory negative tests (invalid token rejected; cross-user isolation).

- [ ] **Step 4: Propagate to `terraform-modules.md`**

Add `api-gateway-ws` and `dynamodb` to the module inventory, including why `lambda/` was not reused.

- [ ] **Step 5: Index the plan and flip the spec's status**

Link this plan from `docs/plans/index.md`; ensure the design spec is linked from `docs/00-overview/index.md`. Change the design spec's `status:` from `active` to `accepted`, and this plan's from `draft` to `active`, bumping `updated:` on every note touched.

- [ ] **Step 6: Validate**

Run: `nvm use && node scripts/validate-vault.mjs`
Expected: `Vault validation passed`, with no broken wikilinks and no propagation debt introduced.

Also hand-check any anchor links added — the validator does **not** verify intra-note anchors or wikilink anchors.

- [ ] **Step 7: Commit**

```bash
git add docs/
git commit -m "docs(events-pipeline): propagate realtime websocket design into the vault"
```

---

## Verification checklist

Before proposing the PR, confirm each of these with a command, not from memory:

- [ ] `nvm use && cd functions/realtime-events && pnpm vitest run && pnpm run typecheck && pnpm run lint`
- [ ] `nvm use && cd functions/events-pipeline && pnpm vitest run && pnpm run typecheck && pnpm run lint`
- [ ] `cd services/tracking && python -m pytest tests -v` — including the pre-existing suite
- [ ] `terraform -chdir=infra/environments/local validate`
- [ ] A from-scratch `make bootstrap` completes in one pass
- [ ] `make e2e` — the three new tests plus every pre-existing one
- [ ] `head -5 functions/realtime-events/dist/connect.js` shows CommonJS, not ESM
- [ ] `nvm use && node scripts/validate-vault.mjs` passes

## Related

- [[2026-08-05-realtime-tracking-events-websocket-design]] — the design this plan implements, including the POC verification results.
- [[events-pipeline-design]] — the existing pipeline the fan-out extends.
- [[tracking-service-design]] — the producer, modified in Task 8.
- [[user-id-vs-cognito-sub-ownership-key]] — why the GSI is keyed by `cognito_sub`.
- [[env-files]] — the generated-env-file convention for the three new vars.
- [[logging-context]] — never log the token, the email, or the payload.
- [[testing]] — the three-layer convention Task 10 adapts.
- [[ADR-0017-floci-local]] — the local emulator whose quirks shape Tasks 5 and 9.
