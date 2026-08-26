---
title: Account Deletion Implementation Plan
type: plan
area: users
status: active
created: 2026-08-25
updated: 2026-08-25
tags:
  - type/plan
  - area/users
  - area/orders
  - area/tracking
  - status/active
propagates-to:
  - "[[users-service-design]]"
  - "[[orders-service-design]]"
  - "[[tracking-service-design]]"
  - "[[soft-delete]]"
related:
  - "[[2026-08-25-account-deletion-design]]"
  - "[[ADR-0004-soft-delete-only]]"
  - "[[soft-delete]]"
  - "[[audit-fields]]"
  - "[[testing]]"
  - "[[git-workflow]]"
---

# Account Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user delete their own account via `DELETE /v1/users/me`, cascading a soft delete to their orders and tracking data, and freeing their email address so they can register again.

**Architecture:** Users exposes one authenticated endpoint. It calls two new **internal** HTTP routes — `DELETE /v1/orders/by-user` and `DELETE /v1/trackings/by-user` — guarded by the shared `GRPC_API_KEY`, then soft-deletes its own row and deletes the Cognito user. A partial unique index on `users.email` (`WHERE deleted_at IS NULL`) is what makes re-registration with the same address possible while the old row is preserved intact.

**Tech Stack:** Fastify + Prisma 7.8 + Postgres (Users) · .NET 10 Minimal APIs + EF Core + MySQL (Orders) · FastAPI + SQLAlchemy + MySQL (Tracking) · Terraform (API Gateway) · Vitest / xUnit+Testcontainers / pytest · Playwright (E2E).

**Spec:** `docs/superpowers/specs/2026-08-25-account-deletion-design.md`

## Global Constraints

- **Node**: run `nvm use` before ANY node/pnpm command — the repo pins **24.18.0** via `.nvmrc`. Prisma's CLI crashes on Node 20 in this repo (`ERR_REQUIRE_ESM` from `@prisma/dev`).
- **Package manager**: `pnpm` only. Never `npm` or `yarn`.
- **Soft delete only** ([[ADR-0004-soft-delete-only]]): never issue SQL `DELETE`. The DB write users have no `DELETE` grant in any of the three services. The one deliberate exception to the *letter* of this rule is Cognito's `AdminDeleteUser` — Cognito is an external identity provider, not our database, and deleting the sub is what frees the email.
- **Ownership key is `cognito_sub`, never `user_id`** in Orders and Tracking. A cascade keyed on `user_id` compiles, runs, and matches nothing. Tracking additionally falls back to `user_id` because its `cognito_sub` is nullable on rows predating migration `b17f4c2e9a30`.
- **Both internal routes must be idempotent** — every soft-delete statement is guarded by `deleted_at IS NULL`, so a retry after a partial failure is a no-op on the leg that already succeeded.
- **Audit actor format**: `<source>:<action>`. New actors: `users_api:delete_account`, `orders_api:delete_by_user`, `tracking_api:delete_by_user`.
- **openapi.yaml is a generated, committed build artifact** in all three services and is verified by tests. Regenerating it is part of the task that changes a route, not a follow-up.
- **Never log** a plaintext email, a password, a token, or an API key. Auth flows log a masked email (`jo*****e@gmail.com`); everything else uses `email_hash`.
- **Response cache is OUT OF SCOPE, by decision.** The Response Caching Layer milestone (JE-196/197/199/200) is unfinished and its code is not on this branch — there is nothing here to invalidate. When Orders' and Tracking's identity caches land, they must add deletion-driven invalidation. Task 10 records this as an explicit dependency so it does not become invisible debt.

---

## File Structure

**Users** (`services/users/`)
- Modify `prisma/schema.prisma` — enable `partialIndexes`, swap `email @unique` for a partial `@@unique`.
- Create `prisma/migrations/<timestamp>_partial_unique_email/migration.sql` — generated.
- Modify `src/shared/audit/audit-actor.ts` — add `DeleteAccount`.
- Modify `src/shared/auth/auth-provider.ts` — add `deleteUser` to the port.
- Modify `src/shared/auth/cognito-auth-provider.ts` — implement it with `AdminDeleteUserCommand`.
- Create `src/shared/http/cascade-client.ts` — the first plain-HTTP outbound client in Users (today it only speaks gRPC + AWS SDK + Redis).
- Create `src/features/users/commands/delete-account.ts` — orchestrates the four ordered steps.
- Modify `src/shared/di/awilix-container.ts` — three edit points.
- Modify `src/features/users/http/routes.ts` — the route.
- Modify `src/shared/config/env.ts` — `ORDERS_BASE_URL`, `TRACKING_BASE_URL`.
- Tests: `tests/features/users/commands/delete-account.test.ts`, `tests/shared/http/cascade-client.test.ts`.

**Orders** (`services/orders/`)
- Create `src/Orders.Api/Identity/InternalApiKey.cs` — inbound key check (Orders has **none** today).
- Modify `src/Orders.Api/Identity/PublicRoutes.cs` — exempt the internal route from `x-user-id`.
- Create `src/Orders.Api/Endpoints/InternalEndpoints.cs` — the route.
- Modify `src/Orders.Application/Abstractions/AuditActor.cs` — add `DeleteByUser`.
- Modify `src/Orders.Api/Program.cs` — map the endpoint.
- Tests: `tests/Orders.Tests/Api/InternalDeleteByUserTests.cs`.

**Tracking** (`services/tracking/`)
- Create `src/shared/http/internal_auth.py` — inbound key check against `grpc_api_key`.
- Create `src/features/tracking/api/internal_router.py` — the route.
- Create `src/features/tracking/commands/delete_by_user.py` — the command.
- Modify `src/features/tracking/domain/repository.py` — add `soft_delete_by_user`.
- Modify `src/shared/audit/audit_actor.py` — add `DELETE_BY_USER`.
- Modify `src/features/tracking/api/schemas.py` — response model.
- Modify `src/main.py` — register the router **before** `trackings_router`.
- Tests: `tests/test_rest_internal_delete.py`, plus repository cases in `tests/test_repository.py`.

**Infra & E2E**
- Modify `infra/modules/api-gateway/main.tf` — `delete_me` route. nginx needs **no** change.
- Modify `infra/environments/local/scripts/generate_env_files.py` — Users gains `ORDERS_BASE_URL`/`TRACKING_BASE_URL`.
- Modify `.env.example`.
- Create `e2e/tests/account-deletion.spec.ts` (internal) and `e2e/tests/gateway/account-deletion.spec.ts` (gateway, real JWT).

---

### Task 1: Partial unique index on `users.email`

This is what makes re-registration possible. Verified working against the installed Prisma 7.8.0 before this plan was written.

**Files:**
- Modify: `services/users/prisma/schema.prisma:1-4` (generator), `:21` (email), `:52-53` (index block)
- Create: `services/users/prisma/migrations/<timestamp>_partial_unique_email/migration.sql`
- Test: `services/users/tests/shared/db/partial-unique-email.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the DB invariant "at most one LIVE user per email address". Every later task depends on it; Task 8's gateway E2E is what proves it end to end.

- [ ] **Step 1: Enable the preview feature and swap the constraint**

In `services/users/prisma/schema.prisma`, replace the generator block:

```prisma
generator client {
  provider        = "prisma-client"
  output          = "../src/generated/prisma"
  previewFeatures = ["partialIndexes"]
}
```

Change line 21 from `  email       String    @unique` to:

```prisma
  email       String
```

And in the `User` model's attribute block, add the partial unique index next to the existing index:

```prisma
  @@map("users")
  // A soft-deleted row keeps its real email (no tombstoning — the historical
  // value is the point), so a plain @unique would permanently burn the address
  // and make re-registration impossible. Postgres scopes the constraint to live
  // rows instead. This is the Postgres equivalent of the STORED generated-column
  // trick Orders uses for the cart's one-active-cart invariant.
  @@unique([email], where: raw("deleted_at IS NULL"))
  @@index([deletedAt])
```

- [ ] **Step 2: Verify the schema parses**

Run: `cd services/users && nvm use && DATABASE_WRITER_URL="postgresql://u:p@localhost:5432/db" node node_modules/prisma/build/index.js validate`
Expected: `The schema at prisma/schema.prisma is valid 🚀`

- [ ] **Step 3: Generate the migration**

Run: `cd services/users && nvm use && pnpm prisma migrate dev --name partial_unique_email --create-only`

Expected generated SQL (verify it matches; the index name may differ):

```sql
-- DropIndex
DROP INDEX "users_email_key";

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email") WHERE (deleted_at IS NULL);
```

- [ ] **Step 4: Write the failing test**

Create `services/users/tests/shared/db/partial-unique-email.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Guards the invariant that makes re-registration with a reused email possible.
// A future edit that restores a plain `@unique` on email would silently break
// account deletion's headline requirement, and no runtime test would catch it
// until a gateway E2E ran against a real Postgres.
describe("users.email uniqueness", () => {
  const schema = readFileSync(
    resolve(import.meta.dirname, "../../../prisma/schema.prisma"),
    "utf8",
  );

  it("scopes the unique constraint to live rows", () => {
    expect(schema).toContain('@@unique([email], where: raw("deleted_at IS NULL"))');
  });

  it("does not carry a plain @unique on email", () => {
    expect(schema).not.toMatch(/^\s*email\s+String\s+@unique/m);
  });

  it("enables the partialIndexes preview feature", () => {
    expect(schema).toContain('previewFeatures = ["partialIndexes"]');
  });
});
```

- [ ] **Step 5: Run the test**

Run: `cd services/users && nvm use && pnpm test -- partial-unique-email`
Expected: PASS (the schema was already edited in Step 1).

- [ ] **Step 6: Apply the migration and prove the invariant against real Postgres**

Run: `nvm use && make migrate`
Then verify by hand against the local DB — two live rows with one email must fail, a deleted one plus a live one must succeed:

```sql
INSERT INTO users (id, email, full_name, created_at, updated_at)
  VALUES ('usr_test_a', 'dup@example.com', 'A', now(), now());
-- must FAIL with a unique violation:
INSERT INTO users (id, email, full_name, created_at, updated_at)
  VALUES ('usr_test_b', 'dup@example.com', 'B', now(), now());
-- now soft-delete the first, and the second must SUCCEED:
UPDATE users SET deleted_at = now() WHERE id = 'usr_test_a';
INSERT INTO users (id, email, full_name, created_at, updated_at)
  VALUES ('usr_test_b', 'dup@example.com', 'B', now(), now());
DELETE FROM users WHERE id IN ('usr_test_a','usr_test_b'); -- cleanup only, superuser session
```

- [ ] **Step 7: Commit**

```bash
git add services/users/prisma/schema.prisma services/users/prisma/migrations services/users/tests/shared/db/partial-unique-email.test.ts
git commit -m "feat(users): scope the email unique constraint to live rows"
```

---

### Task 2: `deleteUser` on the auth port + Cognito adapter

**Files:**
- Modify: `services/users/src/shared/auth/auth-provider.ts:20-67`
- Modify: `services/users/src/shared/auth/cognito-auth-provider.ts:1-11` (imports), and add the method
- Test: `services/users/tests/shared/auth/cognito-delete-user.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AuthProvider.deleteUser(email: string): Promise<void>` — consumed by Task 5's command. Throws `InvalidCredentialsError` when the account does not exist, matching every other method on this class.

- [ ] **Step 1: Write the failing test**

Create `services/users/tests/shared/auth/cognito-delete-user.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { AdminDeleteUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { CognitoAuthProvider } from "#shared/auth/cognito-auth-provider";
import { InvalidCredentialsError } from "#shared/auth/auth-errors";

function makeProvider(send: ReturnType<typeof vi.fn>) {
  return new CognitoAuthProvider({ send } as any, "pool-1", "client-1");
}

describe("CognitoAuthProvider.deleteUser", () => {
  it("sends AdminDeleteUserCommand for the given email", async () => {
    const send = vi.fn(async () => ({}));
    await makeProvider(send).deleteUser("a@b.co");

    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0][0];
    expect(sent).toBeInstanceOf(AdminDeleteUserCommand);
    expect(sent.input).toEqual({ UserPoolId: "pool-1", Username: "a@b.co" });
  });

  it("maps UserNotFoundException to InvalidCredentialsError", async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error("nope"), { name: "UserNotFoundException" });
    });
    await expect(makeProvider(send).deleteUser("a@b.co")).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it("rethrows any other error unchanged", async () => {
    const boom = Object.assign(new Error("boom"), { name: "InternalErrorException" });
    const send = vi.fn(async () => {
      throw boom;
    });
    await expect(makeProvider(send).deleteUser("a@b.co")).rejects.toBe(boom);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd services/users && nvm use && pnpm test -- cognito-delete-user`
Expected: FAIL — `provider.deleteUser is not a function`.

- [ ] **Step 3: Add the method to the port**

In `services/users/src/shared/auth/auth-provider.ts`, add to the `AuthProvider` interface, after `setMustChangePassword`:

```ts
  // Removes the Cognito account outright (AdminDeleteUser), which is what FREES
  // THE EMAIL for re-registration — the whole point of the delete-account flow.
  // Deliberately not AdminDisableUser: a disabled account keeps occupying its
  // email in the pool, so a returning user would hit UsernameExistsException
  // forever. [[ADR-0004-soft-delete-only]] governs our DATABASES, and the durable
  // record of the user is preserved there; Cognito is an external IdP.
  //
  // Throws InvalidCredentialsError when the account does not exist, like every
  // other method here — an unknown account must not be distinguishable by error
  // type alone.
  deleteUser(email: string): Promise<void>;
```

- [ ] **Step 4: Implement it**

In `services/users/src/shared/auth/cognito-auth-provider.ts`, add `AdminDeleteUserCommand` to the import block at the top:

```ts
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  AdminInitiateAuthCommand,
  RespondToAuthChallengeCommand,
  type CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
```

And add the method to the class:

```ts
  async deleteUser(email: string): Promise<void> {
    try {
      await this.client.send(
        new AdminDeleteUserCommand({
          UserPoolId: this.userPoolId,
          Username: email,
        }),
      );
    } catch (e: any) {
      if (e?.name === "UserNotFoundException") throw new InvalidCredentialsError();
      throw e;
    }
  }
```

- [ ] **Step 5: Run the test**

Run: `cd services/users && nvm use && pnpm test -- cognito-delete-user`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add services/users/src/shared/auth services/users/tests/shared/auth/cognito-delete-user.test.ts
git commit -m "feat(users): add deleteUser to the auth port and its Cognito adapter"
```

---

### Task 3: Orders internal `DELETE /v1/orders/by-user`

Orders has **no inbound API-key check today** — `GRPC_API_KEY` is only ever presented outbound. This task builds one.

**Files:**
- Create: `services/orders/src/Orders.Api/Identity/InternalApiKey.cs`
- Modify: `services/orders/src/Orders.Api/Identity/PublicRoutes.cs:18-27`
- Create: `services/orders/src/Orders.Api/Endpoints/InternalEndpoints.cs`
- Modify: `services/orders/src/Orders.Application/Abstractions/AuditActor.cs`
- Modify: `services/orders/src/Orders.Api/Program.cs:472-474`
- Test: `services/orders/tests/Orders.Tests/Api/InternalDeleteByUserTests.cs`

**Interfaces:**
- Consumes: nothing.
- Produces: `DELETE /v1/orders/by-user`, header `x-api-key: <GRPC_API_KEY>`, body `{"cognitoSub": "<sub>"}`, response `200 {"deleted": N, "deletedDetails": N, "deletedCarts": N}`. Task 5's cascade client calls exactly this.

- [ ] **Step 1: Write the failing test**

Create `services/orders/tests/Orders.Tests/Api/InternalDeleteByUserTests.cs`:

```csharp
using System.Net;
using System.Net.Http.Json;
using Microsoft.EntityFrameworkCore;
using Orders.Application.Abstractions;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;

namespace Orders.Tests.Api;

// The internal cascade route used by Users' DELETE /v1/users/me. It is NOT on the
// API Gateway and never sees an end-user JWT: its only credential is the shared
// internal GRPC_API_KEY.
public class InternalDeleteByUserTests : IClassFixture<OrdersE2eApiFactory>
{
    private const string Path = "/v1/orders/by-user";
    private readonly OrdersE2eApiFactory _factory;

    public InternalDeleteByUserTests(OrdersE2eApiFactory factory) => _factory = factory;

    private HttpRequestMessage Request(string sub, string? apiKey = "test-key")
    {
        var request = new HttpRequestMessage(HttpMethod.Delete, Path)
        {
            Content = JsonContent.Create(new { cognitoSub = sub }),
        };
        if (apiKey is not null) request.Headers.Add("x-api-key", apiKey);
        return request;
    }

    private async Task<string> SeedOrderAsync(string sub)
    {
        await using var db = _factory.NewContext();
        var orderId = NanoId.NewId(NanoId.OrderPrefix);
        db.Orders.Add(new Order
        {
            Id = orderId, UserId = "usr_x", CognitoSub = sub,
            SubtotalCents = 0, TaxCents = 0, TotalCents = 0,
        });
        await db.SaveChangesAsync();
        return orderId;
    }

    [Fact]
    public async Task Rejects_a_request_with_no_api_key()
    {
        var response = await _factory.CreateClient().SendAsync(Request("sub-x", apiKey: null));
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Rejects_a_request_with_a_wrong_api_key()
    {
        var response = await _factory.CreateClient().SendAsync(Request("sub-x", apiKey: "wrong"));
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Soft_deletes_the_users_orders_and_stamps_the_actor()
    {
        const string sub = "sub-cascade-1";
        var orderId = await SeedOrderAsync(sub);

        var response = await _factory.CreateClient().SendAsync(Request(sub));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        await using var db = _factory.NewContext();
        var order = await db.Orders.AsNoTracking().IgnoreQueryFilters()
            .FirstAsync(o => o.Id == orderId);
        Assert.NotNull(order.DeletedAt);
        Assert.Equal(AuditActor.DeleteByUser, order.DeletedBy);
    }

    [Fact]
    public async Task Does_not_touch_another_users_orders()
    {
        var mine = await SeedOrderAsync("sub-cascade-2");
        var theirs = await SeedOrderAsync("sub-untouched");

        await _factory.CreateClient().SendAsync(Request("sub-cascade-2"));

        await using var db = _factory.NewContext();
        Assert.NotNull((await db.Orders.AsNoTracking().IgnoreQueryFilters()
            .FirstAsync(o => o.Id == mine)).DeletedAt);
        Assert.Null((await db.Orders.AsNoTracking().IgnoreQueryFilters()
            .FirstAsync(o => o.Id == theirs)).DeletedAt);
    }

    [Fact]
    public async Task Is_idempotent_a_second_call_deletes_nothing_more()
    {
        const string sub = "sub-cascade-3";
        await SeedOrderAsync(sub);

        var first = await (await _factory.CreateClient().SendAsync(Request(sub)))
            .Content.ReadFromJsonAsync<InternalDeleteResponse>();
        var second = await (await _factory.CreateClient().SendAsync(Request(sub)))
            .Content.ReadFromJsonAsync<InternalDeleteResponse>();

        Assert.Equal(1, first!.Deleted);
        Assert.Equal(0, second!.Deleted);
    }

    [Fact]
    public async Task Returns_zero_for_a_user_with_nothing()
    {
        var response = await _factory.CreateClient().SendAsync(Request("sub-nothing-here"));
        var body = await response.Content.ReadFromJsonAsync<InternalDeleteResponse>();

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(0, body!.Deleted);
    }
}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd services/orders && dotnet test --filter InternalDeleteByUserTests`
Expected: FAIL — the route does not exist (401/404 mismatches, and `AuditActor.DeleteByUser` will not compile).

- [ ] **Step 3: Add the audit actor**

In `services/orders/src/Orders.Application/Abstractions/AuditActor.cs`, add to the class:

```csharp
    // DELETE /v1/orders/by-user — the account-deletion cascade from Users. Its own
    // actor rather than the end user's identity: a row removed because the account
    // was deleted must stay distinguishable from one the user removed themselves,
    // which is exactly what deleted_by exists to record.
    public const string DeleteByUser = "orders_api:delete_by_user";
```

- [ ] **Step 4: Add the inbound key check**

Create `services/orders/src/Orders.Api/Identity/InternalApiKey.cs`:

```csharp
using System.Security.Cryptography;
using System.Text;

namespace Orders.Api.Identity;

/// <summary>
/// Validates the shared internal service-to-service key (ADR-0003) on inbound
/// requests. Orders previously only ever PRESENTED this key outbound (to Users
/// over gRPC); the account-deletion cascade is the first surface that has to
/// verify it.
/// </summary>
/// <remarks>
/// Constant-time comparison, never <c>==</c>: string equality short-circuits at
/// the first differing byte, so its timing leaks how long a prefix an attacker
/// guessed. This mirrors Tracking's <c>hmac.compare_digest</c> and Users'
/// <c>timingSafeEqual</c>. A length mismatch returns early in every
/// implementation — the key's LENGTH leaks, its CONTENTS do not.
/// </remarks>
public static class InternalApiKey
{
    public const string HeaderName = "x-api-key";

    public static bool Matches(string? provided, string expected)
    {
        if (provided is null) return false;

        var a = Encoding.UTF8.GetBytes(provided);
        var b = Encoding.UTF8.GetBytes(expected);
        if (a.Length != b.Length) return false;

        return CryptographicOperations.FixedTimeEquals(a, b);
    }
}
```

- [ ] **Step 5: Exempt the route from the x-user-id guard**

`CallerContextMiddleware` 401s any non-public route without `x-user-id`, and it runs **before** the endpoint handler — so without this the key check would never be reached. In `services/orders/src/Orders.Api/Identity/PublicRoutes.cs`, add a third arm to `IsPublic`:

```csharp
        || (string.Equals(method, "DELETE", StringComparison.OrdinalIgnoreCase)
            && routePath == "/v1/orders/e2e-cleanup")
        // The internal account-deletion cascade. "Public" here means only "exempt
        // from the x-user-id guard" — the route is NOT on the API Gateway and is
        // not reachable from outside the network, and its handler requires the
        // shared internal key before it touches anything. It carries no end-user
        // identity by design: the subject arrives in the body, because the caller
        // is Users acting on a user's behalf, not the user themselves.
        || (string.Equals(method, "DELETE", StringComparison.OrdinalIgnoreCase)
            && routePath == "/v1/orders/by-user");
```

- [ ] **Step 6: Write the endpoint**

Create `services/orders/src/Orders.Api/Endpoints/InternalEndpoints.cs`:

```csharp
using Microsoft.EntityFrameworkCore;
using Orders.Api.Identity;
using Orders.Application.Abstractions;
using Orders.Infrastructure.Carts;
using Orders.Infrastructure.Persistence;

namespace Orders.Api.Endpoints;

/// <summary>
/// Service-to-service routes. Not published on the API Gateway; authenticated with
/// the shared internal key, never a user JWT.
/// </summary>
public static class InternalEndpoints
{
    public static void MapInternalEndpoints(this WebApplication app)
    {
        app.MapDelete("/v1/orders/by-user", async (
            InternalDeleteByUserRequest body,
            HttpRequest http,
            IConfiguration config,
            OrdersWriteDbContext db,
            ILoggerFactory loggerFactory,
            CancellationToken ct) =>
        {
            var logger = loggerFactory.CreateLogger("Orders.Api.Endpoints.InternalEndpoints");
            var provided = http.Headers[InternalApiKey.HeaderName].FirstOrDefault();

            if (!InternalApiKey.Matches(provided, config["GRPC_API_KEY"]!))
            {
                // A mass soft-delete surface is the widest blast radius in this
                // service; failed attempts are worth seeing. NEVER log the key.
                logger.LogWarning(
                    "Rejected internal delete {app_event} {reason}",
                    "internal_delete_by_user_failed", "invalid_api_key");
                return Results.Unauthorized();
            }

            if (string.IsNullOrWhiteSpace(body.CognitoSub))
            {
                return Results.BadRequest(new { error = "cognito_sub_required" });
            }

            var now = DateTime.UtcNow;

            // Details FIRST, then orders — the same ordering the E2E cleanup uses and
            // for the same reason: the detail predicate is a subquery over the parent
            // orders, and orders soft-deleted first would be hidden from it by their
            // own global query filter, orphaning every line as a live child of a
            // deleted parent.
            //
            // Selected through order_id rather than by cognito_sub directly:
            // order_details carries the denormalized column but has NO index on it
            // (only order_id, product_id, deleted_at), so keying on it would table-scan.
            var deletedDetails = await db.OrderDetails
                .Where(d => db.Orders
                    .Where(o => o.CognitoSub == body.CognitoSub)
                    .Select(o => o.Id)
                    .Contains(d.OrderId) && d.DeletedAt == null)
                .ExecuteUpdateAsync(s => s
                    .SetProperty(d => d.DeletedAt, now)
                    .SetProperty(d => d.DeletedBy, AuditActor.DeleteByUser), ct);

            // `DeletedAt == null` guards keep this idempotent: a retry after a partial
            // cascade failure re-runs harmlessly and reports 0.
            //
            // ExecuteUpdate issues one SQL UPDATE and BYPASSES SaveChanges, so the
            // AuditInterceptor never runs — DeletedBy is stamped explicitly here.
            var deleted = await db.Orders
                .Where(o => o.CognitoSub == body.CognitoSub && o.DeletedAt == null)
                .ExecuteUpdateAsync(s => s
                    .SetProperty(o => o.DeletedAt, now)
                    .SetProperty(o => o.DeletedBy, AuditActor.DeleteByUser), ct);

            // The cart goes through the shared primitive rather than a fourth bespoke
            // UPDATE: it must remove the LINES too, or the cart_item unique index stays
            // occupied. AmbientActor drives the interceptor, since this path DOES use
            // SaveChanges.
            var deletedCarts = 0;
            await AmbientActor.RunAsync(AuditActor.DeleteByUser, async () =>
            {
                var before = await db.Carts.CountAsync(c => c.CognitoSub == body.CognitoSub, ct);
                await CartWriteService.DeleteForUserAsync(db, body.CognitoSub, ct);
                await db.SaveChangesAsync(ct);
                deletedCarts = before;
            });

            logger.LogInformation(
                "Deleted orders for user {app_event} {deleted_count}",
                "internal_delete_by_user_succeeded", deleted);

            return Results.Ok(new InternalDeleteResponse(deleted, deletedDetails, deletedCarts));
        })
            .WithTags("internal")
            .WithName("InternalDeleteByUser")
            .WithSummary("[Internal] Soft-delete every order, line and cart belonging to a user.")
            .Produces<InternalDeleteResponse>(StatusCodes.Status200OK)
            .Produces(StatusCodes.Status401Unauthorized);
    }
}

/// <summary>The subject to erase. Identity travels in the body, not a header, because
/// the caller is Users acting on the user's behalf — there is no end-user request here.</summary>
public record InternalDeleteByUserRequest(string CognitoSub);

/// <summary>What the cascade removed, reported per table so a partial failure is diagnosable
/// from the response instead of the database.</summary>
public record InternalDeleteResponse(int Deleted, int DeletedDetails, int DeletedCarts);
```

- [ ] **Step 7: Map it**

In `services/orders/src/Orders.Api/Program.cs`, after `app.MapCartEndpoints();` (line 474):

```csharp
app.MapCartEndpoints();
// Internal service-to-service surface. Always mapped — unlike the E2E routes this
// is a production path (Users' account-deletion cascade calls it), and it is kept
// off the API Gateway rather than behind a flag.
app.MapInternalEndpoints();
```

- [ ] **Step 8: Run the tests**

Run: `cd services/orders && dotnet test --filter InternalDeleteByUserTests`
Expected: PASS (6 tests).

- [ ] **Step 9: Regenerate the OpenAPI document and commit**

Run: `cd services/orders && dotnet build`
Confirm `services/orders/openapi.yaml` now contains `/v1/orders/by-user`.

```bash
git add services/orders/src services/orders/tests services/orders/openapi.yaml
git commit -m "feat(orders): add the internal delete-by-user cascade route"
```

---

### Task 4: Tracking internal `DELETE /v1/trackings/by-user`

**Files:**
- Modify: `services/tracking/src/features/tracking/domain/repository.py` (add `soft_delete_by_user`)
- Modify: `services/tracking/src/shared/audit/audit_actor.py`
- Create: `services/tracking/src/shared/http/internal_auth.py`
- Create: `services/tracking/src/features/tracking/commands/delete_by_user.py`
- Create: `services/tracking/src/features/tracking/api/internal_router.py`
- Modify: `services/tracking/src/features/tracking/api/schemas.py`
- Modify: `services/tracking/src/main.py:169-183` (tags) and `:229` (registration order)
- Test: `services/tracking/tests/test_rest_internal_delete.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `DELETE /v1/trackings/by-user`, header `x-api-key: <GRPC_API_KEY>`, body `{"cognito_sub": "<sub>", "user_id": "<usr_id>"}` (snake_case, matching this service's wire style), response `200 {"deleted": N}`.

- [ ] **Step 1: Write the failing repository test**

Append to `services/tracking/tests/test_repository.py`:

```python
class TestSoftDeleteByUser:
    """The account-deletion cascade's predicate.

    `cognito_sub` is the ownership key every user-scoped read filters by, but it is
    NULLABLE on rows created before migration b17f4c2e9a30. Those rows still carry
    `user_id`, so the predicate matches EITHER — otherwise a returning user's oldest
    trackings would survive the deletion of their account.
    """

    def test_soft_deletes_by_cognito_sub(self, session: Session) -> None:
        repo = TrackingRepository(session)
        seed(session, order_id="ord_a", cognito_sub=SUB_A, user_id=USER_A)

        count = repo.soft_delete_by_user(
            cognito_sub=SUB_A, user_id=USER_A, actor=AuditActor.DELETE_BY_USER
        )
        session.commit()

        assert count == 1
        assert row(session, "ord_a").deleted_at is not None
        assert row(session, "ord_a").deleted_by == AuditActor.DELETE_BY_USER.value

    def test_soft_deletes_a_legacy_row_by_user_id_when_cognito_sub_is_null(
        self, session: Session
    ) -> None:
        repo = TrackingRepository(session)
        seed(session, order_id="ord_legacy", cognito_sub=None, user_id=USER_A)

        count = repo.soft_delete_by_user(
            cognito_sub=SUB_A, user_id=USER_A, actor=AuditActor.DELETE_BY_USER
        )
        session.commit()

        assert count == 1
        assert row(session, "ord_legacy").deleted_at is not None

    def test_cascades_to_history(self, session: Session) -> None:
        repo = TrackingRepository(session)
        seed(session, order_id="ord_b", cognito_sub=SUB_A, user_id=USER_A, with_history=True)

        repo.soft_delete_by_user(
            cognito_sub=SUB_A, user_id=USER_A, actor=AuditActor.DELETE_BY_USER
        )
        session.commit()

        history = session.execute(
            select(TrackingHistory).where(TrackingHistory.order_id == "ord_b")
        ).scalars().all()
        assert history, "the fixture must create history rows"
        assert all(h.deleted_at is not None for h in history)

    def test_leaves_other_users_alone(self, session: Session) -> None:
        repo = TrackingRepository(session)
        seed(session, order_id="ord_mine", cognito_sub=SUB_A, user_id=USER_A)
        seed(session, order_id="ord_theirs", cognito_sub=SUB_B, user_id=USER_B)

        repo.soft_delete_by_user(
            cognito_sub=SUB_A, user_id=USER_A, actor=AuditActor.DELETE_BY_USER
        )
        session.commit()

        assert row(session, "ord_theirs").deleted_at is None

    def test_is_idempotent(self, session: Session) -> None:
        repo = TrackingRepository(session)
        seed(session, order_id="ord_c", cognito_sub=SUB_A, user_id=USER_A)

        first = repo.soft_delete_by_user(
            cognito_sub=SUB_A, user_id=USER_A, actor=AuditActor.DELETE_BY_USER
        )
        session.commit()
        second = repo.soft_delete_by_user(
            cognito_sub=SUB_A, user_id=USER_A, actor=AuditActor.DELETE_BY_USER
        )
        session.commit()

        assert (first, second) == (1, 0)
```

Reuse the module's existing `seed`, `row`, `SUB_A`, `USER_A`, `SUB_B`, `USER_B` helpers; add a `with_history` parameter to `seed` if it does not already take one, and import `select`, `TrackingHistory`, and `AuditActor` at the top of the file if they are not already imported.

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd services/tracking && pytest tests/test_repository.py -k SoftDeleteByUser -v`
Expected: FAIL — `AttributeError: 'TrackingRepository' object has no attribute 'soft_delete_by_user'`.

- [ ] **Step 3: Add the audit actor**

In `services/tracking/src/shared/audit/audit_actor.py`, add to the `AuditActor` StrEnum:

```python
    # DELETE /v1/trackings/by-user — the account-deletion cascade from Users. Its
    # own actor, not the user's id: a row removed because an account was deleted
    # must stay distinguishable from one a real flow removed.
    DELETE_BY_USER = "tracking_api:delete_by_user"
```

- [ ] **Step 4: Implement the repository method**

In `services/tracking/src/features/tracking/domain/repository.py`, add next to `soft_delete_by_tag`:

```python
    def soft_delete_by_user(
        self,
        *,
        cognito_sub: str,
        user_id: str,
        actor: AuditActor,
        now: datetime | None = None,
    ) -> int:
        """Soft-delete every live tracking belonging to a user, and its history.

        Returns the number of `tracking` rows stamped (history rows are not counted;
        the caller has no use for that number).

        ## Why the predicate matches EITHER identity

        `cognito_sub` is the ownership key every user-scoped read filters by, and it
        is what the caller naturally has in hand. But the column is NULLABLE on rows
        created before migration `b17f4c2e9a30`, and those rows still carry
        `user_id`. Matching only `cognito_sub` would silently leave a returning
        user's oldest trackings live and unreachable — the exact failure this
        service's own column docstring warns about. So both are matched, and Users
        sends both.

        This reintroduces the caller scoping `soft_delete_by_tag` deliberately gave
        up: that method serves the global E2E teardown, which runs with no session
        and therefore no identity. Here an identity IS present, which is the whole
        point of the operation.

        ## Never a SQL DELETE

        Stamps `deleted_at` / `deleted_by` only ([[soft-delete]]). The application
        database user is granted no `DELETE` privilege, so a hard delete would fail
        at the server anyway.
        """
        moment = now or _utcnow()
        stamp = {"deleted_at": moment, "deleted_by": actor.value}
        owned = or_(Tracking.cognito_sub == cognito_sub, Tracking.user_id == user_id)

        # NOT filtered on `deleted_at IS NULL`: an already-soft-deleted tracking may
        # still have live history under it from a partial previous run, and those
        # children should still be swept. The per-statement guards below keep the
        # stamps idempotent.
        owned_ids = select(Tracking.id).where(owned)

        # Children first, mirroring the FK direction, so an interrupted unit of work
        # can never leave a live history row under a deleted tracking.
        self.session.execute(
            update(TrackingHistory)
            .where(
                TrackingHistory.tracking_id.in_(owned_ids),
                TrackingHistory.deleted_at.is_(None),
            )
            .values(**stamp)
            .execution_options(synchronize_session=False)
        )
        result = self.session.execute(
            update(Tracking)
            .where(owned, Tracking.deleted_at.is_(None))
            .values(**stamp)
            .execution_options(synchronize_session=False)
        )
        return int(result.rowcount or 0)
```

Add `or_` to the SQLAlchemy imports at the top of the file if it is not already imported.

- [ ] **Step 5: Run the repository tests**

Run: `cd services/tracking && pytest tests/test_repository.py -k SoftDeleteByUser -v`
Expected: PASS (5 tests). If they skip, export `TRACKING_TEST_DATABASE_URL` first — these are integration tests against real MySQL.

- [ ] **Step 6: Add the inbound key check**

Create `services/tracking/src/shared/http/internal_auth.py`:

```python
"""Internal service-to-service key check for `DELETE /v1/trackings/by-user`.

The second inbound key check in this service. Its sibling, `carrier_auth.py`,
validates the EXTERNAL carrier key; this one validates `GRPC_API_KEY`, the INTERNAL
credential (ADR-0003) that Users, Orders and Tracking share. The two must never be
interchanged: accepting the carrier's key here would let an outside vendor erase a
user's delivery history.

Kept as its own module rather than folded into `carrier_auth` precisely because the
values differ — one file per trust domain makes the wrong-key mistake structurally
harder than a shared helper with a key argument would.
"""

from __future__ import annotations

import hmac
import logging
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request, status

from src.shared.config.settings import Settings, get_settings

logger = logging.getLogger(__name__)

#: Same header NAME as the carrier's, different VALUE and different route. The two
#: never meet on one request.
INTERNAL_API_KEY_HEADER = "x-api-key"

SettingsDep = Annotated[Settings, Depends(get_settings)]


def internal_key_matches(provided: str | None, expected: str) -> bool:
    """True when `provided` equals `expected`, compared in constant time.

    Returns False (never raises) for a missing key, so an absent header and a wrong
    one are indistinguishable to the caller.
    """
    if provided is None:
        return False
    return hmac.compare_digest(provided.encode(), expected.encode())


def require_internal_key(
    request: Request,
    settings: SettingsDep,
    x_api_key: Annotated[str | None, Header(alias=INTERNAL_API_KEY_HEADER)] = None,
) -> None:
    """Reject the request unless it carries the internal service key."""
    if internal_key_matches(x_api_key, settings.grpc_api_key):
        return

    # A mass soft-delete surface is the widest blast radius this service has.
    # NEVER log the key — not a prefix, not its length.
    logger.warning(
        "internal_delete_by_user_failed",
        extra={
            "app_event": "internal_delete_by_user_failed",
            "reason": "invalid_api_key",
            "client": request.client.host if request.client else "unknown",
        },
    )
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="invalid api key",
    )


#: Reusable annotation for the internally-authenticated routes.
InternalAuth = Depends(require_internal_key)
```

- [ ] **Step 7: Add the command and the response schema**

Create `services/tracking/src/features/tracking/commands/delete_by_user.py`:

```python
"""`DELETE /v1/trackings/by-user` command handler.

The Tracking leg of the account-deletion cascade. Transport-free like every other
command here — it takes a session and returns a count, so the router stays a thin
translation.

The actor is the cascade, not the user: `deleted_by` records what produced the
change, and "this account was deleted" is a different fact from "the carrier
updated this" or "the test harness swept this".
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from src.features.tracking.domain.repository import TrackingRepository
from src.shared.audit.audit_actor import AuditActor


def delete_by_user(session: Session, *, cognito_sub: str, user_id: str) -> int:
    """Soft-delete every live tracking owned by the user; return how many were stamped."""
    return TrackingRepository(session).soft_delete_by_user(
        cognito_sub=cognito_sub,
        user_id=user_id,
        actor=AuditActor.DELETE_BY_USER,
    )
```

In `services/tracking/src/features/tracking/api/schemas.py`, add next to `E2eCleanupResponse`:

```python
class InternalDeleteByUserRequest(BaseModel):
    """Body of `DELETE /v1/trackings/by-user`.

    Both identities travel, because the ownership predicate matches either: rows
    predating migration `b17f4c2e9a30` have a NULL `cognito_sub` and are reachable
    only through `user_id`.
    """

    cognito_sub: str = Field(min_length=1)
    user_id: str = Field(min_length=1)


class InternalDeleteByUserResponse(BaseModel):
    """`200` payload of `DELETE /v1/trackings/by-user`.

    Named `deleted` rather than `count` because it says what was counted — the same
    shape Users and Orders report.
    """

    deleted: int
```

Ensure `Field` is imported from pydantic at the top of `schemas.py`.

- [ ] **Step 8: Add the router**

Create `services/tracking/src/features/tracking/api/internal_router.py`:

```python
"""Internal service-to-service routes.

Not published on the API Gateway and never reached by an end user: the only caller
is Users' `DELETE /v1/users/me`, authenticating with the shared internal key.

Registered BEFORE `trackings_router` in `main.py` because `/by-user` is a literal
segment sitting exactly where that router's `/{order_id}` path parameter also
matches. Starlette matches in declaration order, so the literal must be declared
first — the same reasoning that governs `/init-tracking` and `/e2e-cleanup`.

`def`, not `async def`: pymysql blocks, so a sync handler runs in the threadpool
instead of stalling the event loop.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter

from src.features.tracking.api.schemas import (
    InternalDeleteByUserRequest,
    InternalDeleteByUserResponse,
)
from src.features.tracking.commands.delete_by_user import delete_by_user
from src.shared.http.dependencies import WriteSession
from src.shared.http.internal_auth import InternalAuth

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/trackings", tags=["internal"])


@router.delete(
    "/by-user",
    dependencies=[InternalAuth],
    summary="[Internal] Soft-delete every tracking belonging to a user",
    responses={
        200: {"description": "The user's trackings and their history are soft-deleted"},
        # Declared explicitly: FastAPI cannot infer a status raised inside a
        # dependency, so without this line the 401 would be missing from the
        # generated document.
        401: {"description": "Missing or invalid internal API key"},
    },
)
def delete_trackings_by_user(
    body: InternalDeleteByUserRequest,
    session: WriteSession,
) -> InternalDeleteByUserResponse:
    """Soft-delete the user's trackings and, through the FK, their history."""
    deleted = delete_by_user(
        session, cognito_sub=body.cognito_sub, user_id=body.user_id
    )

    logger.info(
        "internal_delete_by_user_succeeded",
        extra={
            "app_event": "internal_delete_by_user_succeeded",
            "deleted_count": deleted,
        },
    )
    return InternalDeleteByUserResponse(deleted=deleted)
```

- [ ] **Step 9: Register it**

In `services/tracking/src/main.py`, add `internal_router` to the import block at line 53:

```python
from src.features.tracking.api import (
    carrier_router,
    e2e_router,
    health_router,
    init_tracking_router,
    internal_router,
    trackings_router,
)
```

Add the tag to `openapi_tags` (around line 169-183):

```python
        {
            "name": "internal",
            "description": (
                "Service-to-service routes. Not published on the API Gateway; "
                "authenticated with the shared internal key, never a user JWT."
            ),
        },
```

And register the router — **before** `trackings_router`:

```python
    app.include_router(init_tracking_router.router)
    # Before the reads: `/by-user` is a literal segment where `/{order_id}` also
    # matches, and Starlette matches in declaration order.
    app.include_router(internal_router.router)
    app.include_router(trackings_router.router)
    app.include_router(carrier_router.router)
```

- [ ] **Step 10: Write the route tests**

Create `services/tracking/tests/test_rest_internal_delete.py`:

```python
"""`DELETE /v1/trackings/by-user` — the account-deletion cascade's Tracking leg."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

pytestmark = pytest.mark.integration

PATH = "/v1/trackings/by-user"
KEY = "test-grpc-key"


class TestInternalDeleteByUser:
    def test_rejects_a_request_with_no_key(self, client: TestClient) -> None:
        response = client.request(
            "DELETE", PATH, json={"cognito_sub": "s", "user_id": "u"}
        )
        assert response.status_code == 401

    def test_rejects_a_wrong_key(self, client: TestClient) -> None:
        response = client.request(
            "DELETE",
            PATH,
            json={"cognito_sub": "s", "user_id": "u"},
            headers={"x-api-key": "wrong"},
        )
        assert response.status_code == 401

    def test_the_carrier_key_is_not_accepted_here(
        self, client: TestClient, carrier_key: str
    ) -> None:
        """The two inbound keys are different credentials and must not be interchangeable."""
        response = client.request(
            "DELETE",
            PATH,
            json={"cognito_sub": "s", "user_id": "u"},
            headers={"x-api-key": carrier_key},
        )
        assert response.status_code == 401

    def test_soft_deletes_the_users_trackings(
        self, client: TestClient, seeded_tracking
    ) -> None:
        response = client.request(
            "DELETE",
            PATH,
            json={
                "cognito_sub": seeded_tracking.cognito_sub,
                "user_id": seeded_tracking.user_id,
            },
            headers={"x-api-key": KEY},
        )
        assert response.status_code == 200
        assert response.json() == {"deleted": 1}

    def test_is_idempotent(self, client: TestClient, seeded_tracking) -> None:
        body = {
            "cognito_sub": seeded_tracking.cognito_sub,
            "user_id": seeded_tracking.user_id,
        }
        client.request("DELETE", PATH, json=body, headers={"x-api-key": KEY})
        second = client.request("DELETE", PATH, json=body, headers={"x-api-key": KEY})

        assert second.status_code == 200
        assert second.json() == {"deleted": 0}

    def test_rejects_an_empty_identity(self, client: TestClient) -> None:
        response = client.request(
            "DELETE",
            PATH,
            json={"cognito_sub": "", "user_id": ""},
            headers={"x-api-key": KEY},
        )
        assert response.status_code == 422

    def test_the_route_does_not_shadow_the_order_id_read(
        self, client: TestClient
    ) -> None:
        """`/by-user` is literal; `GET /v1/trackings/{order_id}` must still resolve."""
        response = client.get("/v1/trackings/by-user", headers={"x-user-id": "sub-x"})
        # Reaches the read route (404 for an unknown order), not the internal DELETE.
        assert response.status_code in (401, 404)
```

Add a `carrier_key` fixture and a `seeded_tracking` fixture to `tests/conftest.py` if they do not exist, following the existing `_build_app` dependency-override pattern in `tests/test_rest_e2e_cleanup.py`, and make the test app's `get_settings` override return `grpc_api_key="test-grpc-key"`.

- [ ] **Step 11: Run the tests**

Run: `cd services/tracking && pytest tests/test_rest_internal_delete.py -v`
Expected: PASS (7 tests).

- [ ] **Step 12: Regenerate the OpenAPI spec and commit**

Run from the repo root:
`docker compose run --rm --no-deps -e E2E_TESTING_ENABLED=true -v "$PWD/services/tracking:/app" --entrypoint python tracking scripts/generate_openapi.py`

Then: `cd services/tracking && pytest tests/test_openapi_spec.py -v` (fails on a stale spec).

```bash
git add services/tracking/src services/tracking/tests services/tracking/openapi.yaml
git commit -m "feat(tracking): add the internal delete-by-user cascade route"
```

---

### Task 5: The cascade HTTP client in Users

Users speaks gRPC, AWS SDK and Redis today — no plain HTTP outbound client exists. This adds the first one, modelled on Orders' `TrackingHttpClient`.

**Files:**
- Create: `services/users/src/shared/http/cascade-client.ts`
- Modify: `services/users/src/shared/config/env.ts`
- Test: `services/users/tests/shared/http/cascade-client.test.ts`

**Interfaces:**
- Consumes: Task 3's and Task 4's routes.
- Produces: `class CascadeClient` with `deleteOrdersForUser(cognitoSub: string): Promise<void>` and `deleteTrackingsForUser(cognitoSub: string, userId: string): Promise<void>`. Both throw `CascadeFailedError` (exported from the same module) on any non-2xx or network failure. Task 6's command consumes both.

- [ ] **Step 1: Add the two base URLs to the env schema**

In `services/users/src/shared/config/env.ts`, add to the Zod schema alongside the existing service URLs:

```ts
  // The account-deletion cascade's two downstream services. Users had no plain
  // HTTP dependency before this: every other outbound call is gRPC, an AWS SDK
  // client, or Redis. Named to match Orders' existing TRACKING_BASE_URL so one
  // convention covers every service-to-service HTTP base in the repo.
  ORDERS_BASE_URL: z.string().url(),
  TRACKING_BASE_URL: z.string().url(),
```

- [ ] **Step 2: Write the failing test**

Create `services/users/tests/shared/http/cascade-client.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { CascadeClient, CascadeFailedError } from "#shared/http/cascade-client";

const ORDERS = "http://orders:8080";
const TRACKING = "http://tracking:8000";
const KEY = "internal-key";

function makeClient(fetchImpl: typeof fetch) {
  return new CascadeClient({
    ordersBaseUrl: ORDERS,
    trackingBaseUrl: TRACKING,
    apiKey: KEY,
    fetchImpl,
  });
}

afterEach(() => vi.restoreAllMocks());

describe("CascadeClient", () => {
  it("calls Orders with the internal key and the subject in the body", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await makeClient(fetchImpl as any).deleteOrdersForUser("sub-1");

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ORDERS}/v1/orders/by-user`);
    expect(init.method).toBe("DELETE");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe(KEY);
    expect(JSON.parse(init.body as string)).toEqual({ cognitoSub: "sub-1" });
  });

  it("calls Tracking with BOTH identities, snake_cased", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await makeClient(fetchImpl as any).deleteTrackingsForUser("sub-1", "usr_1");

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${TRACKING}/v1/trackings/by-user`);
    expect(JSON.parse(init.body as string)).toEqual({
      cognito_sub: "sub-1",
      user_id: "usr_1",
    });
  });

  it("throws CascadeFailedError on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    await expect(
      makeClient(fetchImpl as any).deleteOrdersForUser("sub-1"),
    ).rejects.toBeInstanceOf(CascadeFailedError);
  });

  it("throws CascadeFailedError when the request never completes", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      makeClient(fetchImpl as any).deleteTrackingsForUser("sub-1", "usr_1"),
    ).rejects.toBeInstanceOf(CascadeFailedError);
  });

  it("names the failing service on the error, so a 502 is diagnosable", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 503 }));
    const error = await makeClient(fetchImpl as any)
      .deleteOrdersForUser("sub-1")
      .catch((e) => e as CascadeFailedError);

    expect(error.service).toBe("orders");
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `cd services/users && nvm use && pnpm test -- cascade-client`
Expected: FAIL — cannot resolve `#shared/http/cascade-client`.

- [ ] **Step 4: Implement the client**

Create `services/users/src/shared/http/cascade-client.ts`:

```ts
import { appLogger } from "#shared/logging/app-logger";

/// Raised when a cascade leg does not confirm the delete. Carries which service
/// failed so the 502 the user sees can be traced to a side without reading logs.
export class CascadeFailedError extends Error {
  constructor(
    readonly service: "orders" | "tracking",
    readonly detail: string,
  ) {
    super(`${service} cascade failed: ${detail}`);
    this.name = "CascadeFailedError";
  }
}

export interface CascadeClientDeps {
  ordersBaseUrl: string;
  trackingBaseUrl: string;
  apiKey: string;
  /// Injected so tests never touch the network. Defaults to global fetch (Node 24).
  fetchImpl?: typeof fetch;
}

/// The first plain-HTTP outbound client in Users: every other outbound call is
/// gRPC, an AWS SDK client, or Redis. Shaped after Orders' TrackingHttpClient —
/// relative paths against a configured base URL, so no host is ever hardcoded.
///
/// Both routes are INTERNAL: they are absent from the API Gateway and authenticate
/// with the shared internal key (ADR-0003), never a user JWT. The subject travels
/// in the body rather than an x-user-id header, because the caller is this service
/// acting on a user's behalf — there is no end-user request on the far side.
export class CascadeClient {
  private readonly ordersBaseUrl: string;
  private readonly trackingBaseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor({ ordersBaseUrl, trackingBaseUrl, apiKey, fetchImpl }: CascadeClientDeps) {
    this.ordersBaseUrl = ordersBaseUrl;
    this.trackingBaseUrl = trackingBaseUrl;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl ?? fetch;
  }

  async deleteOrdersForUser(cognitoSub: string): Promise<void> {
    await this.send("orders", `${this.ordersBaseUrl}/v1/orders/by-user`, {
      cognitoSub,
    });
  }

  /// Tracking gets BOTH identities: its `cognito_sub` column is nullable on rows
  /// predating migration b17f4c2e9a30, and those rows are reachable only through
  /// `user_id`. Sending one identity would silently strand the oldest data.
  /// snake_case on the wire, matching that service's convention.
  async deleteTrackingsForUser(cognitoSub: string, userId: string): Promise<void> {
    await this.send("tracking", `${this.trackingBaseUrl}/v1/trackings/by-user`, {
      cognito_sub: cognitoSub,
      user_id: userId,
    });
  }

  private async send(
    service: "orders" | "tracking",
    url: string,
    body: Record<string, string>,
  ): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          // NEVER logged, here or anywhere downstream.
          "x-api-key": this.apiKey,
        },
        body: JSON.stringify(body),
      });
    } catch (e: any) {
      // A network failure and a 500 are the same fact to the caller: this leg did
      // not confirm, so the account must NOT be deleted. Both become the same error.
      throw new CascadeFailedError(service, e?.message ?? "request failed");
    }

    if (!response.ok) {
      throw new CascadeFailedError(service, `status ${response.status}`);
    }

    appLogger.info({
      app_event: "cascade_delete_succeeded",
      cascade_service: service,
    });
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `cd services/users && nvm use && pnpm test -- cascade-client`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add services/users/src/shared/http/cascade-client.ts services/users/src/shared/config/env.ts services/users/tests/shared/http/cascade-client.test.ts
git commit -m "feat(users): add the internal cascade HTTP client"
```

---

### Task 6: The `DeleteAccountCommand`

The orchestrator. Its ordering is the whole safety argument of the feature.

**Files:**
- Create: `services/users/src/features/users/commands/delete-account.ts`
- Modify: `services/users/src/shared/audit/audit-actor.ts`
- Test: `services/users/tests/features/users/commands/delete-account.test.ts`

**Interfaces:**
- Consumes: `CascadeClient` (Task 5), `AuthProvider.deleteUser` (Task 2), `Db`, `CurrentUser`.
- Produces: `class DeleteAccountCommand` with `execute(currentUser: CurrentUser): Promise<"deleted" | "not_found">`. Task 7's route maps `"deleted"` → 204 and `"not_found"` → 404; a thrown `CascadeFailedError` → 502.

- [ ] **Step 1: Add the audit actor**

In `services/users/src/shared/audit/audit-actor.ts`, add to the enum:

```ts
  DeleteAccount = "users_api:delete_account",
```

- [ ] **Step 2: Write the failing test**

Create `services/users/tests/features/users/commands/delete-account.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { DeleteAccountCommand } from "#features/users/commands/delete-account";
import { AuditActor } from "#shared/audit/audit-actor";
import { getActor } from "#shared/audit/actor-context";
import { CascadeFailedError } from "#shared/http/cascade-client";
import { CurrentUser } from "#shared/auth/current-user";

const TARGET = {
  id: "usr_1",
  email: "a@b.co",
  cognitoSub: "sub-1",
  fullName: "A",
  address: null,
  phoneNumber: null,
  tags: [],
  createdBy: null,
  createdAt: new Date(),
  updatedBy: null,
  updatedAt: new Date(),
  deletedBy: null,
  deletedAt: null,
};

function makeDeps(target: typeof TARGET | null = TARGET) {
  const seenActor: { value?: string } = {};
  const del = vi.fn(async () => {
    seenActor.value = getActor();
    return { ...TARGET, deletedAt: new Date() };
  });
  const db = {
    user: { findByIdOrCognitoSub: vi.fn(async () => target), delete: del },
  } as any;
  const cascade = {
    deleteOrdersForUser: vi.fn(async () => {}),
    deleteTrackingsForUser: vi.fn(async () => {}),
  };
  const auth = { deleteUser: vi.fn(async () => {}) };
  return { db, cascade, auth, del, seenActor };
}

describe("DeleteAccountCommand", () => {
  it("cascades to BOTH services before deleting the account", async () => {
    const { db, cascade, auth } = makeDeps();
    const order: string[] = [];
    cascade.deleteOrdersForUser.mockImplementation(async () => void order.push("orders"));
    cascade.deleteTrackingsForUser.mockImplementation(async () => void order.push("tracking"));
    db.user.delete.mockImplementation(async () => {
      order.push("users");
      return TARGET;
    });
    auth.deleteUser.mockImplementation(async () => void order.push("cognito"));

    const currentUser = new CurrentUser({ db, identity: "sub-1" });
    const result = await new DeleteAccountCommand({ db, cascade, auth } as any).execute(currentUser);

    expect(result).toBe("deleted");
    expect(order).toEqual(["orders", "tracking", "users", "cognito"]);
  });

  it("passes both identities to Tracking", async () => {
    const { db, cascade, auth } = makeDeps();
    const currentUser = new CurrentUser({ db, identity: "sub-1" });
    await new DeleteAccountCommand({ db, cascade, auth } as any).execute(currentUser);

    expect(cascade.deleteTrackingsForUser).toHaveBeenCalledWith("sub-1", "usr_1");
  });

  it("stamps the DeleteAccount audit actor", async () => {
    const { db, cascade, auth, seenActor } = makeDeps();
    const currentUser = new CurrentUser({ db, identity: "sub-1" });
    await new DeleteAccountCommand({ db, cascade, auth } as any).execute(currentUser);

    expect(seenActor.value).toBe(AuditActor.DeleteAccount);
  });

  it("returns not_found and touches nothing when the user does not exist", async () => {
    const { db, cascade, auth } = makeDeps(null);
    const currentUser = new CurrentUser({ db, identity: "ghost" });
    const result = await new DeleteAccountCommand({ db, cascade, auth } as any).execute(currentUser);

    expect(result).toBe("not_found");
    expect(cascade.deleteOrdersForUser).not.toHaveBeenCalled();
    expect(db.user.delete).not.toHaveBeenCalled();
    expect(auth.deleteUser).not.toHaveBeenCalled();
  });

  it("does NOT delete the account when the Orders cascade fails", async () => {
    const { db, cascade, auth } = makeDeps();
    cascade.deleteOrdersForUser.mockRejectedValue(new CascadeFailedError("orders", "status 500"));

    const currentUser = new CurrentUser({ db, identity: "sub-1" });
    await expect(
      new DeleteAccountCommand({ db, cascade, auth } as any).execute(currentUser),
    ).rejects.toBeInstanceOf(CascadeFailedError);

    // The account survives, so the user can authenticate and retry. This is the
    // whole reason the cascade runs first.
    expect(db.user.delete).not.toHaveBeenCalled();
    expect(auth.deleteUser).not.toHaveBeenCalled();
  });

  it("does NOT delete the account when the Tracking cascade fails", async () => {
    const { db, cascade, auth } = makeDeps();
    cascade.deleteTrackingsForUser.mockRejectedValue(
      new CascadeFailedError("tracking", "status 503"),
    );

    const currentUser = new CurrentUser({ db, identity: "sub-1" });
    await expect(
      new DeleteAccountCommand({ db, cascade, auth } as any).execute(currentUser),
    ).rejects.toBeInstanceOf(CascadeFailedError);

    expect(db.user.delete).not.toHaveBeenCalled();
  });

  it("still reports success when Cognito fails after the row is stamped", async () => {
    const { db, cascade, auth } = makeDeps();
    auth.deleteUser.mockRejectedValue(new Error("cognito down"));

    const currentUser = new CurrentUser({ db, identity: "sub-1" });
    const result = await new DeleteAccountCommand({ db, cascade, auth } as any).execute(currentUser);

    // Postgres has committed; failing the request would tell the user their delete
    // did not happen when it did. The orphaned pool entry is logged loudly instead.
    expect(result).toBe("deleted");
    expect(db.user.delete).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `cd services/users && nvm use && pnpm test -- delete-account`
Expected: FAIL — cannot resolve `#features/users/commands/delete-account`.

- [ ] **Step 4: Implement the command**

Create `services/users/src/features/users/commands/delete-account.ts`:

```ts
import type { Db } from "#shared/db/prisma";
import type { AuthProvider } from "#shared/auth/auth-provider";
import type { CurrentUser } from "#shared/auth/current-user";
import type { CascadeClient } from "#shared/http/cascade-client";
import { runAsActor } from "#shared/audit/actor-context";
import { AuditActor } from "#shared/audit/audit-actor";
import { appLogger } from "#shared/logging/app-logger";
import { hashEmail } from "#shared/logging/email-hash";
import { withWorkflowSpan } from "#shared/observability/workflow-tracing";

export type DeleteAccountResult = "deleted" | "not_found";

/// Deletes the caller's own account and everything that belongs to it.
///
/// ## The order is the safety argument
///
/// Cascade FIRST, account LAST. The reverse order is unrecoverable: an account
/// deleted before a failing cascade leaves the user unable to authenticate, so
/// they cannot retry, and their orders are orphaned with no path to fix them.
/// With this order a failure leaves the account alive and the user simply retries.
///
/// Both internal routes are idempotent (`deleted_at IS NULL` guards), so a retry
/// after a half-finished cascade re-runs the succeeded leg as a no-op. The
/// inconsistency is transient and self-healing, which is why no compensation
/// (an "undelete") exists — that primitive is absent from all three services and
/// would be more new surface than the feature itself.
export class DeleteAccountCommand {
  private readonly db: Db;
  private readonly cascade: CascadeClient;
  private readonly auth: AuthProvider;

  constructor({ db, cascade, auth }: { db: Db; cascade: CascadeClient; auth: AuthProvider }) {
    this.db = db;
    this.cascade = cascade;
    this.auth = auth;
  }

  async execute(currentUser: CurrentUser): Promise<DeleteAccountResult> {
    return withWorkflowSpan(
      "delete_account",
      { app_event: "delete_account_started" },
      () => this.doExecute(currentUser),
    );
  }

  private async doExecute(currentUser: CurrentUser): Promise<DeleteAccountResult> {
    const target = await currentUser.resolve();
    if (!target) {
      appLogger.info({
        app_event: "delete_account_failed",
        reason: "not_found",
      });
      return "not_found";
    }

    const email_hash = hashEmail(target.email);

    // 1 & 2 — the cascades. A throw here propagates to the route as a 502 with the
    // account still intact.
    await this.cascade.deleteOrdersForUser(target.cognitoSub ?? "");
    await this.cascade.deleteTrackingsForUser(target.cognitoSub ?? "", target.id);

    // 3 — our own row. `delete` is rewritten to an UPDATE stamping deletedAt and
    // deletedBy by the cross-cutting Prisma extension; no SQL DELETE is issued and
    // the write user has no DELETE grant anyway.
    await runAsActor(AuditActor.DeleteAccount, () =>
      this.db.user.delete({ where: { id: target.id } }),
    );

    // 4 — Cognito, the point of no return, and what frees the email for
    // re-registration. Best-effort BY DESIGN: Postgres has already committed, so
    // failing the request would tell the user their deletion did not happen when it
    // did. But this is the one failure in the flow that needs an alert — it leaves
    // an orphan in the pool that will block the user from registering again.
    try {
      await this.auth.deleteUser(target.email);
    } catch (e: any) {
      appLogger.error({
        app_event: "delete_account_cognito_orphan",
        reason: e?.name ?? "unknown",
        email_hash,
        user_id: target.id,
      });
    }

    appLogger.info({
      app_event: "delete_account_succeeded",
      email_hash,
      user_id: target.id,
    });

    return "deleted";
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `cd services/users && nvm use && pnpm test -- delete-account`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add services/users/src/features/users/commands/delete-account.ts services/users/src/shared/audit/audit-actor.ts services/users/tests/features/users/commands/delete-account.test.ts
git commit -m "feat(users): add the DeleteAccountCommand"
```

---

### Task 7: Wire `DELETE /v1/users/me`

**Files:**
- Modify: `services/users/src/shared/di/awilix-container.ts` (three edit points)
- Modify: `services/users/src/features/users/http/routes.ts:496-509` (route) and `:224-241` (error handler)
- Test: `services/users/tests/features/users/http/delete-me-route.test.ts`

**Interfaces:**
- Consumes: `DeleteAccountCommand` (Task 6), `CascadeFailedError` (Task 5).
- Produces: the public endpoint. `204` deleted · `401` no `x-user-id` · `404` already deleted · `502` a cascade leg failed.

- [ ] **Step 1: Register the client and the command in the container**

In `services/users/src/shared/di/awilix-container.ts`:

Add the imports:

```ts
import { DeleteAccountCommand } from "#features/users/commands/delete-account";
import { CascadeClient } from "#shared/http/cascade-client";
```

Add to the `Cradle` interface:

```ts
    cascade: CascadeClient;
    deleteAccountCommand: DeleteAccountCommand;
```

Add the singleton in `registerSingletons()`, next to `auth`:

```ts
    cascade: asFunction(
      ({ env: cradleEnv }: { env: Env }) =>
        new CascadeClient({
          ordersBaseUrl: cradleEnv.ORDERS_BASE_URL,
          trackingBaseUrl: cradleEnv.TRACKING_BASE_URL,
          apiKey: cradleEnv.GRPC_API_KEY,
        }),
      { lifetime: Lifetime.SINGLETON },
    ),
```

And the command in `registerServices()`:

```ts
    deleteAccountCommand: asClass(DeleteAccountCommand, { lifetime: Lifetime.SCOPED }),
```

> Awilix uses PROXY injection: the constructor's destructured names must match cradle keys exactly (`db`, `cascade`, `auth`). A mismatch throws `AwilixResolutionError` at startup, and no unit test catches it.

- [ ] **Step 2: Write the failing route test**

Create `services/users/tests/features/users/http/delete-me-route.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { CascadeFailedError } from "#shared/http/cascade-client";

// Mirrors the harness used by tests/features/users/http/routes.test.ts — build the
// real app with a container whose deleteAccountCommand is a double.
async function buildTestApp(execute: ReturnType<typeof vi.fn>) {
  const { makeTestApp } = await import("../../../helpers/make-test-app.ts");
  return makeTestApp({ deleteAccountCommand: { execute } });
}

describe("DELETE /v1/users/me", () => {
  it("401s without x-user-id", async () => {
    const app = await buildTestApp(vi.fn());
    const res = await app.inject({ method: "DELETE", url: "/v1/users/me" });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthenticated" });
  });

  it("204s with no body when the account is deleted", async () => {
    const execute = vi.fn(async () => "deleted");
    const app = await buildTestApp(execute);
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/users/me",
      headers: { "x-user-id": "sub-1" },
    });

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
  });

  it("404s when the row is already gone", async () => {
    const app = await buildTestApp(vi.fn(async () => "not_found"));
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/users/me",
      headers: { "x-user-id": "sub-1" },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });

  it("502s when a cascade leg fails, naming nothing sensitive", async () => {
    const app = await buildTestApp(
      vi.fn(async () => {
        throw new CascadeFailedError("orders", "status 500");
      }),
    );
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/users/me",
      headers: { "x-user-id": "sub-1" },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "cascade_failed" });
  });
});
```

If `tests/helpers/make-test-app.ts` does not exist, follow the container-building pattern already used at the top of `tests/features/users/http/routes.test.ts` instead of creating a new helper.

- [ ] **Step 3: Run it to make sure it fails**

Run: `cd services/users && nvm use && pnpm test -- delete-me-route`
Expected: FAIL — the route 404s (not registered).

- [ ] **Step 4: Map `CascadeFailedError` in the error handler**

In `services/users/src/features/users/http/routes.ts`, import it and add an arm to `setErrorHandler` before the final `throw error;`:

```ts
    // A cascade leg did not confirm, so the account was deliberately NOT deleted.
    // 502 rather than 500: the failure is downstream, and the correct client action
    // is to retry — both internal routes are idempotent, so a retry is safe.
    if (error instanceof CascadeFailedError) {
      return reply.code(502).send({ error: "cascade_failed" });
    }
```

- [ ] **Step 5: Add the route**

In `services/users/src/features/users/http/routes.ts`, immediately after the `PATCH /v1/users/me` registration:

```ts
    r.delete("/v1/users/me", {
      schema: {
        tags: ["users"], operationId: "deleteMe", summary: "Delete the current user's account",
        headers: UserIdHeader,
        response: { 204: z.null(), 404: ErrorSchema, 502: ErrorSchema },
      },
    }, async (req, reply) => {
      const { deleteAccountCommand, currentUser } = req.diScope.cradle;
      const result = await deleteAccountCommand.execute(currentUser);
      return result === "deleted"
        ? reply.code(204).send()
        : reply.code(404).send({ error: "not_found" });
    });
```

> Do **not** add this route to `src/shared/http/public-routes.ts`. Its absence from that allowlist is exactly what makes the `onRequest` hook return 401 without an `x-user-id`.

- [ ] **Step 6: Run the tests**

Run: `cd services/users && nvm use && pnpm test -- delete-me-route`
Expected: PASS (4 tests).

- [ ] **Step 7: Run the whole Users suite, regenerate OpenAPI, commit**

Run: `cd services/users && nvm use && pnpm test && pnpm generate:openapi`
Confirm `services/users/openapi.yaml` contains `deleteMe`.

```bash
git add services/users/src services/users/tests services/users/openapi.yaml
git commit -m "feat(users): add DELETE /v1/users/me"
```

---

### Task 8: Gateway route + env plumbing

**Files:**
- Modify: `infra/modules/api-gateway/main.tf:50` (after `patch_me`)
- Modify: `infra/environments/local/scripts/generate_env_files.py` (the Users block)
- Modify: `.env.example`

**Interfaces:**
- Consumes: Task 7's route.
- Produces: `DELETE /v1/users/me` reachable through the gateway with a real JWT — the precondition for Task 9's gateway E2E.

- [ ] **Step 1: Add the gateway route**

In `infra/modules/api-gateway/main.tf`, after the `patch_me` line:

```terraform
      delete_me = { key = "DELETE /v1/users/me", path = "/v1/users/me", auth = true }
```

> nginx needs **no** change: `/v1/users/me` already falls under `location /`, which proxies to Users. Verified against `infra/modules/compute/nginx/nginx.conf` — only a new TOP-LEVEL path would need a `location` block.
>
> The two internal routes are deliberately **absent** here. They must not be reachable from outside the network.

- [ ] **Step 2: Give Users the two base URLs**

In `infra/environments/local/scripts/generate_env_files.py`, in the `.env.local.users` `generated` dict:

```python
                # The account-deletion cascade's downstream services. Users calls
                # both over plain HTTP with the shared internal key; neither route
                # is published on the API Gateway.
                "ORDERS_BASE_URL": "http://orders:8080",
                "TRACKING_BASE_URL": "http://tracking:8000",
```

Confirm the Orders port matches the one Orders actually listens on in `docker-compose.yml`; use that value.

- [ ] **Step 3: Update the committed env contract**

Add to `.env.example`, near the existing `TRACKING_BASE_URL`:

```bash
# Users -> Orders/Tracking, for the account-deletion cascade (DELETE /v1/users/me).
# Internal routes, authenticated with GRPC_API_KEY; never exposed on the gateway.
ORDERS_BASE_URL=http://orders:8080
TRACKING_BASE_URL=http://tracking:8000
```

- [ ] **Step 4: Regenerate and verify**

Run: `make env-file`
Then: `grep -E "ORDERS_BASE_URL|TRACKING_BASE_URL" .env.local.users`
Expected: both present in the AUTO-GENERATED box.

- [ ] **Step 5: Apply the gateway change and prove the route resolves**

Run: `make apply` (or the repo's usual apply target), then hit the route with no token:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE "$API_GATEWAY_URL/v1/users/me"
```

Expected: **401** — that is the good answer. It proves the route resolves and reached the authorizer. A `404` carrying the gateway's own `{"message":"Not Found"}` would mean the route map never picked it up.

- [ ] **Step 6: Commit**

```bash
git add infra/modules/api-gateway/main.tf infra/environments/local/scripts/generate_env_files.py .env.example
git commit -m "build(infra): publish DELETE /v1/users/me and wire the cascade base URLs"
```

---

### Task 9: E2E — internal and gateway

The gateway spec is what proves the feature's headline requirement. Delegate to `e2e-impl`, which owns `e2e/`.

**Files:**
- Create: `e2e/tests/account-deletion.spec.ts` (internal, direct service URLs)
- Create: `e2e/tests/gateway/account-deletion.spec.ts` (gateway, real Cognito JWT)

**Interfaces:**
- Consumes: everything above.
- Produces: proof. No later task depends on it.

- [ ] **Step 1: Write the internal E2E spec**

Create `e2e/tests/account-deletion.spec.ts`, hitting service URLs directly. Cases:
- A user with orders and tracking is deleted → `204`; their orders and trackings are gone from every read.
- `DELETE /v1/users/me` twice → `204` then `404`.
- Another user's orders and trackings are untouched by the first user's deletion.
- Both internal routes reject a missing key and a wrong key with `401`.
- Both internal routes are idempotent: a second call reports `0`.

- [ ] **Step 2: Run it**

Run: `pnpm --filter @3mrai/e2e test -- account-deletion`
Expected: PASS.

- [ ] **Step 3: Write the gateway E2E spec**

Create `e2e/tests/gateway/account-deletion.spec.ts`, through the gateway with a real Cognito JWT. **The load-bearing case:**

```
register(email) → create an order → confirm tracking exists
  → DELETE /v1/users/me → 204
  → GET /v1/users/me with the old token → 401 or 404
  → register(SAME email) → 201    // the whole point of the feature
  → GET /v1/orders/my-orders → empty      // the new account starts clean
  → the old row is still in Postgres with deleted_at stamped AND its real email
```

Assert the last line against the database, not the API — a soft-deleted row is invisible to every read path by construction, so an API-only assertion cannot distinguish "preserved" from "erased", which is precisely the requirement under test.

Also cover: `DELETE /v1/users/me` with no token → `401` at the gateway.

- [ ] **Step 4: Run it**

Run: `pnpm --filter @3mrai/e2e test -- gateway/account-deletion`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add e2e/tests/account-deletion.spec.ts e2e/tests/gateway/account-deletion.spec.ts
git commit -m "test(shared): add internal and gateway E2E for account deletion"
```

---

### Task 10: Vault propagation

Per [[doc-propagation]], a spec is done when its decisions have reached the notes that own them. Route through `obsidian-vault` — no other agent writes `docs/`.

**Files:**
- Modify: `docs/domains/users/specs/users-service-design.md`
- Modify: `docs/domains/orders/specs/orders-service-design.md`
- Modify: `docs/domains/tracking/specs/tracking-service-design.md`
- Modify: `docs/shared/conventions/soft-delete.md`

**Interfaces:**
- Consumes: the shipped implementation.
- Produces: a validator-green vault with no propagation debt for this spec.

- [ ] **Step 1: Propagate to the three service-design notes**

- **Users** — `DELETE /v1/users/me`, the four-step order and why the cascade runs first, the partial unique index on `email`, and `AdminDeleteUser` as the deliberate Cognito-boundary exception to [[ADR-0004-soft-delete-only]].
- **Orders** — the internal `DELETE /v1/orders/by-user`, its `x-api-key` guard (Orders' first inbound key check), and the details-before-orders sweep order.
- **Tracking** — the internal `DELETE /v1/trackings/by-user`, `soft_delete_by_user`, and the `cognito_sub OR user_id` predicate with the nullable-column reason.

Bump each note's `updated:` to the merge date.

- [ ] **Step 2: Extend the soft-delete convention**

Add to `docs/shared/conventions/soft-delete.md`:
- **The partial-unique-index pattern**: how a soft-deletable natural key stays unique among live rows only — Postgres via `@@unique([...], where: raw(...))` (Prisma ≥7.4, `partialIndexes` preview), MySQL via a `STORED` generated column, since MySQL has no partial indexes. Cross-reference the cart's `active_user_id`.
- **The per-user cascade**: `soft_delete_by_user` and `DeleteForUserAsync` as the two reusable primitives, and the rule that a cascade keys on `cognito_sub` (with Tracking's `user_id` fallback), never `user_id` alone.

- [ ] **Step 3: Record the caching dependency**

This is the one piece deliberately left unimplemented. Add a short "Known dependency" section to the account-deletion spec:

> The Response Caching Layer milestone (JE-196/197/199/200) is unfinished, and none of its code is on this branch — so there is no cache here to invalidate. When Orders' and Tracking's identity caches (`cognito_sub → user_id`) land, they **must** invalidate on account deletion. Without it a deleted `cognito_sub` keeps resolving from cache for the TTL, and the deletion appears not to have taken effect on cached reads.

Mirror this as a comment on the relevant Linear issues so it is visible from both sides.

- [ ] **Step 4: Validate**

Run: `nvm use && node scripts/validate-vault.mjs`
Expected: `Vault validation passed` with no new propagation debt.

- [ ] **Step 5: Commit**

```bash
git add docs/
git commit -m "docs(vault): propagate account deletion across the three service designs"
```

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: actor + endpoint → 7; Cognito `AdminDeleteUser` → 2; unconditional Orders cascade → 3; synchronous HTTP propagation → 5; no `USER_DELETED` event → nothing to build, and no events-pipeline task exists (correct); partial unique index → 1; gRPC unchanged → nothing to build (correct — `GetUserById` keeps returning `NOT_FOUND` and no task touches the proto); re-registration semantics → asserted in 9; order of operations → 6; partial failure/idempotency → 3, 4, 6; ownership key → 3, 4, 5; API surface → 3, 4, 7; migrations → 1 only; wiring → 8; three test layers → 1-7 (unit), 9 (both E2E); load tests → deliberately absent, per the spec.

**Placeholders.** None. Every code step carries real code; every run step carries a real command and an expected result.

**Type consistency.** `deleteUser(email)` defined in Task 2 is called in Task 6. `CascadeClient.deleteOrdersForUser` / `deleteTrackingsForUser` defined in Task 5 are called with those exact names and arities in Task 6. `CascadeFailedError` is thrown in 5, asserted in 6, mapped in 7. `AuditActor.DeleteAccount` / `AuditActor.DeleteByUser` / `AuditActor.DELETE_BY_USER` are each defined once and used in their own service. Wire shapes are consistent per service convention: Orders receives camelCase `{cognitoSub}`, Tracking snake_case `{cognito_sub, user_id}` — matching what each service already speaks, and matching the client that sends them.

**One deliberate gap**, recorded rather than hidden: cache invalidation (Task 10, Step 3).

## Related

- [[2026-08-25-account-deletion-design]] — the spec this plan implements.
- [[ADR-0004-soft-delete-only]] — the rule the cascade obeys, and the Cognito boundary where it deliberately does not.
- [[soft-delete]] — the per-service primitives reused here; gains two patterns in Task 10.
- [[audit-fields]] — `deletedAt`/`deletedBy`, stamped by every leg.
- [[testing]] — the three-layer rule Task 9 satisfies.
- [[git-workflow]] — the branch and PR flow this plan's commits follow.
