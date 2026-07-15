---
title: "Orders Service Milestone"
type: plan
area: orders
status: draft
created: 2026-07-14
updated: 2026-07-14
tags: [type/plan, area/orders, status/draft]
related: ["[[2026-07-14-orders-service-milestone-design]]", "[[orders-service-design]]", "[[users-service-design]]", "[[soft-delete]]", "[[nano-id]]", "[[audit-fields]]", "[[db-naming]]", "[[cqrs]]", "[[versioning]]", "[[ADR-0003-grpc-inter-service]]", "[[ADR-0006-read-write-replicas]]", "[[ADR-0010-cognito-auth]]"]
---

# Orders Service Milestone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Orders microservice's first delivery — a live .NET Core 10 Minimal API backed by local MySQL that creates and reads orders — plus the Users gRPC server it depends on for identity resolution.

**Architecture:** Two subsystems joined by one dependency gate. **Phase A** wires a gRPC server into the existing Users (Node/Fastify) service exposing `GetUserById`, guarded by a shared `x-api-key`, over a shared `/proto/users.proto`. **Phase B/C** build Orders as a Clean Architecture .NET solution (Domain / Application / Infrastructure / Api / Tests) with EF Core on MySQL, storing money as integer cents (Stripe-style), enforcing ownership by query filter, and resolving the caller's identity on `POST` via the Users gRPC client. Orders' read endpoints are independent of the gate; only `POST /v1/orders` consumes it.

**Tech Stack:** Node.js 24.18.0, `@grpc/grpc-js`, `@grpc/proto-loader` (Users gRPC server); .NET Core 10 Minimal APIs, C#, EF Core (Pomelo MySQL provider), `Grpc.Tools` + `Grpc.Net.Client` (Orders gRPC client), xUnit + Testcontainers-MySQL (tests); MySQL via Floci locally.

## Global Constraints

- **Node version (Users tasks):** run `nvm use` before ANY node/pnpm/npx command — repo pins 24.18.0 via `.nvmrc`.
- **Language:** converse with the user in Spanish; write all code, comments, identifiers, and docs in English.
- **Money:** all monetary amounts stored as integer cents in `bigint` columns with the `_cents` suffix; mapped to `long` in C#; dollar values only via non-persisted computed properties (`cents / 100m`). Never `decimal`/`float` for stored money. API responses expose cents (integers).
- **Every write runs inside an EF Core transaction** — always, even single-table writes.
- **Soft delete only** — no physical `DELETE`; `deleted_at`/`deleted_by` only; computed `IsDeleted` = `deleted_at != null`. See [[soft-delete]].
- **Prefixed nano-ids** for all entity IDs: `prd_`, `ord_`, `odd_`. See [[nano-id]].
- **Audit fields** on every entity: `created_by`, `created_at`, `updated_by`, `updated_at`, `deleted_by`, `deleted_at`. See [[audit-fields]].
- **DB naming:** snake_case columns in MySQL ↔ PascalCase aliases in EF Core. See [[db-naming]].
- **API versioning:** all HTTP endpoints under `/v1`. See [[versioning]].
- **CQRS:** reads via read DbContext (read replica), writes via write DbContext (write replica); locally both point at the same MySQL. See [[cqrs]] and [[ADR-0006-read-write-replicas]].
- **gRPC auth:** shared symmetric key `GRPC_API_KEY`, sent in gRPC metadata under `x-api-key`, validated server-side by a constant-time comparison in an interceptor; mismatch → `UNAUTHENTICATED`.
- **Implementers write only source code.** Leave work in the working tree; the main session commits. The `git commit` steps below describe the intended commit boundary for the main session — an implementer subagent stops after the tests pass.

---

## Phase A — Users gRPC server (the dependency gate)

> This entire phase is a Users-service leftover, done in the Orders milestone. It MUST be merged before Orders Task C1 (the gRPC client + `POST /v1/orders`). Orders' read endpoints (Phase B) do not depend on it.

### Task A1: Shared proto contract

**Files:**
- Create: `proto/users.proto`

**Interfaces:**
- Produces: the `users.v1.Users` gRPC service with `GetUserById(GetUserByIdRequest) returns (UserResponse)`; messages `GetUserByIdRequest { string id }` and `UserResponse { string id; string email; string full_name; string cognito_sub }`. Consumed by Users (Task A3, server) and Orders (Task C1, client).

- [ ] **Step 1: Write the proto file**

```proto
syntax = "proto3";

package users.v1;

// Shared contract for the Users gRPC surface. Source of truth for both the
// Node server (services/users) and the .NET client (services/orders).
service Users {
  // Resolve a user by internal usr_ id OR Cognito sub (the handler accepts both).
  rpc GetUserById(GetUserByIdRequest) returns (UserResponse);
}

message GetUserByIdRequest {
  string id = 1;
}

message UserResponse {
  string id = 1;
  string email = 2;
  string full_name = 3;
  string cognito_sub = 4;
}
```

- [ ] **Step 2: Verify it parses**

Run: `nvm use && npx --yes @grpc/proto-loader-tools 2>/dev/null || node -e "require('@grpc/proto-loader')" 2>/dev/null; echo "proto written"`
Expected: the file exists at `proto/users.proto`. (Full parse is exercised by Task A3's server load.)

- [ ] **Step 3: Commit**

```bash
git add proto/users.proto
git commit -m "feat(orders): add shared users.proto gRPC contract"
```

---

### Task A2: gRPC dependencies + env in Users

**Files:**
- Modify: `services/users/package.json` (add deps)
- Modify: `services/users/src/shared/config/env.ts` (add `GRPC_PORT`, `GRPC_API_KEY`)
- Test: `services/users/tests/shared/env.test.ts` (extend)

**Interfaces:**
- Produces: `env.GRPC_PORT` (number, default 50051) and `env.GRPC_API_KEY` (string, required) available to the gRPC bootstrap (Task A3).

- [ ] **Step 1: Add the failing env test**

Add to `services/users/tests/shared/env.test.ts`:

```ts
it("parses GRPC_PORT and GRPC_API_KEY", () => {
  const parsed = envSchema.parse({
    ...baseValidEnv,
    GRPC_PORT: "50051",
    GRPC_API_KEY: "local-dev-grpc-key",
  });
  expect(parsed.GRPC_PORT).toBe(50051);
  expect(parsed.GRPC_API_KEY).toBe("local-dev-grpc-key");
});
```

> If `envSchema`/`baseValidEnv` are not already exported from the test's imports, mirror the existing tests in this file — use the same schema symbol they use.

- [ ] **Step 2: Run it to verify it fails**

Run: `nvm use && cd services/users && pnpm test -- env`
Expected: FAIL — `GRPC_PORT`/`GRPC_API_KEY` not on the parsed object (undefined).

- [ ] **Step 3: Add the env fields**

In `services/users/src/shared/config/env.ts`, add to the Zod schema (follow the existing field style):

```ts
GRPC_PORT: z.coerce.number().int().positive().default(50051),
GRPC_API_KEY: z.string().min(1),
```

- [ ] **Step 4: Add the deps**

Run:

```bash
nvm use && cd services/users && pnpm add @grpc/grpc-js @grpc/proto-loader
```

Expected: `@grpc/grpc-js` and `@grpc/proto-loader` appear under `dependencies` in `services/users/package.json`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `nvm use && cd services/users && pnpm test -- env`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/users/package.json services/users/pnpm-lock.yaml services/users/src/shared/config/env.ts services/users/tests/shared/env.test.ts
git commit -m "feat(users): add gRPC deps and GRPC_PORT/GRPC_API_KEY env"
```

---

### Task A3: gRPC server + api-key interceptor + bootstrap

**Files:**
- Create: `services/users/src/shared/grpc/server.ts`
- Create: `services/users/src/shared/grpc/api-key-interceptor.ts`
- Modify: `services/users/src/server.ts` (start gRPC alongside Fastify)
- Test: `services/users/tests/shared/grpc/api-key-interceptor.test.ts`
- Test: `services/users/tests/features/users/grpc/get-user-by-id.test.ts` (already exists — leave as is)

**Interfaces:**
- Consumes: `env.GRPC_PORT`, `env.GRPC_API_KEY` (Task A2); `getUserByIdHandler` from `#features/users/grpc/get-user-by-id` (exists); the container's `userQueryService` (from the existing Awilix container).
- Produces: `buildGrpcServer(deps: { userQueryService }): grpc.Server` and `startGrpcServer(): Promise<grpc.Server>`; the exported `apiKeyMatches(provided: string | undefined, expected: string): boolean` constant-time comparator.

- [ ] **Step 1: Write the failing interceptor test**

Create `services/users/tests/shared/grpc/api-key-interceptor.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { apiKeyMatches } from "#shared/grpc/api-key-interceptor";

describe("apiKeyMatches", () => {
  it("returns true for identical keys", () => {
    expect(apiKeyMatches("secret-key", "secret-key")).toBe(true);
  });
  it("returns false for a mismatch", () => {
    expect(apiKeyMatches("wrong", "secret-key")).toBe(false);
  });
  it("returns false when the key is missing", () => {
    expect(apiKeyMatches(undefined, "secret-key")).toBe(false);
  });
  it("returns false for different lengths without throwing", () => {
    expect(apiKeyMatches("short", "a-much-longer-key")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `nvm use && cd services/users && pnpm test -- api-key-interceptor`
Expected: FAIL — module `#shared/grpc/api-key-interceptor` not found.

- [ ] **Step 3: Implement the interceptor + comparator**

Create `services/users/src/shared/grpc/api-key-interceptor.ts`:

```ts
import { timingSafeEqual } from "node:crypto";
import * as grpc from "@grpc/grpc-js";

// Constant-time comparison. Returns false (never throws) on length mismatch or
// a missing provided key, so timing does not leak whether the key was close.
export function apiKeyMatches(
  provided: string | undefined,
  expected: string,
): boolean {
  if (provided === undefined) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Server interceptor: rejects the call with UNAUTHENTICATED before the handler
// runs unless metadata `x-api-key` matches GRPC_API_KEY.
export function makeApiKeyInterceptor(expectedKey: string) {
  return function apiKeyInterceptor(
    methodDescriptor: grpc.ServerMethodDefinition<unknown, unknown>,
    call: grpc.ServerInterceptingCall,
  ): grpc.ServerInterceptingCall {
    return new grpc.ServerInterceptingCall(call, {
      start(next) {
        const listener: grpc.InterceptingListener = {
          onReceiveMetadata(metadata, mdNext) {
            const provided = metadata.get("x-api-key")[0]?.toString();
            if (!apiKeyMatches(provided, expectedKey)) {
              call.sendStatus({
                code: grpc.status.UNAUTHENTICATED,
                details: "invalid api key",
                metadata: new grpc.Metadata(),
              });
              return;
            }
            mdNext(metadata);
          },
          onReceiveMessage(message, msgNext) {
            msgNext(message);
          },
          onReceiveHalfClose(hcNext) {
            hcNext();
          },
          onCancel() {},
        };
        next(listener);
      },
    });
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `nvm use && cd services/users && pnpm test -- api-key-interceptor`
Expected: PASS (4 tests).

- [ ] **Step 5: Implement the gRPC server loader**

Create `services/users/src/shared/grpc/server.ts`:

```ts
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { env } from "#shared/config/env";
import { getUserByIdHandler } from "#features/users/grpc/get-user-by-id";
import type { UserQueryService } from "#features/users/queries/get-me";
import { makeApiKeyInterceptor } from "#shared/grpc/api-key-interceptor";

const PROTO_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../proto/users.proto",
);

export interface GrpcServerDeps {
  userQueryService: Pick<UserQueryService, "getUserById">;
}

export function buildGrpcServer(deps: GrpcServerDeps): grpc.Server {
  const packageDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(packageDef) as unknown as {
    users: { v1: { Users: { service: grpc.ServiceDefinition } } };
  };

  const server = new grpc.Server({
    interceptors: [makeApiKeyInterceptor(env.GRPC_API_KEY)],
  });

  server.addService(proto.users.v1.Users.service, {
    async GetUserById(
      call: grpc.ServerUnaryCall<{ id: string }, unknown>,
      callback: grpc.sendUnaryData<unknown>,
    ) {
      const { user } = await getUserByIdHandler(deps, {
        request: { id: call.request.id },
      });
      if (user === null) {
        callback({ code: grpc.status.NOT_FOUND, details: "user not found" });
        return;
      }
      callback(null, {
        id: user.id,
        email: user.email,
        full_name: user.fullName,
        cognito_sub: user.cognitoSub ?? "",
      });
    },
  });

  return server;
}

export function startGrpcServer(deps: GrpcServerDeps): Promise<grpc.Server> {
  const server = buildGrpcServer(deps);
  return new Promise((resolvePromise, reject) => {
    server.bindAsync(
      `0.0.0.0:${env.GRPC_PORT}`,
      grpc.ServerCredentials.createInsecure(),
      (err) => {
        if (err) return reject(err);
        resolvePromise(server);
      },
    );
  });
}
```

> Verify the relative depth of `PROTO_PATH` against the actual location of `src/shared/grpc/server.ts` when running — it must resolve to the repo-root `proto/users.proto`. Adjust the number of `../` if the compiled `dist/` layout differs; prefer resolving from a known root if the service already has a path helper.

- [ ] **Step 6: Wire it into the bootstrap**

Modify `services/users/src/server.ts` to start gRPC alongside Fastify. The `userQueryService` must come from the same composition the HTTP app uses — read `services/users/src/features/users/http/routes.ts` and `services/users/src/shared/di/awilix-container.ts` to resolve it the same way. Resulting shape:

```ts
import { env } from "#shared/config/env";
import { buildApp } from "#features/users/http/routes";
import { startGrpcServer } from "#shared/grpc/server";

const app = buildApp();

await app.listen({ port: env.PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

// Resolve the same UserQueryService the HTTP layer uses from the app's DI scope.
const userQueryService = app.diContainer.resolve("userQueryService");
await startGrpcServer({ userQueryService }).catch((err) => {
  app.log.error(err, "gRPC server failed to start");
  process.exit(1);
});
app.log.info(`gRPC server listening on :${env.GRPC_PORT}`);
```

> The exact `resolve("userQueryService")` name must match the registration in `awilix-container.ts`. If the container is request-scoped, resolve from `app.diContainer` (the root scope) as shown; confirm the registered name before finalizing.

- [ ] **Step 7: Verify build + full test run**

Run: `nvm use && cd services/users && pnpm build && pnpm lint && pnpm test`
Expected: build succeeds, lint clean, all tests pass (including the pre-existing `get-user-by-id.test.ts`).

- [ ] **Step 8: Commit**

```bash
git add services/users/src/shared/grpc/ services/users/src/server.ts services/users/tests/shared/grpc/
git commit -m "feat(users): serve GetUserById over gRPC with x-api-key interceptor"
```

---

### Task A4: Expose the Users gRPC port in compose/Floci

**Files:**
- Modify: `docker-compose.yml` (users service: expose gRPC port + env)
- Modify: `services/users/CLAUDE.md` (document the gRPC surface as live)

**Interfaces:**
- Produces: the `users` container reachable at `users:50051` on `3mrai-network`, with `GRPC_PORT` and `GRPC_API_KEY` in its environment. Consumed by the `orders` container (Task C-infra).

- [ ] **Step 1: Add the gRPC port and env to the users service**

In `docker-compose.yml`, under the `users:` service, add `"50051:50051"` to `ports` and these to `environment` (mirror the existing `WEBHOOK_SECRET` local-secret style):

```yaml
      - GRPC_PORT=50051
      - GRPC_API_KEY=local-dev-grpc-key
```

- [ ] **Step 2: Bring the service up and verify the port listens**

Run: `docker compose up users --build -d && sleep 5 && docker compose exec users sh -c "nc -z localhost 50051 && echo GRPC_UP"`
Expected: `GRPC_UP` (or an equivalent port-check). If `nc` is unavailable in the image, check `docker compose logs users` for `gRPC server listening on :50051`.

- [ ] **Step 3: Update the Users CLAUDE.md gRPC note**

In `services/users/CLAUDE.md`, change the gRPC line from "handler exists; no server wiring yet" to note the server is live on `:50051`, guarded by the `x-api-key` interceptor, over `/proto/users.proto`.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml services/users/CLAUDE.md
git commit -m "feat(users): expose gRPC :50051 on the compose network"
```

---

## Phase B — Orders service: scaffolding, data model, read endpoints (independent of the gate)

> Everything in Phase B is independent of Phase A and can proceed in parallel after B1. The read endpoints filter by `cognito_sub` from the `x-user-id` header and never call gRPC.

### Task B1: Solution + five Clean Architecture projects

**Files:**
- Create: `services/orders/Orders.sln`
- Create: `services/orders/src/Orders.Domain/Orders.Domain.csproj`
- Create: `services/orders/src/Orders.Application/Orders.Application.csproj`
- Create: `services/orders/src/Orders.Infrastructure/Orders.Infrastructure.csproj`
- Create: `services/orders/src/Orders.Api/Orders.Api.csproj`
- Create: `services/orders/tests/Orders.Tests/Orders.Tests.csproj`
- Remove: the `.gitkeep` placeholders under `services/orders/src/**`

**Interfaces:**
- Produces: a buildable solution with references Domain ← Application ← Infrastructure/Api, and Api → Infrastructure. Domain references nothing.

- [ ] **Step 1: Create the solution and projects**

Run from `services/orders`:

```bash
cd services/orders
dotnet new sln -n Orders
dotnet new classlib -n Orders.Domain -o src/Orders.Domain -f net10.0
dotnet new classlib -n Orders.Application -o src/Orders.Application -f net10.0
dotnet new classlib -n Orders.Infrastructure -o src/Orders.Infrastructure -f net10.0
dotnet new web -n Orders.Api -o src/Orders.Api -f net10.0
dotnet new xunit -n Orders.Tests -o tests/Orders.Tests -f net10.0
dotnet sln add src/Orders.Domain src/Orders.Application src/Orders.Infrastructure src/Orders.Api tests/Orders.Tests
```

- [ ] **Step 2: Wire the project references (enforce the dependency direction)**

```bash
cd services/orders
dotnet add src/Orders.Application reference src/Orders.Domain
dotnet add src/Orders.Infrastructure reference src/Orders.Application src/Orders.Domain
dotnet add src/Orders.Api reference src/Orders.Application src/Orders.Infrastructure
dotnet add tests/Orders.Tests reference src/Orders.Domain src/Orders.Application src/Orders.Infrastructure src/Orders.Api
```

- [ ] **Step 3: Remove placeholders and verify the build**

```bash
cd services/orders
find src -name .gitkeep -delete
dotnet build
```

Expected: `Build succeeded`. Domain has zero project references (verify: `dotnet list src/Orders.Domain reference` prints none).

- [ ] **Step 4: Commit**

```bash
git add services/orders
git commit -m "feat(orders): scaffold Clean Architecture solution (Domain/Application/Infrastructure/Api/Tests)"
```

---

### Task B2: Domain entities with money-in-cents + computed dollars

**Files:**
- Create: `services/orders/src/Orders.Domain/Entities/AuditableEntity.cs`
- Create: `services/orders/src/Orders.Domain/Entities/Product.cs`
- Create: `services/orders/src/Orders.Domain/Entities/Order.cs`
- Create: `services/orders/src/Orders.Domain/Entities/OrderDetail.cs`
- Test: `services/orders/tests/Orders.Tests/Domain/MoneyComputedTests.cs`

**Interfaces:**
- Produces: `Product { Id, Name, Description, UnitPriceCents (long), UnitPrice (decimal, computed), UnitsInStock (uint), audit }`; `Order { Id, UserId, CognitoSub, SubtotalCents, TaxCents, TotalCents, Subtotal/Tax/Total computed, Details (list), audit }`; `OrderDetail { Id, OrderId, ProductId, UserId, CognitoSub, Quantity (uint), SubtotalCents, TaxCents, TotalCents, computed dollars, audit }`; `AuditableEntity` base with the six audit fields + `IsDeleted`.

- [ ] **Step 1: Write the failing computed-property test**

Create `services/orders/tests/Orders.Tests/Domain/MoneyComputedTests.cs`:

```csharp
using Orders.Domain.Entities;
using Xunit;

namespace Orders.Tests.Domain;

public class MoneyComputedTests
{
    [Fact]
    public void UnitPrice_converts_cents_to_dollars()
    {
        var product = new Product { UnitPriceCents = 1999 };
        Assert.Equal(19.99m, product.UnitPrice);
    }

    [Fact]
    public void Order_totals_convert_cents_to_dollars()
    {
        var order = new Order { SubtotalCents = 5000, TaxCents = 400, TotalCents = 5400 };
        Assert.Equal(50.00m, order.Subtotal);
        Assert.Equal(4.00m, order.Tax);
        Assert.Equal(54.00m, order.Total);
    }

    [Fact]
    public void IsDeleted_is_true_when_deleted_at_set()
    {
        var order = new Order { DeletedAt = new DateTime(2026, 7, 14) };
        Assert.True(order.IsDeleted);
    }

    [Fact]
    public void IsDeleted_is_false_when_deleted_at_null()
    {
        Assert.False(new Order().IsDeleted);
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd services/orders && dotnet test --filter MoneyComputedTests`
Expected: FAIL — `Product`/`Order` do not exist / do not compile.

- [ ] **Step 3: Implement the base auditable entity**

Create `services/orders/src/Orders.Domain/Entities/AuditableEntity.cs`:

```csharp
namespace Orders.Domain.Entities;

// Standard audit fields + soft-delete for every entity. See soft-delete / audit-fields conventions.
public abstract class AuditableEntity
{
    public string Id { get; set; } = string.Empty;
    public string? CreatedBy { get; set; }
    public DateTime CreatedAt { get; set; }
    public string? UpdatedBy { get; set; }
    public DateTime UpdatedAt { get; set; }
    public string? DeletedBy { get; set; }
    public DateTime? DeletedAt { get; set; }

    // Computed, not persisted.
    public bool IsDeleted => DeletedAt is not null;
}
```

- [ ] **Step 4: Implement the entities**

Create `services/orders/src/Orders.Domain/Entities/Product.cs`:

```csharp
namespace Orders.Domain.Entities;

public class Product : AuditableEntity
{
    public string Name { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public long UnitPriceCents { get; set; }
    public uint UnitsInStock { get; set; }

    // Computed, not persisted: dollars for display only.
    public decimal UnitPrice => UnitPriceCents / 100m;
}
```

Create `services/orders/src/Orders.Domain/Entities/Order.cs`:

```csharp
namespace Orders.Domain.Entities;

public class Order : AuditableEntity
{
    public string UserId { get; set; } = string.Empty;      // internal usr_ id
    public string CognitoSub { get; set; } = string.Empty;  // from the gateway
    public long SubtotalCents { get; set; }
    public long TaxCents { get; set; }
    public long TotalCents { get; set; }

    public List<OrderDetail> Details { get; set; } = new();

    public decimal Subtotal => SubtotalCents / 100m;
    public decimal Tax => TaxCents / 100m;
    public decimal Total => TotalCents / 100m;
}
```

Create `services/orders/src/Orders.Domain/Entities/OrderDetail.cs`:

```csharp
namespace Orders.Domain.Entities;

public class OrderDetail : AuditableEntity
{
    public string OrderId { get; set; } = string.Empty;
    public string ProductId { get; set; } = string.Empty;
    public string UserId { get; set; } = string.Empty;      // denormalized internal usr_ id
    public string CognitoSub { get; set; } = string.Empty;  // denormalized
    public uint Quantity { get; set; }
    public long SubtotalCents { get; set; }
    public long TaxCents { get; set; }
    public long TotalCents { get; set; }

    public decimal Subtotal => SubtotalCents / 100m;
    public decimal Tax => TaxCents / 100m;
    public decimal Total => TotalCents / 100m;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd services/orders && dotnet test --filter MoneyComputedTests`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add services/orders/src/Orders.Domain services/orders/tests/Orders.Tests/Domain
git commit -m "feat(orders): domain entities with money-in-cents and computed dollars"
```

---

### Task B3: Order pricing domain logic (server-side calculation)

**Files:**
- Create: `services/orders/src/Orders.Domain/Pricing/OrderPricing.cs`
- Test: `services/orders/tests/Orders.Tests/Domain/OrderPricingTests.cs`

**Interfaces:**
- Consumes: `Product` (B2).
- Produces: `OrderPricing.PriceLine(long unitPriceCents, uint quantity, decimal taxRate) → (long subtotalCents, long taxCents, long totalCents)` — pure integer-cents arithmetic; tax rounded to the nearest cent with banker's-rounding avoided (use `MidpointRounding.AwayFromZero`).

- [ ] **Step 1: Write the failing test**

Create `services/orders/tests/Orders.Tests/Domain/OrderPricingTests.cs`:

```csharp
using Orders.Domain.Pricing;
using Xunit;

namespace Orders.Tests.Domain;

public class OrderPricingTests
{
    [Fact]
    public void PriceLine_multiplies_and_applies_tax()
    {
        // 3 units at $19.99 = $59.97 subtotal; 8% tax = $4.7976 -> 480 cents.
        var (subtotal, tax, total) = OrderPricing.PriceLine(1999, 3, 0.08m);
        Assert.Equal(5997, subtotal);
        Assert.Equal(480, tax);
        Assert.Equal(6477, total);
    }

    [Fact]
    public void PriceLine_zero_tax()
    {
        var (subtotal, tax, total) = OrderPricing.PriceLine(1000, 2, 0m);
        Assert.Equal(2000, subtotal);
        Assert.Equal(0, tax);
        Assert.Equal(2000, total);
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd services/orders && dotnet test --filter OrderPricingTests`
Expected: FAIL — `OrderPricing` does not exist.

- [ ] **Step 3: Implement the pricing logic**

Create `services/orders/src/Orders.Domain/Pricing/OrderPricing.cs`:

```csharp
namespace Orders.Domain.Pricing;

// All money math is integer-cents. Tax is computed from the integer subtotal and
// rounded to the nearest cent (away from zero) exactly once per line.
public static class OrderPricing
{
    public static (long SubtotalCents, long TaxCents, long TotalCents) PriceLine(
        long unitPriceCents,
        uint quantity,
        decimal taxRate)
    {
        long subtotalCents = unitPriceCents * quantity;
        long taxCents = (long)Math.Round(subtotalCents * taxRate, MidpointRounding.AwayFromZero);
        return (subtotalCents, taxCents, subtotalCents + taxCents);
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd services/orders && dotnet test --filter OrderPricingTests`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add services/orders/src/Orders.Domain/Pricing services/orders/tests/Orders.Tests/Domain/OrderPricingTests.cs
git commit -m "feat(orders): server-side order pricing in integer cents"
```

---

### Task B4: EF Core — DbContext, entity configs (snake_case), nano-id + audit

**Files:**
- Create: `services/orders/src/Orders.Infrastructure/Persistence/OrdersWriteDbContext.cs`
- Create: `services/orders/src/Orders.Infrastructure/Persistence/OrdersReadDbContext.cs`
- Create: `services/orders/src/Orders.Infrastructure/Persistence/Configurations/ProductConfiguration.cs`
- Create: `services/orders/src/Orders.Infrastructure/Persistence/Configurations/OrderConfiguration.cs`
- Create: `services/orders/src/Orders.Infrastructure/Persistence/Configurations/OrderDetailConfiguration.cs`
- Create: `services/orders/src/Orders.Infrastructure/Id/NanoId.cs`
- Modify: `services/orders/src/Orders.Infrastructure/Orders.Infrastructure.csproj` (add EF Core + Pomelo MySQL + Nanoid packages)
- Test: `services/orders/tests/Orders.Tests/Infrastructure/EntityMappingTests.cs`

**Interfaces:**
- Consumes: Domain entities (B2).
- Produces: `OrdersWriteDbContext` / `OrdersReadDbContext` each exposing `DbSet<Product> Products`, `DbSet<Order> Orders`, `DbSet<OrderDetail> OrderDetails`; a global query filter `!IsDeleted`; `NanoId.NewId(string prefix)`; column names snake_case with `_cents` money columns as `bigint`.

- [ ] **Step 1: Add the packages**

```bash
cd services/orders
dotnet add src/Orders.Infrastructure package Microsoft.EntityFrameworkCore
dotnet add src/Orders.Infrastructure package Pomelo.EntityFrameworkCore.MySql --prerelease
dotnet add src/Orders.Infrastructure package Nanoid
dotnet add src/Orders.Infrastructure package Microsoft.EntityFrameworkCore.Design
```

> Pomelo is the standard MySQL provider for EF Core. If a stable net10-compatible version exists, drop `--prerelease`.

- [ ] **Step 2: Write the failing mapping test (in-memory model build)**

Create `services/orders/tests/Orders.Tests/Infrastructure/EntityMappingTests.cs`:

```csharp
using Microsoft.EntityFrameworkCore;
using Orders.Domain.Entities;
using Orders.Infrastructure.Persistence;
using Xunit;

namespace Orders.Tests.Infrastructure;

public class EntityMappingTests
{
    private static OrdersWriteDbContext BuildContext()
    {
        var options = new DbContextOptionsBuilder<OrdersWriteDbContext>()
            .UseInMemoryDatabase("mapping-test")
            .Options;
        return new OrdersWriteDbContext(options);
    }

    [Fact]
    public void Order_maps_to_snake_case_table_and_cents_columns()
    {
        using var ctx = BuildContext();
        var entity = ctx.Model.FindEntityType(typeof(Order))!;
        Assert.Equal("order", entity.GetTableName());
        Assert.Equal("total_cents", entity.FindProperty(nameof(Order.TotalCents))!.GetColumnName());
        Assert.Equal("cognito_sub", entity.FindProperty(nameof(Order.CognitoSub))!.GetColumnName());
    }

    [Fact]
    public void Computed_dollar_properties_are_not_mapped()
    {
        using var ctx = BuildContext();
        var entity = ctx.Model.FindEntityType(typeof(Order))!;
        Assert.Null(entity.FindProperty(nameof(Order.Total)));
        Assert.Null(entity.FindProperty(nameof(Order.IsDeleted)));
    }
}
```

> Add the EF Core InMemory package to the test project for this build-only model check: `dotnet add tests/Orders.Tests package Microsoft.EntityFrameworkCore.InMemory`.

- [ ] **Step 3: Run it to verify it fails**

Run: `cd services/orders && dotnet test --filter EntityMappingTests`
Expected: FAIL — `OrdersWriteDbContext` does not exist.

- [ ] **Step 4: Implement the nano-id helper**

Create `services/orders/src/Orders.Infrastructure/Id/NanoId.cs`:

```csharp
namespace Orders.Infrastructure.Id;

// Prefixed nano-ids, mirroring the shared convention: prd_ / ord_ / odd_.
public static class NanoId
{
    public const string ProductPrefix = "prd_";
    public const string OrderPrefix = "ord_";
    public const string OrderDetailPrefix = "odd_";

    public static string NewId(string prefix) => prefix + Nanoid.Generate(size: 21);
}
```

- [ ] **Step 5: Implement the entity configurations**

Create `services/orders/src/Orders.Infrastructure/Persistence/Configurations/ProductConfiguration.cs`:

```csharp
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Orders.Domain.Entities;

namespace Orders.Infrastructure.Persistence.Configurations;

public class ProductConfiguration : IEntityTypeConfiguration<Product>
{
    public void Configure(EntityTypeBuilder<Product> b)
    {
        b.ToTable("product");
        b.HasKey(p => p.Id);
        b.Property(p => p.Id).HasColumnName("id").HasMaxLength(26);
        b.Property(p => p.Name).HasColumnName("name").HasMaxLength(255);
        b.Property(p => p.Description).HasColumnName("description").HasColumnType("text");
        b.Property(p => p.UnitPriceCents).HasColumnName("unit_price_cents").HasColumnType("bigint");
        b.Property(p => p.UnitsInStock).HasColumnName("units_in_stock");
        ApplyAudit(b);
        b.Ignore(p => p.UnitPrice);
        b.Ignore(p => p.IsDeleted);
        b.HasQueryFilter(p => p.DeletedAt == null);
    }

    internal static void ApplyAudit<T>(EntityTypeBuilder<T> b) where T : AuditableEntity
    {
        b.Property(e => e.CreatedBy).HasColumnName("created_by").HasMaxLength(26);
        b.Property(e => e.CreatedAt).HasColumnName("created_at");
        b.Property(e => e.UpdatedBy).HasColumnName("updated_by").HasMaxLength(26);
        b.Property(e => e.UpdatedAt).HasColumnName("updated_at");
        b.Property(e => e.DeletedBy).HasColumnName("deleted_by").HasMaxLength(26);
        b.Property(e => e.DeletedAt).HasColumnName("deleted_at");
    }
}
```

Create `services/orders/src/Orders.Infrastructure/Persistence/Configurations/OrderConfiguration.cs`:

```csharp
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Orders.Domain.Entities;

namespace Orders.Infrastructure.Persistence.Configurations;

public class OrderConfiguration : IEntityTypeConfiguration<Order>
{
    public void Configure(EntityTypeBuilder<Order> b)
    {
        b.ToTable("order");
        b.HasKey(o => o.Id);
        b.Property(o => o.Id).HasColumnName("id").HasMaxLength(26);
        b.Property(o => o.UserId).HasColumnName("user_id").HasMaxLength(26);
        b.Property(o => o.CognitoSub).HasColumnName("cognito_sub").HasMaxLength(255);
        b.Property(o => o.SubtotalCents).HasColumnName("subtotal_cents").HasColumnType("bigint");
        b.Property(o => o.TaxCents).HasColumnName("tax_cents").HasColumnType("bigint");
        b.Property(o => o.TotalCents).HasColumnName("total_cents").HasColumnType("bigint");
        ProductConfiguration.ApplyAudit(b);
        b.Ignore(o => o.Subtotal);
        b.Ignore(o => o.Tax);
        b.Ignore(o => o.Total);
        b.Ignore(o => o.IsDeleted);
        b.HasMany(o => o.Details).WithOne().HasForeignKey(d => d.OrderId);
        b.HasIndex(o => o.UserId).HasDatabaseName("idx_order_user_id");
        b.HasIndex(o => o.CognitoSub).HasDatabaseName("idx_order_cognito_sub");
        b.HasIndex(o => o.DeletedAt).HasDatabaseName("idx_order_deleted_at");
        b.HasQueryFilter(o => o.DeletedAt == null);
    }
}
```

Create `services/orders/src/Orders.Infrastructure/Persistence/Configurations/OrderDetailConfiguration.cs`:

```csharp
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Orders.Domain.Entities;

namespace Orders.Infrastructure.Persistence.Configurations;

public class OrderDetailConfiguration : IEntityTypeConfiguration<OrderDetail>
{
    public void Configure(EntityTypeBuilder<OrderDetail> b)
    {
        b.ToTable("order_details");
        b.HasKey(d => d.Id);
        b.Property(d => d.Id).HasColumnName("id").HasMaxLength(26);
        b.Property(d => d.OrderId).HasColumnName("order_id").HasMaxLength(26);
        b.Property(d => d.ProductId).HasColumnName("product_id").HasMaxLength(26);
        b.Property(d => d.UserId).HasColumnName("user_id").HasMaxLength(26);
        b.Property(d => d.CognitoSub).HasColumnName("cognito_sub").HasMaxLength(255);
        b.Property(d => d.Quantity).HasColumnName("quantity");
        b.Property(d => d.SubtotalCents).HasColumnName("subtotal_cents").HasColumnType("bigint");
        b.Property(d => d.TaxCents).HasColumnName("tax_cents").HasColumnType("bigint");
        b.Property(d => d.TotalCents).HasColumnName("total_cents").HasColumnType("bigint");
        ProductConfiguration.ApplyAudit(b);
        b.Ignore(d => d.Subtotal);
        b.Ignore(d => d.Tax);
        b.Ignore(d => d.Total);
        b.Ignore(d => d.IsDeleted);
        b.HasIndex(d => d.OrderId).HasDatabaseName("idx_order_details_order_id");
        b.HasIndex(d => d.ProductId).HasDatabaseName("idx_order_details_product_id");
        b.HasIndex(d => d.DeletedAt).HasDatabaseName("idx_order_details_deleted_at");
        b.HasQueryFilter(d => d.DeletedAt == null);
    }
}
```

- [ ] **Step 6: Implement the two DbContexts**

Create `services/orders/src/Orders.Infrastructure/Persistence/OrdersWriteDbContext.cs`:

```csharp
using Microsoft.EntityFrameworkCore;
using Orders.Domain.Entities;
using Orders.Infrastructure.Persistence.Configurations;

namespace Orders.Infrastructure.Persistence;

public class OrdersWriteDbContext : DbContext
{
    public OrdersWriteDbContext(DbContextOptions<OrdersWriteDbContext> options) : base(options) { }

    public DbSet<Product> Products => Set<Product>();
    public DbSet<Order> Orders => Set<Order>();
    public DbSet<OrderDetail> OrderDetails => Set<OrderDetail>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.ApplyConfiguration(new ProductConfiguration());
        modelBuilder.ApplyConfiguration(new OrderConfiguration());
        modelBuilder.ApplyConfiguration(new OrderDetailConfiguration());
    }
}
```

Create `services/orders/src/Orders.Infrastructure/Persistence/OrdersReadDbContext.cs` — identical body but reads. To avoid duplicating `OnModelCreating`, make `OrdersReadDbContext` inherit from a shared base OR duplicate the three `ApplyConfiguration` lines. Duplicate here (YAGNI over premature base class):

```csharp
using Microsoft.EntityFrameworkCore;
using Orders.Domain.Entities;
using Orders.Infrastructure.Persistence.Configurations;

namespace Orders.Infrastructure.Persistence;

// Read-only context (read replica in prod; same MySQL locally). Queries should
// use AsNoTracking; writes never go through this context.
public class OrdersReadDbContext : DbContext
{
    public OrdersReadDbContext(DbContextOptions<OrdersReadDbContext> options) : base(options) { }

    public DbSet<Product> Products => Set<Product>();
    public DbSet<Order> Orders => Set<Order>();
    public DbSet<OrderDetail> OrderDetails => Set<OrderDetail>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.ApplyConfiguration(new ProductConfiguration());
        modelBuilder.ApplyConfiguration(new OrderConfiguration());
        modelBuilder.ApplyConfiguration(new OrderDetailConfiguration());
    }
}
```

- [ ] **Step 7: Run the mapping test to verify it passes**

Run: `cd services/orders && dotnet test --filter EntityMappingTests`
Expected: PASS (2 tests).

- [ ] **Step 8: Commit**

```bash
git add services/orders/src/Orders.Infrastructure services/orders/tests/Orders.Tests/Infrastructure
git commit -m "feat(orders): EF Core DbContexts, snake_case configs, nano-id helper"
```

---

### Task B5: Initial migration + Product seed

**Files:**
- Create: `services/orders/src/Orders.Infrastructure/Migrations/*` (generated)
- Create: `services/orders/src/Orders.Infrastructure/Persistence/ProductSeed.cs`
- Test: `services/orders/tests/Orders.Tests/Infrastructure/MigrationSeedTests.cs` (Testcontainers)

**Interfaces:**
- Consumes: DbContexts (B4).
- Produces: an applied schema (`product`/`order`/`order_details`) on a real MySQL; `ProductSeed.ApplyAsync(OrdersWriteDbContext) : Task` inserting a fixed catalog when `product` is empty.

- [ ] **Step 1: Add Testcontainers + EF design tooling to the test project**

```bash
cd services/orders
dotnet add tests/Orders.Tests package Testcontainers.MySql
dotnet add tests/Orders.Tests package Microsoft.EntityFrameworkCore.Design
dotnet tool install --global dotnet-ef  # if not already installed
```

- [ ] **Step 2: Implement the Product seed**

Create `services/orders/src/Orders.Infrastructure/Persistence/ProductSeed.cs`:

```csharp
using Microsoft.EntityFrameworkCore;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;

namespace Orders.Infrastructure.Persistence;

// Seeds a fixed catalog when empty. Prices are in integer cents.
public static class ProductSeed
{
    public static async Task ApplyAsync(OrdersWriteDbContext db)
    {
        if (await db.Products.AnyAsync()) return;

        var now = DateTime.UtcNow;
        db.Products.AddRange(
            new Product { Id = NanoId.NewId(NanoId.ProductPrefix), Name = "Widget", Description = "A basic widget", UnitPriceCents = 1999, UnitsInStock = 100, CreatedBy = "system", CreatedAt = now, UpdatedAt = now },
            new Product { Id = NanoId.NewId(NanoId.ProductPrefix), Name = "Gadget", Description = "A fancy gadget", UnitPriceCents = 4950, UnitsInStock = 50, CreatedBy = "system", CreatedAt = now, UpdatedAt = now },
            new Product { Id = NanoId.NewId(NanoId.ProductPrefix), Name = "Gizmo", Description = "A premium gizmo", UnitPriceCents = 12500, UnitsInStock = 25, CreatedBy = "system", CreatedAt = now, UpdatedAt = now }
        );
        await db.SaveChangesAsync();
    }
}
```

- [ ] **Step 3: Generate the initial migration**

Run (the design-time factory in Step 4 lets EF construct the context):

```bash
cd services/orders
dotnet ef migrations add InitialCreate \
  --project src/Orders.Infrastructure \
  --startup-project src/Orders.Api \
  --context OrdersWriteDbContext
```

Expected: a `Migrations/` folder with `*_InitialCreate.cs` creating `product`, `order`, `order_details` with the snake_case columns and the three index names.

> This requires `Orders.Api` to register `OrdersWriteDbContext` with a MySQL provider (done in Task C-infra Step for DI). If the migration command needs the provider before DI exists, add a `IDesignTimeDbContextFactory<OrdersWriteDbContext>` in Infrastructure returning a context configured with `UseMySql(ServerVersion.AutoDetect(...))` against a placeholder connection string — EF only needs the provider, not a live DB, to scaffold.

- [ ] **Step 4: Write the Testcontainers migration+seed test**

Create `services/orders/tests/Orders.Tests/Infrastructure/MigrationSeedTests.cs`:

```csharp
using Microsoft.EntityFrameworkCore;
using Orders.Infrastructure.Persistence;
using Testcontainers.MySql;
using Xunit;

namespace Orders.Tests.Infrastructure;

public class MigrationSeedTests : IAsyncLifetime
{
    private readonly MySqlContainer _mysql = new MySqlBuilder().WithDatabase("orders").Build();

    public Task InitializeAsync() => _mysql.StartAsync();
    public Task DisposeAsync() => _mysql.DisposeAsync().AsTask();

    private OrdersWriteDbContext NewContext()
    {
        var cs = _mysql.GetConnectionString();
        var options = new DbContextOptionsBuilder<OrdersWriteDbContext>()
            .UseMySql(cs, ServerVersion.AutoDetect(cs))
            .Options;
        return new OrdersWriteDbContext(options);
    }

    [Fact]
    public async Task Migrations_apply_and_seed_inserts_catalog()
    {
        await using var db = NewContext();
        await db.Database.MigrateAsync();
        await ProductSeed.ApplyAsync(db);

        Assert.Equal(3, await db.Products.CountAsync());
        Assert.All(await db.Products.ToListAsync(), p => Assert.StartsWith("prd_", p.Id));
    }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd services/orders && dotnet test --filter MigrationSeedTests`
Expected: PASS — a real MySQL container starts, migrations apply, seed inserts 3 products. (Requires Docker running.)

- [ ] **Step 6: Commit**

```bash
git add services/orders/src/Orders.Infrastructure/Migrations services/orders/src/Orders.Infrastructure/Persistence/ProductSeed.cs services/orders/tests/Orders.Tests/Infrastructure/MigrationSeedTests.cs
git commit -m "feat(orders): initial migration and Product seed, verified on real MySQL"
```

---

### Task B6: Read endpoints — my-orders, order-by-id (ownership by filter), health

**Files:**
- Create: `services/orders/src/Orders.Application/Orders/OrderReadService.cs`
- Create: `services/orders/src/Orders.Application/Orders/OrderDto.cs`
- Create: `services/orders/src/Orders.Api/Endpoints/OrderEndpoints.cs`
- Create: `services/orders/src/Orders.Api/Identity/CallerIdentity.cs`
- Modify: `services/orders/src/Orders.Api/Program.cs`
- Test: `services/orders/tests/Orders.Tests/Application/OrderReadServiceTests.cs` (Testcontainers)

**Interfaces:**
- Consumes: `OrdersReadDbContext` (B4).
- Produces: `OrderReadService.GetMyOrdersAsync(string cognitoSub)` and `GetByIdAsync(string orderId, string cognitoSub)` (returns null when not found/other user's); `OrderDto` (cents fields); `CallerIdentity.RequireCognitoSub(HttpContext)` reading `x-user-id`.

- [ ] **Step 1: Write the failing read-service test (ownership filter → 404 semantics)**

Create `services/orders/tests/Orders.Tests/Application/OrderReadServiceTests.cs`:

```csharp
using Microsoft.EntityFrameworkCore;
using Orders.Application.Orders;
using Orders.Domain.Entities;
using Orders.Infrastructure.Persistence;
using Testcontainers.MySql;
using Xunit;

namespace Orders.Tests.Application;

public class OrderReadServiceTests : IAsyncLifetime
{
    private readonly MySqlContainer _mysql = new MySqlBuilder().WithDatabase("orders").Build();
    public Task InitializeAsync() => _mysql.StartAsync();
    public Task DisposeAsync() => _mysql.DisposeAsync().AsTask();

    private OrdersReadDbContext ReadCtx()
    {
        var cs = _mysql.GetConnectionString();
        return new OrdersReadDbContext(new DbContextOptionsBuilder<OrdersReadDbContext>()
            .UseMySql(cs, ServerVersion.AutoDetect(cs)).Options);
    }
    private OrdersWriteDbContext WriteCtx()
    {
        var cs = _mysql.GetConnectionString();
        return new OrdersWriteDbContext(new DbContextOptionsBuilder<OrdersWriteDbContext>()
            .UseMySql(cs, ServerVersion.AutoDetect(cs)).Options);
    }

    [Fact]
    public async Task GetById_returns_null_for_another_users_order()
    {
        await using (var w = WriteCtx())
        {
            await w.Database.MigrateAsync();
            w.Orders.Add(new Order { Id = "ord_test1", UserId = "usr_a", CognitoSub = "sub-a", CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow });
            await w.SaveChangesAsync();
        }
        await using var r = ReadCtx();
        var svc = new OrderReadService(r);
        Assert.Null(await svc.GetByIdAsync("ord_test1", "sub-b"));      // other user → null (→ 404)
        Assert.NotNull(await svc.GetByIdAsync("ord_test1", "sub-a"));   // owner → found
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd services/orders && dotnet test --filter OrderReadServiceTests`
Expected: FAIL — `OrderReadService`/`OrderDto` do not exist.

- [ ] **Step 3: Implement the DTO and read service**

Create `services/orders/src/Orders.Application/Orders/OrderDto.cs`:

```csharp
namespace Orders.Application.Orders;

public record OrderLineDto(string ProductId, uint Quantity, long SubtotalCents, long TaxCents, long TotalCents);

public record OrderDto(
    string Id,
    string UserId,
    string CognitoSub,
    long SubtotalCents,
    long TaxCents,
    long TotalCents,
    DateTime CreatedAt,
    IReadOnlyList<OrderLineDto> Lines);
```

Create `services/orders/src/Orders.Application/Orders/OrderReadService.cs`:

```csharp
using Microsoft.EntityFrameworkCore;
using Orders.Infrastructure.Persistence;

namespace Orders.Application.Orders;

// Ownership is enforced IN the query (WHERE cognito_sub = caller). Another user's
// order returns nothing → the API maps that to 404. No gRPC on reads.
public class OrderReadService
{
    private readonly OrdersReadDbContext _db;
    public OrderReadService(OrdersReadDbContext db) => _db = db;

    public async Task<OrderDto?> GetByIdAsync(string orderId, string callerSub)
    {
        var order = await _db.Orders.AsNoTracking()
            .Include(o => o.Details)
            .FirstOrDefaultAsync(o => o.Id == orderId && o.CognitoSub == callerSub);
        return order is null ? null : Map(order);
    }

    public async Task<IReadOnlyList<OrderDto>> GetMyOrdersAsync(string callerSub)
    {
        var orders = await _db.Orders.AsNoTracking()
            .Include(o => o.Details)
            .Where(o => o.CognitoSub == callerSub)
            .ToListAsync();
        return orders.Select(Map).ToList();
    }

    private static OrderDto Map(Domain.Entities.Order o) => new(
        o.Id, o.UserId, o.CognitoSub, o.SubtotalCents, o.TaxCents, o.TotalCents, o.CreatedAt,
        o.Details.Select(d => new OrderLineDto(d.ProductId, d.Quantity, d.SubtotalCents, d.TaxCents, d.TotalCents)).ToList());
}
```

- [ ] **Step 4: Implement caller identity + endpoints + Program.cs**

Create `services/orders/src/Orders.Api/Identity/CallerIdentity.cs`:

```csharp
namespace Orders.Api.Identity;

public static class CallerIdentity
{
    // The gateway injects the Cognito sub as x-user-id. Missing → 401.
    public static string? CognitoSub(HttpContext ctx) =>
        ctx.Request.Headers["x-user-id"].FirstOrDefault();
}
```

Create `services/orders/src/Orders.Api/Endpoints/OrderEndpoints.cs`:

```csharp
using Orders.Api.Identity;
using Orders.Application.Orders;

namespace Orders.Api.Endpoints;

public static class OrderEndpoints
{
    public static void MapOrderEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/v1/orders");

        group.MapGet("/my-orders", async (HttpContext ctx, OrderReadService reads) =>
        {
            var sub = CallerIdentity.CognitoSub(ctx);
            if (sub is null) return Results.Unauthorized();
            return Results.Ok(await reads.GetMyOrdersAsync(sub));
        });

        group.MapGet("/{orderId}", async (string orderId, HttpContext ctx, OrderReadService reads) =>
        {
            var sub = CallerIdentity.CognitoSub(ctx);
            if (sub is null) return Results.Unauthorized();
            var order = await reads.GetByIdAsync(orderId, sub);
            return order is null ? Results.NotFound() : Results.Ok(order);
        });

        app.MapGet("/v1/health", () => Results.Ok(new { status = "ok" }));
    }
}
```

Replace `services/orders/src/Orders.Api/Program.cs` with the DI wiring (read context + read service + endpoints). The write context, gRPC client, and POST are added in Phase C:

```csharp
using Microsoft.EntityFrameworkCore;
using Orders.Api.Endpoints;
using Orders.Application.Orders;
using Orders.Infrastructure.Persistence;

var builder = WebApplication.CreateBuilder(args);

var readerCs = builder.Configuration["DATABASE_READER_URL"]!;
builder.Services.AddDbContext<OrdersReadDbContext>(o =>
    o.UseMySql(readerCs, ServerVersion.AutoDetect(readerCs)));
builder.Services.AddScoped<OrderReadService>();

var app = builder.Build();
app.MapOrderEndpoints();
app.Run();

public partial class Program { }  // for WebApplicationFactory in tests
```

> `DATABASE_READER_URL` here is a MySQL ADO connection string (host/port/user/password/db), not a URL-style DSN. The compose task (C-infra) sets it; the design's two-URL split maps to `DATABASE_READER_URL` (read ctx) and `DATABASE_WRITER_URL` (write ctx, Phase C).

- [ ] **Step 5: Run the read-service test to verify it passes**

Run: `cd services/orders && dotnet test --filter OrderReadServiceTests`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/orders/src/Orders.Application services/orders/src/Orders.Api
git commit -m "feat(orders): read endpoints (my-orders, order-by-id 404, health) with ownership-by-filter"
```

---

## Phase C — Orders: gRPC client + transactional POST (depends on Phase A merged)

> **Gate:** Task C1 and C2 require Phase A (Users gRPC server) merged and reachable at `users:50051`. Do not start C1 until the Phase A batch is merged.

### Task C1: Orders gRPC client (Grpc.Tools) + identity resolver

**Files:**
- Modify: `services/orders/src/Orders.Infrastructure/Orders.Infrastructure.csproj` (add gRPC client packages + `<Protobuf>` ref)
- Create: `services/orders/src/Orders.Application/Identity/IUserDirectory.cs`
- Create: `services/orders/src/Orders.Infrastructure/Grpc/UserDirectoryGrpcClient.cs`
- Test: `services/orders/tests/Orders.Tests/Infrastructure/UserDirectoryGrpcClientTests.cs`

**Interfaces:**
- Consumes: `/proto/users.proto` (Task A1).
- Produces: port `IUserDirectory.ResolveInternalUserIdAsync(string cognitoSub) : Task<string?>` (Application); its gRPC implementation attaching `x-api-key` metadata (Infrastructure). Consumed by the create-order command (C2).

- [ ] **Step 1: Add gRPC client packages and the Protobuf reference**

```bash
cd services/orders
dotnet add src/Orders.Infrastructure package Grpc.Net.Client
dotnet add src/Orders.Infrastructure package Grpc.Tools
dotnet add src/Orders.Infrastructure package Google.Protobuf
```

Then add to `services/orders/src/Orders.Infrastructure/Orders.Infrastructure.csproj` (path is relative to the csproj; `GrpcServices="Client"` generates only the client):

```xml
<ItemGroup>
  <Protobuf Include="..\..\..\..\proto\users.proto" GrpcServices="Client" Link="Protos\users.proto" />
</ItemGroup>
```

- [ ] **Step 2: Define the Application-layer port**

Create `services/orders/src/Orders.Application/Identity/IUserDirectory.cs`:

```csharp
namespace Orders.Application.Identity;

// Resolves the caller's Cognito sub to the internal usr_ id via Users. Returns
// null when the user does not exist. Application depends on this port, not gRPC.
public interface IUserDirectory
{
    Task<string?> ResolveInternalUserIdAsync(string cognitoSub, CancellationToken ct = default);
}
```

- [ ] **Step 3: Write the failing client test (against a real in-process gRPC server stub)**

Create `services/orders/tests/Orders.Tests/Infrastructure/UserDirectoryGrpcClientTests.cs`:

```csharp
using Grpc.Core;
using Grpc.Net.Client;
using Orders.Infrastructure.Grpc;
using Users.V1;   // generated namespace from users.proto (package users.v1)
using Xunit;

namespace Orders.Tests.Infrastructure;

public class UserDirectoryGrpcClientTests
{
    [Fact]
    public async Task Resolves_internal_id_and_sends_api_key()
    {
        string? seenApiKey = null;

        // Minimal in-process server implementing the generated Users.UsersBase.
        var impl = new StubUsers(md => seenApiKey = md.GetValue("x-api-key"));
        var server = new Server
        {
            Services = { Users.V1.Users.BindService(impl) },
            Ports = { new ServerPort("127.0.0.1", 0, ServerCredentials.Insecure) }
        };
        server.Start();
        var port = server.Ports.First().BoundPort;

        var channel = GrpcChannel.ForAddress($"http://127.0.0.1:{port}");
        var client = new UserDirectoryGrpcClient(new Users.V1.Users.UsersClient(channel), "test-key");

        var id = await client.ResolveInternalUserIdAsync("sub-123");

        Assert.Equal("usr_resolved", id);
        Assert.Equal("test-key", seenApiKey);
        await server.ShutdownAsync();
    }

    private sealed class StubUsers : Users.V1.Users.UsersBase
    {
        private readonly Action<Metadata> _onMetadata;
        public StubUsers(Action<Metadata> onMetadata) => _onMetadata = onMetadata;
        public override Task<UserResponse> GetUserById(GetUserByIdRequest request, ServerCallContext context)
        {
            _onMetadata(context.RequestHeaders);
            return Task.FromResult(new UserResponse { Id = "usr_resolved", CognitoSub = request.Id });
        }
    }
}
```

> The generated C# namespace is derived from the proto `package users.v1` → `Users.V1`. If codegen yields a different casing, align the `using` to whatever `dotnet build` generates (check `obj/**/Users.cs`).

- [ ] **Step 4: Run it to verify it fails**

Run: `cd services/orders && dotnet test --filter UserDirectoryGrpcClientTests`
Expected: FAIL — `UserDirectoryGrpcClient` does not exist (and possibly the generated client until Step 5's build).

- [ ] **Step 5: Implement the gRPC client adapter**

Create `services/orders/src/Orders.Infrastructure/Grpc/UserDirectoryGrpcClient.cs`:

```csharp
using Grpc.Core;
using Orders.Application.Identity;
using Users.V1;

namespace Orders.Infrastructure.Grpc;

// Adapts the generated Users gRPC client to the Application port. Attaches the
// shared x-api-key on every call. NOT_FOUND → null (user does not exist).
public class UserDirectoryGrpcClient : IUserDirectory
{
    private readonly Users.V1.Users.UsersClient _client;
    private readonly string _apiKey;

    public UserDirectoryGrpcClient(Users.V1.Users.UsersClient client, string apiKey)
    {
        _client = client;
        _apiKey = apiKey;
    }

    public async Task<string?> ResolveInternalUserIdAsync(string cognitoSub, CancellationToken ct = default)
    {
        var metadata = new Metadata { { "x-api-key", _apiKey } };
        try
        {
            var response = await _client.GetUserByIdAsync(
                new GetUserByIdRequest { Id = cognitoSub },
                headers: metadata,
                cancellationToken: ct);
            return response.Id;
        }
        catch (RpcException ex) when (ex.StatusCode == StatusCode.NotFound)
        {
            return null;
        }
    }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd services/orders && dotnet test --filter UserDirectoryGrpcClientTests`
Expected: PASS — the api key is observed server-side and the internal id resolves.

- [ ] **Step 7: Commit**

```bash
git add services/orders/src/Orders.Infrastructure services/orders/src/Orders.Application/Identity services/orders/tests/Orders.Tests/Infrastructure/UserDirectoryGrpcClientTests.cs
git commit -m "feat(orders): gRPC client for Users identity resolution with x-api-key"
```

---

### Task C2: Create-order command — transactional, stock decrement with FOR UPDATE

**Files:**
- Create: `services/orders/src/Orders.Application/Orders/CreateOrderCommand.cs`
- Create: `services/orders/src/Orders.Application/Orders/CreateOrderService.cs`
- Create: `services/orders/src/Orders.Application/Abstractions/InsufficientStockException.cs`
- Create: `services/orders/src/Orders.Application/Abstractions/UnknownUserException.cs`
- Create: `services/orders/src/Orders.Infrastructure/Messaging/NoopEventPublisher.cs`
- Create: `services/orders/src/Orders.Application/Abstractions/IEventPublisher.cs`
- Test: `services/orders/tests/Orders.Tests/Application/CreateOrderServiceTests.cs` (Testcontainers)

**Interfaces:**
- Consumes: `IUserDirectory` (C1), `OrdersWriteDbContext` (B4), `OrderPricing` (B3), `NanoId` (B4).
- Produces: `CreateOrderService.CreateAsync(CreateOrderCommand, string cognitoSub) : Task<string>` (returns new `ord_` id); throws `UnknownUserException` (→ 404/401 at the API) and `InsufficientStockException` (→ 409). `IEventPublisher.PublishOrderCreatedAsync(...)`.

- [ ] **Step 1: Write the failing create-order test (stock decrement + insufficient stock)**

Create `services/orders/tests/Orders.Tests/Application/CreateOrderServiceTests.cs`:

```csharp
using Microsoft.EntityFrameworkCore;
using Orders.Application.Abstractions;
using Orders.Application.Identity;
using Orders.Application.Orders;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;
using Orders.Infrastructure.Messaging;
using Orders.Infrastructure.Persistence;
using Testcontainers.MySql;
using Xunit;

namespace Orders.Tests.Application;

public class CreateOrderServiceTests : IAsyncLifetime
{
    private readonly MySqlContainer _mysql = new MySqlBuilder().WithDatabase("orders").Build();
    public Task InitializeAsync() => _mysql.StartAsync();
    public Task DisposeAsync() => _mysql.DisposeAsync().AsTask();

    private OrdersWriteDbContext Ctx()
    {
        var cs = _mysql.GetConnectionString();
        return new OrdersWriteDbContext(new DbContextOptionsBuilder<OrdersWriteDbContext>()
            .UseMySql(cs, ServerVersion.AutoDetect(cs)).Options);
    }

    private sealed class FixedDirectory : IUserDirectory
    {
        private readonly string? _id;
        public FixedDirectory(string? id) => _id = id;
        public Task<string?> ResolveInternalUserIdAsync(string sub, CancellationToken ct = default) => Task.FromResult(_id);
    }

    private async Task<string> SeedProduct(uint stock, long priceCents)
    {
        await using var db = Ctx();
        await db.Database.MigrateAsync();
        var id = NanoId.NewId(NanoId.ProductPrefix);
        db.Products.Add(new Product { Id = id, Name = "P", Description = "d", UnitPriceCents = priceCents, UnitsInStock = stock, CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow });
        await db.SaveChangesAsync();
        return id;
    }

    [Fact]
    public async Task Creates_order_and_decrements_stock()
    {
        var productId = await SeedProduct(stock: 10, priceCents: 1000);
        await using var db = Ctx();
        var svc = new CreateOrderService(db, new FixedDirectory("usr_a"), new NoopEventPublisher(), taxRate: 0.10m);

        var orderId = await svc.CreateAsync(
            new CreateOrderCommand(new[] { new CreateOrderLine(productId, 3) }), "sub-a");

        Assert.StartsWith("ord_", orderId);
        var product = await db.Products.FirstAsync(p => p.Id == productId);
        Assert.Equal(7u, product.UnitsInStock);         // 10 - 3
        var order = await db.Orders.Include(o => o.Details).FirstAsync(o => o.Id == orderId);
        Assert.Equal("usr_a", order.UserId);
        Assert.Equal("sub-a", order.CognitoSub);
        Assert.Equal(3000, order.SubtotalCents);         // 3 * 1000
        Assert.Equal(300, order.TaxCents);               // 10%
        Assert.Equal(3300, order.TotalCents);
    }

    [Fact]
    public async Task Rejects_when_stock_insufficient()
    {
        var productId = await SeedProduct(stock: 2, priceCents: 1000);
        await using var db = Ctx();
        var svc = new CreateOrderService(db, new FixedDirectory("usr_a"), new NoopEventPublisher(), taxRate: 0.10m);

        await Assert.ThrowsAsync<InsufficientStockException>(() =>
            svc.CreateAsync(new CreateOrderCommand(new[] { new CreateOrderLine(productId, 5) }), "sub-a"));

        var product = await db.Products.FirstAsync(p => p.Id == productId);
        Assert.Equal(2u, product.UnitsInStock);          // unchanged — full rollback
    }

    [Fact]
    public async Task Rejects_unknown_user()
    {
        var productId = await SeedProduct(stock: 10, priceCents: 1000);
        await using var db = Ctx();
        var svc = new CreateOrderService(db, new FixedDirectory(null), new NoopEventPublisher(), taxRate: 0.10m);

        await Assert.ThrowsAsync<UnknownUserException>(() =>
            svc.CreateAsync(new CreateOrderCommand(new[] { new CreateOrderLine(productId, 1) }), "sub-x"));
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd services/orders && dotnet test --filter CreateOrderServiceTests`
Expected: FAIL — command/service/exceptions do not exist.

- [ ] **Step 3: Implement command, ports, exceptions, publisher**

Create `services/orders/src/Orders.Application/Orders/CreateOrderCommand.cs`:

```csharp
namespace Orders.Application.Orders;

public record CreateOrderLine(string ProductId, uint Quantity);
public record CreateOrderCommand(IReadOnlyList<CreateOrderLine> Lines);
```

Create `services/orders/src/Orders.Application/Abstractions/InsufficientStockException.cs`:

```csharp
namespace Orders.Application.Abstractions;

public class InsufficientStockException : Exception
{
    public InsufficientStockException(string productId)
        : base($"insufficient stock for product {productId}") { }
}
```

Create `services/orders/src/Orders.Application/Abstractions/UnknownUserException.cs`:

```csharp
namespace Orders.Application.Abstractions;

public class UnknownUserException : Exception
{
    public UnknownUserException(string cognitoSub)
        : base($"no internal user for cognito sub {cognitoSub}") { }
}
```

Create `services/orders/src/Orders.Application/Abstractions/IEventPublisher.cs`:

```csharp
namespace Orders.Application.Abstractions;

public interface IEventPublisher
{
    Task PublishOrderCreatedAsync(string orderId, string userId, long totalCents, DateTime createdAt, CancellationToken ct = default);
}
```

Create `services/orders/src/Orders.Infrastructure/Messaging/NoopEventPublisher.cs`:

```csharp
using Orders.Application.Abstractions;

namespace Orders.Infrastructure.Messaging;

// ORDER_CREATED emission seam. SQS wiring is deferred (mirrors Users' NoopEventPublisher).
public class NoopEventPublisher : IEventPublisher
{
    public Task PublishOrderCreatedAsync(string orderId, string userId, long totalCents, DateTime createdAt, CancellationToken ct = default)
        => Task.CompletedTask;
}
```

- [ ] **Step 4: Implement the transactional create-order service**

Create `services/orders/src/Orders.Application/Orders/CreateOrderService.cs`:

```csharp
using Microsoft.EntityFrameworkCore;
using Orders.Application.Abstractions;
using Orders.Application.Identity;
using Orders.Domain.Entities;
using Orders.Domain.Pricing;
using Orders.Infrastructure.Id;
using Orders.Infrastructure.Persistence;

namespace Orders.Application.Orders;

// Every write runs inside a transaction. Resolves identity via gRPC, locks each
// product row FOR UPDATE, validates + decrements stock, persists order+lines with
// BOTH identifiers, emits ORDER_CREATED. Any failure rolls the whole thing back.
public class CreateOrderService
{
    private readonly OrdersWriteDbContext _db;
    private readonly IUserDirectory _users;
    private readonly IEventPublisher _events;
    private readonly decimal _taxRate;

    public CreateOrderService(OrdersWriteDbContext db, IUserDirectory users, IEventPublisher events, decimal taxRate)
    {
        _db = db;
        _users = users;
        _events = events;
        _taxRate = taxRate;
    }

    public async Task<string> CreateAsync(CreateOrderCommand command, string cognitoSub, CancellationToken ct = default)
    {
        var userId = await _users.ResolveInternalUserIdAsync(cognitoSub, ct)
            ?? throw new UnknownUserException(cognitoSub);

        await using var tx = await _db.Database.BeginTransactionAsync(ct);

        var now = DateTime.UtcNow;
        var order = new Order
        {
            Id = NanoId.NewId(NanoId.OrderPrefix),
            UserId = userId,
            CognitoSub = cognitoSub,
            CreatedBy = userId,
            CreatedAt = now,
            UpdatedAt = now,
        };

        long subtotal = 0, tax = 0, total = 0;

        foreach (var line in command.Lines)
        {
            // Pessimistic lock so concurrent orders cannot oversell.
            var product = await _db.Products
                .FromSqlInterpolated($"SELECT * FROM product WHERE id = {line.ProductId} FOR UPDATE")
                .FirstOrDefaultAsync(ct)
                ?? throw new InsufficientStockException(line.ProductId);

            if (product.UnitsInStock < line.Quantity)
                throw new InsufficientStockException(line.ProductId);

            var (lineSub, lineTax, lineTotal) = OrderPricing.PriceLine(product.UnitPriceCents, line.Quantity, _taxRate);
            subtotal += lineSub; tax += lineTax; total += lineTotal;

            product.UnitsInStock -= line.Quantity;
            product.UpdatedAt = now;

            order.Details.Add(new OrderDetail
            {
                Id = NanoId.NewId(NanoId.OrderDetailPrefix),
                OrderId = order.Id,
                ProductId = product.Id,
                UserId = userId,
                CognitoSub = cognitoSub,
                Quantity = line.Quantity,
                SubtotalCents = lineSub,
                TaxCents = lineTax,
                TotalCents = lineTotal,
                CreatedBy = userId,
                CreatedAt = now,
                UpdatedAt = now,
            });
        }

        order.SubtotalCents = subtotal;
        order.TaxCents = tax;
        order.TotalCents = total;

        _db.Orders.Add(order);
        await _db.SaveChangesAsync(ct);
        await _events.PublishOrderCreatedAsync(order.Id, userId, total, now, ct);
        await tx.CommitAsync(ct);

        return order.Id;
    }
}
```

> `FromSqlInterpolated` parameterizes `{line.ProductId}` (no SQL injection). `FOR UPDATE` requires a real transaction on MySQL (InnoDB) — provided by `BeginTransactionAsync`. The `AnyAsync`-less path means a missing product also throws `InsufficientStockException`; if a distinct 404-for-unknown-product is wanted later, split the exception — out of scope now.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd services/orders && dotnet test --filter CreateOrderServiceTests`
Expected: PASS (3 tests) — order created + stock decremented; insufficient stock rolls back; unknown user throws.

- [ ] **Step 6: Commit**

```bash
git add services/orders/src/Orders.Application services/orders/src/Orders.Infrastructure/Messaging services/orders/tests/Orders.Tests/Application/CreateOrderServiceTests.cs
git commit -m "feat(orders): transactional create-order with FOR UPDATE stock decrement"
```

---

### Task C3: POST endpoint + error mapping + full DI wiring

**Files:**
- Create: `services/orders/src/Orders.Api/Endpoints/CreateOrderEndpoint.cs`
- Modify: `services/orders/src/Orders.Api/Endpoints/OrderEndpoints.cs` (register POST)
- Modify: `services/orders/src/Orders.Api/Program.cs` (write context, gRPC client, services, config)
- Test: `services/orders/tests/Orders.Tests/Api/CreateOrderEndpointTests.cs` (WebApplicationFactory + Testcontainers)

**Interfaces:**
- Consumes: `CreateOrderService` (C2), `CallerIdentity` (B6).
- Produces: `POST /v1/orders` → 201 with the created order (cents), 401 no header, 404 unknown user, 409 insufficient stock.

- [ ] **Step 1: Write the failing endpoint test**

Create `services/orders/tests/Orders.Tests/Api/CreateOrderEndpointTests.cs`:

```csharp
using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace Orders.Tests.Api;

public class CreateOrderEndpointTests : IClassFixture<OrdersApiFactory>
{
    private readonly OrdersApiFactory _factory;
    public CreateOrderEndpointTests(OrdersApiFactory factory) => _factory = factory;

    [Fact]
    public async Task Post_without_user_header_is_401()
    {
        var client = _factory.CreateClient();
        var resp = await client.PostAsJsonAsync("/v1/orders", new { lines = new[] { new { productId = "prd_x", quantity = 1 } } });
        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }
}
```

> `OrdersApiFactory` is a `WebApplicationFactory<Program>` that points the write/read contexts at a Testcontainers MySQL and injects a stub `IUserDirectory`. Implement it alongside this test, mirroring the container setup from Task C2's fixture. Keep it minimal — one product seeded, one known cognito sub.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd services/orders && dotnet test --filter CreateOrderEndpointTests`
Expected: FAIL — no POST route (404) or factory/DI not wired.

- [ ] **Step 3: Implement the POST endpoint with error mapping**

Create `services/orders/src/Orders.Api/Endpoints/CreateOrderEndpoint.cs`:

```csharp
using Orders.Api.Identity;
using Orders.Application.Abstractions;
using Orders.Application.Orders;

namespace Orders.Api.Endpoints;

public record CreateOrderRequest(IReadOnlyList<CreateOrderLine> Lines);

public static class CreateOrderEndpoint
{
    public static async Task<IResult> Handle(HttpContext ctx, CreateOrderRequest body, CreateOrderService service)
    {
        var sub = CallerIdentity.CognitoSub(ctx);
        if (sub is null) return Results.Unauthorized();

        try
        {
            var orderId = await service.CreateAsync(new CreateOrderCommand(body.Lines), sub);
            return Results.Created($"/v1/orders/{orderId}", new { id = orderId });
        }
        catch (UnknownUserException)
        {
            return Results.NotFound(new { error = "unknown_user" });
        }
        catch (InsufficientStockException ex)
        {
            return Results.Conflict(new { error = "insufficient_stock", detail = ex.Message });
        }
    }
}
```

Register it in `OrderEndpoints.MapOrderEndpoints` (add inside the existing group):

```csharp
group.MapPost("", CreateOrderEndpoint.Handle);
```

- [ ] **Step 4: Complete Program.cs DI wiring**

Extend `services/orders/src/Orders.Api/Program.cs` to register the write context, the gRPC client, the create-order service, and config (tax rate, gRPC address + api key). Add before `builder.Build()`:

```csharp
var writerCs = builder.Configuration["DATABASE_WRITER_URL"]!;
builder.Services.AddDbContext<OrdersWriteDbContext>(o =>
    o.UseMySql(writerCs, ServerVersion.AutoDetect(writerCs)));

var grpcAddress = builder.Configuration["USERS_GRPC_URL"]!;   // e.g. http://users:50051
var grpcApiKey = builder.Configuration["GRPC_API_KEY"]!;
builder.Services.AddSingleton(_ =>
    new Users.V1.Users.UsersClient(Grpc.Net.Client.GrpcChannel.ForAddress(grpcAddress)));
builder.Services.AddScoped<Orders.Application.Identity.IUserDirectory>(sp =>
    new Orders.Infrastructure.Grpc.UserDirectoryGrpcClient(sp.GetRequiredService<Users.V1.Users.UsersClient>(), grpcApiKey));
builder.Services.AddScoped<Orders.Application.Abstractions.IEventPublisher, Orders.Infrastructure.Messaging.NoopEventPublisher>();

var taxRate = decimal.Parse(builder.Configuration["ORDERS_TAX_RATE"] ?? "0.08");
builder.Services.AddScoped(sp => new CreateOrderService(
    sp.GetRequiredService<OrdersWriteDbContext>(),
    sp.GetRequiredService<Orders.Application.Identity.IUserDirectory>(),
    sp.GetRequiredService<Orders.Application.Abstractions.IEventPublisher>(),
    taxRate));
```

- [ ] **Step 5: Run the endpoint test to verify it passes**

Run: `cd services/orders && dotnet test --filter CreateOrderEndpointTests`
Expected: PASS.

- [ ] **Step 6: Full build + test + lint**

Run: `cd services/orders && dotnet build && dotnet test && dotnet format --verify-no-changes`
Expected: build clean, all tests pass, format clean.

- [ ] **Step 7: Commit**

```bash
git add services/orders/src/Orders.Api services/orders/tests/Orders.Tests/Api
git commit -m "feat(orders): POST /v1/orders with 401/404/409 error mapping and full DI"
```

---

### Task C4: E2E surface (flag-guarded) — mirror Users

**Files:**
- Create: `services/orders/src/Orders.Api/Endpoints/E2eEndpoints.cs`
- Modify: `services/orders/src/Orders.Api/Program.cs` (map only when `E2E_TESTING_ENABLED`)

**Interfaces:**
- Produces: `DELETE /v1/orders/e2e-cleanup` (soft-deletes test orders) and a seed trigger, guarded by `E2E_TESTING_ENABLED`, for a future cross-service E2E.

- [ ] **Step 1: Implement the flag-guarded endpoints**

Create `services/orders/src/Orders.Api/Endpoints/E2eEndpoints.cs`:

```csharp
using Microsoft.EntityFrameworkCore;
using Orders.Infrastructure.Persistence;

namespace Orders.Api.Endpoints;

// Only mapped when E2E_TESTING_ENABLED. Mirrors the Users e2e-cleanup pattern.
public static class E2eEndpoints
{
    public static void MapE2eEndpoints(this WebApplication app)
    {
        app.MapDelete("/v1/orders/e2e-cleanup", async (HttpContext ctx, OrdersWriteDbContext db) =>
        {
            var sub = ctx.Request.Headers["x-user-id"].FirstOrDefault();
            if (sub is null) return Results.Unauthorized();
            var now = DateTime.UtcNow;
            // Soft-delete this caller's orders (never physical DELETE).
            await db.Orders.Where(o => o.CognitoSub == sub)
                .ExecuteUpdateAsync(s => s.SetProperty(o => o.DeletedAt, now).SetProperty(o => o.DeletedBy, "e2e"));
            return Results.NoContent();
        });
    }
}
```

- [ ] **Step 2: Map it conditionally in Program.cs**

Add after `app.MapOrderEndpoints();`:

```csharp
if (builder.Configuration.GetValue<bool>("E2E_TESTING_ENABLED"))
{
    app.MapE2eEndpoints();
}
```

- [ ] **Step 3: Build + test**

Run: `cd services/orders && dotnet build && dotnet test`
Expected: build clean, tests pass.

- [ ] **Step 4: Commit**

```bash
git add services/orders/src/Orders.Api/Endpoints/E2eEndpoints.cs services/orders/src/Orders.Api/Program.cs
git commit -m "feat(orders): flag-guarded E2E cleanup endpoint (soft-delete)"
```

---

### Task C5: Local infra — compose MySQL, Dockerfile, Makefile bootstrap

**Files:**
- Modify: `services/orders/Dockerfile` (real .NET build)
- Modify: `docker-compose.yml` (orders: DB URLs, gRPC address, ports, healthcheck)
- Modify: `Makefile` (orders migrate + seed in the bootstrap chain)
- Modify: `services/orders/CLAUDE.md` (Clean Architecture; commands; remove screaming-arch mention)

**Interfaces:**
- Produces: `docker compose up orders` runs the live service on MySQL via Floci, migrations + seed applied, reachable for `/v1/health`.

- [ ] **Step 1: Write the real Dockerfile**

Replace `services/orders/Dockerfile` with a multi-stage .NET build (SDK build → runtime), building `src/Orders.Api`, exposing the HTTP port, entrypoint `dotnet Orders.Api.dll`. Base images `mcr.microsoft.com/dotnet/sdk:10.0` and `mcr.microsoft.com/dotnet/aspnet:10.0`.

- [ ] **Step 2: Wire the orders service in compose**

In `docker-compose.yml` under `orders:`, add (mirroring the Users DB-URL comments; Floci fronts MySQL on its proxy port — confirm the port Floci exposes for the Aurora-MySQL cluster and use it):

```yaml
    ports:
      - "3001:8080"
    environment:
      - DATABASE_WRITER_URL=Server=floci;Port=<mysql-proxy-port>;Database=orders;User=test;Password=test;
      - DATABASE_READER_URL=Server=floci;Port=<mysql-proxy-port>;Database=orders;User=test;Password=test;
      - USERS_GRPC_URL=http://users:50051
      - GRPC_API_KEY=local-dev-grpc-key
      - ORDERS_TAX_RATE=0.08
      - E2E_TESTING_ENABLED=true
    depends_on:
      floci:
        condition: service_healthy
      users:
        condition: service_started
```

> `GRPC_API_KEY` MUST equal the value set on the `users` service in Task A4 (`local-dev-grpc-key`) — the interceptor compares them. The MySQL proxy port is whatever Floci exposes for the Aurora-MySQL cluster; verify with `docker compose exec floci ...` or the Floci skill, the same way Users found Postgres on `:7001`.

- [ ] **Step 3: Add the orders migrate+seed to the Makefile bootstrap**

Add an `orders` migration step to the `migrate` chain (parallel to Users): apply `dotnet ef database update` against the composed MySQL and run the seed on startup. If seed-on-startup is done in `Program.cs` (apply `ProductSeed` after `MigrateAsync` when a `SEED_ON_STARTUP` flag is set), document that instead — pick ONE and make it explicit here.

- [ ] **Step 4: Verify the service comes up healthy**

Run: `make infra-up 2>/dev/null || docker compose up orders --build -d; sleep 8; curl -sf http://localhost:3001/v1/health`
Expected: `{"status":"ok"}`.

- [ ] **Step 5: Update services/orders/CLAUDE.md**

Rewrite section 3 (folder structure) to the Clean Architecture solution layout; remove the "screaming architecture" line; update commands to the real `dotnet` ones; note money-in-cents, the gRPC client with `x-api-key`, and the read/write DbContext split. Keep referencing shared conventions by link.

- [ ] **Step 6: Commit**

```bash
git add services/orders/Dockerfile docker-compose.yml Makefile services/orders/CLAUDE.md
git commit -m "feat(orders): live local service on MySQL via Floci with migrate+seed bootstrap"
```

---

## Self-review — spec coverage

- Scope (HTTP+persistence, Product seed no-CRUD, Noop events, transactions-always) → A/B/C tasks. ✓
- Clean Architecture, 5 Class Libraries, CQRS read/write contexts → B1, B4, C3. ✓
- Money in cents (bigint, `_cents`, computed dollars, API in cents) → Global Constraints, B2, B3, DTOs. ✓
- Double identity (`user_id` + `cognito_sub` on both tables) → B2, B4, C2. ✓
- Ownership by query filter → 404; reads filter by `cognito_sub`, no gRPC → B6. ✓
- Stock: FOR UPDATE, 409, full rollback → C2. ✓
- Identity on POST via gRPC (Cognito sub → internal id) → C1, C2. ✓
- gRPC gate: shared `.proto`, `@grpc/grpc-js` server, x-api-key interceptor (constant-time), UNAUTHENTICATED → A1–A4. ✓
- Orders gRPC client via Grpc.Tools, x-api-key metadata, NOT_FOUND→null → C1. ✓
- Testing: unit (Domain/App) + Testcontainers-MySQL integration; E2E flag-guarded like Users → B2/B3 unit, B5/B6/C2/C3 integration, C4 E2E. ✓
- Local infra: MySQL via Floci, two DB URLs, migrate+seed bootstrap, docker-watch, health → C5. ✓
- Sequencing gate (A before C) → phase headers + C gate note. ✓

## Related

- [[2026-07-14-orders-service-milestone-design]]
- [[orders-service-design]]
- [[users-service-design]]
- [[soft-delete]]
- [[nano-id]]
- [[audit-fields]]
- [[db-naming]]
- [[cqrs]]
- [[versioning]]
- [[ADR-0003-grpc-inter-service]]
- [[ADR-0006-read-write-replicas]]
- [[ADR-0010-cognito-auth]]
