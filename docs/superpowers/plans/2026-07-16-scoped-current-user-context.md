# Scoped Current-User Context (Middleware) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the authenticated caller once per request in a middleware and expose it via a request-scoped context in both the Users (Fastify/Awilix) and Orders (.NET) services, replacing scattered per-command/query header reads and duplicated auth checks.

**Architecture:** A middleware enforces auth (401 on missing `x-user-id`) against a centralized public-route allowlist (exact match + `/v1/webhooks/*` prefix), and populates a request-scoped current-caller context. The context carries the raw identity always and resolves the full user lazily (local Prisma lookup in Users, gRPC in Orders — reads stay gRPC-free), caching the result in the scope. Users' audit system (`actorContext` ALS + `runAsActor`) is left intact.

**Tech Stack:** Users — Node/Fastify + `@fastify/awilix` + Prisma. Orders — .NET 10 Minimal APIs + EF Core + gRPC.

## Global Constraints

- **Identity unchanged:** `x-user-id` carries the Cognito sub (or the `usr_` id in Users). No JWT parsing; no gateway change.
- **Auth via middleware + allowlist:** middleware returns 401 when `x-user-id` is missing UNLESS the route is public. Allowlist matching: **exact (method+path)** for fixed routes; **prefix** only for `/v1/webhooks/*`.
  - Users public routes: `GET /v1/health`, `POST /v1/users/login`, `POST /v1/users/register`, `POST /v1/users/refresh`, `POST /v1/webhooks/*`. E2E routes when `E2E_TESTING_ENABLED`.
  - Orders public routes: `GET /v1/health`. E2E routes when `E2E_TESTING_ENABLED`.
- **Lazy + cached resolution:** the full user resolves on first demand and is cached in the request scope; repeat calls in one request must NOT re-hit the DB/gRPC.
- **Orders reads stay gRPC-free:** my-orders / by-id filter by `cognito_sub`, no `IUserDirectory` call.
- **Users audit intact:** do NOT touch `actorContext` / `runAsActor` / the Prisma audit extension. The middleware keeps populating them from the same single header read.
- **No route/shape changes → no `openapi.yaml` changes** in either service (both have a GOLDEN RULE in their CLAUDE.md).
- **Node:** `nvm use` before any Node command; Users uses subpath imports `#shared/*`/`#features/*` (NOT `@`).
- **Clean Architecture (Orders):** `ICurrentCaller` is an Api-layer abstraction; `IUserDirectory` port stays in Application; gRPC impl stays in Infrastructure. Dependency direction unchanged.
- **Git:** the main session commits per task (commit-only, no push); implementers write only source code, never git/Linear. Conventional Commits, scope `users` / `orders`.

---

### Task 1: Users — public-route allowlist module

**Files:**
- Create: `services/users/src/shared/http/public-routes.ts`
- Test: `services/users/tests/shared/public-routes.test.ts`

**Interfaces:**
- Produces: `isPublicRoute(method: string, routePath: string): boolean` — true for the Users public routes (exact method+path; `/v1/webhooks/*` prefix). Consumed by the middleware in Task 2.

- [ ] **Step 1: Write the failing test**

Create `services/users/tests/shared/public-routes.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { isPublicRoute } from "#shared/http/public-routes";

describe("isPublicRoute", () => {
  it("exempts the fixed public routes (exact method+path)", () => {
    expect(isPublicRoute("GET", "/v1/health")).toBe(true);
    expect(isPublicRoute("POST", "/v1/users/login")).toBe(true);
    expect(isPublicRoute("POST", "/v1/users/register")).toBe(true);
    expect(isPublicRoute("POST", "/v1/users/refresh")).toBe(true);
  });
  it("exempts webhooks by prefix", () => {
    expect(isPublicRoute("POST", "/v1/webhooks/cognito")).toBe(true);
  });
  it("protects everything else", () => {
    expect(isPublicRoute("GET", "/v1/users/me")).toBe(false);
    expect(isPublicRoute("PATCH", "/v1/users/me")).toBe(false);
    expect(isPublicRoute("GET", "/v1/users")).toBe(false);
  });
  it("does not exempt a protected path by loose prefix", () => {
    expect(isPublicRoute("GET", "/v1/users/login-history")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd services/users && nvm use && npx vitest run tests/shared/public-routes.test.ts`
Expected: FAIL — cannot resolve `#shared/http/public-routes`.

- [ ] **Step 3: Implement the module**

Create `services/users/src/shared/http/public-routes.ts`:
```ts
// Routes that do NOT require an x-user-id identity. The auth middleware
// (routes.ts onRequest hook) lets these through; everything else 401s on a
// missing header. Exact method+path match, except webhooks which match by prefix.
// Adding a public route means adding it here.
const EXACT: ReadonlyArray<{ method: string; path: string }> = [
  { method: "GET", path: "/v1/health" },
  { method: "POST", path: "/v1/users/login" },
  { method: "POST", path: "/v1/users/register" },
  { method: "POST", path: "/v1/users/refresh" },
];

const PREFIX: ReadonlyArray<{ method: string; prefix: string }> = [
  { method: "POST", prefix: "/v1/webhooks/" },
];

export function isPublicRoute(method: string, routePath: string): boolean {
  const m = method.toUpperCase();
  if (EXACT.some((r) => r.method === m && r.path === routePath)) return true;
  if (PREFIX.some((r) => r.method === m && routePath.startsWith(r.prefix))) return true;
  return false;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd services/users && npx vitest run tests/shared/public-routes.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit** (main session)

Staged: the module + test.
Message: `feat(users): public-route allowlist for the auth middleware`

---

### Task 2: Users — scoped current-user context + enforce auth in the hook

**Files:**
- Create: `services/users/src/shared/auth/current-user.ts`
- Modify: `services/users/src/shared/di/awilix-container.ts` (add `currentUser` to `RequestCradle`)
- Modify: `services/users/src/features/users/http/routes.ts` (extend the `onRequest` hook; register `currentUser` on `req.diScope`)
- Test: `services/users/tests/shared/current-user.test.ts` (unit for the context) + extend an existing routes test for the 401 behavior

**Interfaces:**
- Consumes: `isPublicRoute` (Task 1), `db.user.findByIdOrCognitoSub` (`src/shared/db/prisma-extensions.ts:245`).
- Produces:
  - `CurrentUser` class with `identity: string` and `async resolve(): Promise<User>` — calls `findByIdOrCognitoSub(identity)` once, caches the row (including a not-found throw) for the request.
  - `currentUser` registered request-scoped on `req.diScope`; `RequestCradle.currentUser: CurrentUser`.
  - The `onRequest` hook returns `401 { error: "unauthenticated" }` for a non-public route with no `x-user-id`.

- [ ] **Step 1: Write the failing unit test for the context**

Create `services/users/tests/shared/current-user.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { CurrentUser } from "#shared/auth/current-user";

describe("CurrentUser", () => {
  it("resolves the user once and caches it", async () => {
    const row = { id: "usr_1", cognitoSub: "sub-1" };
    const findByIdOrCognitoSub = vi.fn().mockResolvedValue(row);
    const db = { user: { findByIdOrCognitoSub } } as never;
    const cu = new CurrentUser({ db, identity: "sub-1" });
    const a = await cu.resolve();
    const b = await cu.resolve();
    expect(a).toBe(row);
    expect(b).toBe(row);
    expect(findByIdOrCognitoSub).toHaveBeenCalledTimes(1); // cached
  });

  it("exposes the raw identity without resolving", () => {
    const findByIdOrCognitoSub = vi.fn();
    const cu = new CurrentUser({ db: { user: { findByIdOrCognitoSub } } as never, identity: "sub-2" });
    expect(cu.identity).toBe("sub-2");
    expect(findByIdOrCognitoSub).not.toHaveBeenCalled(); // lazy
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd services/users && npx vitest run tests/shared/current-user.test.ts`
Expected: FAIL — cannot resolve `#shared/auth/current-user`.

- [ ] **Step 3: Implement `CurrentUser`**

Create `services/users/src/shared/auth/current-user.ts`:
```ts
import type { PrismaClient } from "#shared/db/prisma";

// Request-scoped caller context. `identity` is the raw x-user-id (Cognito sub or
// usr_ id). `resolve()` turns it into a user row lazily, caching the promise so
// repeat consumers in one request don't re-hit the DB. Registered SCOPED in
// Awilix (routes.ts onRequest hook).
export class CurrentUser {
  readonly identity: string;
  private readonly db: PrismaClient;
  private cached?: Promise<Awaited<ReturnType<PrismaClient["user"]["findByIdOrCognitoSub"]>>>;

  constructor(deps: { db: PrismaClient; identity: string }) {
    this.db = deps.db;
    this.identity = deps.identity;
  }

  resolve() {
    // Cache the PROMISE (not just the value) so concurrent callers share one lookup.
    this.cached ??= this.db.user.findByIdOrCognitoSub(this.identity);
    return this.cached;
  }
}
```
NOTE for the implementer: match the actual exported Prisma client type from `#shared/db/prisma`. If `findByIdOrCognitoSub`'s return type isn't easily nameable, type `cached` as `Promise<unknown>` and cast at call sites, or import the row type — keep it type-safe without `any`. Verify `tsc` is clean.

- [ ] **Step 4: Add `currentUser` to `RequestCradle`**

In `services/users/src/shared/di/awilix-container.ts`, extend the `RequestCradle` interface:
```ts
  interface RequestCradle {
    currentActor: string | undefined;
    currentUser: import("../auth/current-user").CurrentUser;
  }
```

- [ ] **Step 5: Extend the `onRequest` hook to enforce auth + register the context**

In `services/users/src/features/users/http/routes.ts`, replace the current hook body (around line 182) with:
```ts
import { isPublicRoute } from "#shared/http/public-routes";
import { CurrentUser } from "#shared/auth/current-user";

app.addHook("onRequest", (req, reply, done) => {
  const actor = req.headers["x-user-id"] as string | undefined;
  const routePath = req.routeOptions?.url ?? req.url;

  if (actor === undefined && !isPublicRoute(req.method, routePath)) {
    reply.code(401).send({ error: "unauthenticated" });
    return; // do NOT call done() — request is finished
  }

  req.diScope.register({
    currentActor: asValue(actor),
    currentUser: asFunction(
      ({ db }: { db: typeof import("#shared/db/prisma").db }) =>
        new CurrentUser({ db, identity: actor as string }),
      { lifetime: Lifetime.SCOPED },
    ),
  });
  actorContext.run({ actor }, done);
});
```
NOTE: keep the ORDERING INVARIANT comment intact — this hook must stay above `app.after()`. `currentUser` is only meaningfully resolvable on protected routes (where `actor` is defined); public routes won't consume it. Confirm `asFunction`/`Lifetime` are imported (they already are for the container, re-import in routes.ts if needed). Adjust the `db` cradle typing to match the existing pattern.

- [ ] **Step 6: Add a 401 test**

Extend `services/users/tests/features/users/http/routes.test.ts` (or add a focused test): a protected route (`GET /v1/users/me`) with NO `x-user-id` header returns 401 `{ error: "unauthenticated" }`; a public route (`GET /v1/health`) with no header returns its normal success; `GET /v1/users/me` WITH the header still works as before.

- [ ] **Step 7: Run tests + full suite**

Run: `cd services/users && npx vitest run`
Expected: new tests PASS; the existing 140 stay green (the `me`/webhook tests supply `x-user-id`, so they are unaffected; if any protected-route test omitted the header and relied on reaching the handler, update it to send the header — note any such change).

- [ ] **Step 8: Commit** (main session)

Staged: `current-user.ts`, `awilix-container.ts`, `routes.ts`, tests.
Message: `feat(users): scoped current-user context; enforce auth in the onRequest hook`

---

### Task 3: Users — consume the context in use-cases (remove duplicated resolution)

**Files:**
- Modify: `services/users/src/features/users/queries/get-me.ts`
- Modify: `services/users/src/features/users/commands/update-profile.ts`
- Modify: `services/users/src/features/users/http/routes.ts` (the `/v1/users/me` GET + PATCH handlers)
- Test: adjust the relevant existing tests

**Interfaces:**
- Consumes: `req.diScope.cradle.currentUser` (Task 2). `getUserById` (the gRPC path) is NOT request-scoped and keeps taking an explicit id — do NOT route it through `currentUser`.

- [ ] **Step 1: Refactor `getMe` to accept the resolved user**

`UserQueryService.getMe` currently takes a string and calls `findByIdOrCognitoSub`. Change the `/v1/users/me` GET handler to resolve via the context and pass the resolved user (or have `getMe` accept the `currentUser` and call `.resolve()`), removing the in-`getMe` `findByIdOrCognitoSub`. Keep `getUserById(id)` (gRPC) unchanged — it still resolves by explicit id.

Show the concrete edit: in `routes.ts` `/v1/users/me` GET (around line 257), replace `userQueryService.getMe(currentActor)` with resolving `currentUser` and passing it; update `get-me.ts` `getMe` signature to take the resolved user (or the `CurrentUser`) instead of the raw string. If `getMe` does more than the lookup (serialization/shape), keep that logic — only the resolution moves.

- [ ] **Step 2: Refactor `update-profile` similarly**

`UpdateProfileCommand.execute(userId, input)` resolves the target via `findByIdOrCognitoSub` then updates by `target.id`. Change it to consume the resolved user from `currentUser` (passed in from the PATCH handler), removing the duplicate lookup. Preserve the `runAsActor(AuditActor.UpdateProfile, ...)` wrapping exactly.

- [ ] **Step 3: Update the handlers in `routes.ts`**

`/v1/users/me` GET and PATCH resolve `currentUser` from `req.diScope.cradle` and pass the resolved user into the use-cases.

- [ ] **Step 4: Adjust tests**

Update the `get-me` / `update-profile` unit tests to pass a resolved user (or a `CurrentUser` stub) instead of a raw string. The behavior asserted (returned shape, audit actor) stays the same.

- [ ] **Step 5: Run the full suite**

Run: `cd services/users && npx vitest run`
Expected: all tests PASS. Verify (by reading, or a test) that `findByIdOrCognitoSub` is now called ONCE per request via the context, not once per use-case.

- [ ] **Step 6: Regenerate openapi if needed (it should NOT change)**

Run: `cd services/users && nvm use && pnpm generate:openapi && git status --short services/users/openapi.yaml`
Expected: NO change to `openapi.yaml` (no route/schema change). If it changed, something is wrong — stop and report.

- [ ] **Step 7: Commit** (main session)

Staged: use-cases, routes.ts, tests.
Message: `refactor(users): resolve the caller via the scoped context, not per use-case`

---

### Task 4: Orders — public-route allowlist + ICurrentCaller abstraction

**Files:**
- Create: `services/orders/src/Orders.Api/Identity/PublicRoutes.cs`
- Create: `services/orders/src/Orders.Api/Identity/ICurrentCaller.cs`
- Create: `services/orders/src/Orders.Api/Identity/CurrentCaller.cs`
- Test: `services/orders/tests/Orders.Tests/Identity/CurrentCallerTests.cs`

**Interfaces:**
- Consumes: `IUserDirectory.ResolveInternalUserIdAsync` (`src/Orders.Application/Identity/IUserDirectory.cs:7`).
- Produces:
  - `PublicRoutes.IsPublic(string method, string? routePath)` — `GET /v1/health` exact; e2e handled by the caller if enabled.
  - `ICurrentCaller` with `string? CognitoSub { get; }`, `void SetSub(string sub)`, `Task<string> ResolveInternalUserIdAsync(CancellationToken ct)` (lazy + cached; throws `UnknownUserException` on unknown user).
  - `CurrentCaller : ICurrentCaller` (Scoped), depending on `IUserDirectory`.

- [ ] **Step 1: Write the failing CurrentCaller test**

Create `services/orders/tests/Orders.Tests/Identity/CurrentCallerTests.cs`:
```csharp
using Moq;
using Orders.Api.Identity;
using Orders.Application.Identity;
using Orders.Application.Orders; // UnknownUserException namespace — adjust to actual
using Xunit;

public class CurrentCallerTests
{
    [Fact]
    public async Task Resolves_internal_id_once_and_caches()
    {
        var dir = new Mock<IUserDirectory>();
        dir.Setup(d => d.ResolveInternalUserIdAsync("sub-1", It.IsAny<CancellationToken>()))
           .ReturnsAsync("usr_1");
        var caller = new CurrentCaller(dir.Object);
        caller.SetSub("sub-1");

        var a = await caller.ResolveInternalUserIdAsync(default);
        var b = await caller.ResolveInternalUserIdAsync(default);

        Assert.Equal("usr_1", a);
        Assert.Equal("usr_1", b);
        dir.Verify(d => d.ResolveInternalUserIdAsync("sub-1", It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task Throws_UnknownUser_when_directory_returns_null()
    {
        var dir = new Mock<IUserDirectory>();
        dir.Setup(d => d.ResolveInternalUserIdAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()))
           .ReturnsAsync((string?)null);
        var caller = new CurrentCaller(dir.Object);
        caller.SetSub("sub-x");
        await Assert.ThrowsAsync<UnknownUserException>(() => caller.ResolveInternalUserIdAsync(default));
    }
}
```
NOTE: confirm the actual namespace of `UnknownUserException` (the explorer found it thrown in `CreateOrderService`; find its definition) and `IUserDirectory`'s exact method signature.

- [ ] **Step 2: Run to verify it fails**

Run: `cd services/orders && dotnet test --filter CurrentCallerTests`
Expected: FAIL — types don't exist / don't compile.

- [ ] **Step 3: Implement `PublicRoutes`, `ICurrentCaller`, `CurrentCaller`**

`PublicRoutes.cs`:
```csharp
namespace Orders.Api.Identity;

// Routes that don't require x-user-id. The auth middleware lets these through.
public static class PublicRoutes
{
    public static bool IsPublic(string method, string? routePath) =>
        string.Equals(method, "GET", StringComparison.OrdinalIgnoreCase)
        && routePath == "/v1/health";
}
```
`ICurrentCaller.cs`:
```csharp
namespace Orders.Api.Identity;

// Request-scoped caller context. CognitoSub is the raw x-user-id (set by the
// middleware). ResolveInternalUserIdAsync lazily resolves the internal usr_ id
// via gRPC (write path only) and caches it for the request.
public interface ICurrentCaller
{
    string? CognitoSub { get; }
    void SetSub(string sub);
    Task<string> ResolveInternalUserIdAsync(CancellationToken ct);
}
```
`CurrentCaller.cs`:
```csharp
using Orders.Application.Identity;
using Orders.Application.Orders; // UnknownUserException — adjust to actual namespace

namespace Orders.Api.Identity;

public sealed class CurrentCaller : ICurrentCaller
{
    private readonly IUserDirectory _users;
    private string? _internalId;
    private bool _resolved;

    public CurrentCaller(IUserDirectory users) => _users = users;

    public string? CognitoSub { get; private set; }

    public void SetSub(string sub) => CognitoSub = sub;

    public async Task<string> ResolveInternalUserIdAsync(CancellationToken ct)
    {
        if (_resolved) return _internalId!;
        var sub = CognitoSub ?? throw new InvalidOperationException("caller sub not set");
        _internalId = await _users.ResolveInternalUserIdAsync(sub, ct)
            ?? throw new UnknownUserException(sub);
        _resolved = true;
        return _internalId;
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd services/orders && dotnet test --filter CurrentCallerTests`
Expected: PASS (both).

- [ ] **Step 5: Commit** (main session)

Staged: the three Identity files + test.
Message: `feat(orders): ICurrentCaller scoped context + public-route allowlist`

---

### Task 5: Orders — auth middleware + DI registration; retire ad hoc checks

**Files:**
- Create: `services/orders/src/Orders.Api/Middleware/CallerContextMiddleware.cs`
- Modify: `services/orders/src/Orders.Api/Program.cs` (register `ICurrentCaller` scoped; add the middleware after `UseSerilogRequestLogging`)
- Modify: `services/orders/src/Orders.Api/Endpoints/CreateOrderEndpoint.cs` (remove the `if (sub is null)` check; use the context)
- Modify: `services/orders/src/Orders.Api/Endpoints/OrderEndpoints.cs` (remove the two `if (sub is null)` checks; use the context)
- Modify: `services/orders/src/Orders.Infrastructure/Orders/CreateOrderService.cs` (consume `ICurrentCaller` instead of a passed sub string)
- Delete: `services/orders/src/Orders.Api/Identity/CallerIdentity.cs` (retired)
- Test: `services/orders/tests/Orders.Tests/Identity/AuthMiddlewareTests.cs`

**Interfaces:**
- Consumes: `PublicRoutes.IsPublic`, `ICurrentCaller` (Task 4).
- Produces: middleware that 401s protected routes with no `x-user-id`, else sets the sub on the scoped `ICurrentCaller`.

- [ ] **Step 1: Write the failing middleware test**

Create `services/orders/tests/Orders.Tests/Identity/AuthMiddlewareTests.cs` using `OrdersApiFactory`:
- `GET /v1/health` with no `x-user-id` → 200.
- `GET /v1/orders/my-orders` with no `x-user-id` → 401.
- `GET /v1/orders/my-orders` WITH `x-user-id: sub-1` → 200 (empty list is fine).

Show the wiring (issue requests via the factory's `HttpClient`, set/omit the header).

- [ ] **Step 2: Run to verify it fails**

Run: `cd services/orders && dotnet test --filter AuthMiddlewareTests`
Expected: FAIL — middleware not present (my-orders currently 401s via the endpoint check, but the header-set path / health behavior won't match until wired; confirm the specific failing assertion).

- [ ] **Step 3: Implement the middleware**

Create `services/orders/src/Orders.Api/Middleware/CallerContextMiddleware.cs`:
```csharp
using Orders.Api.Identity;

namespace Orders.Api.Middleware;

public sealed class CallerContextMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext ctx, ICurrentCaller caller)
    {
        var sub = ctx.Request.Headers["x-user-id"].FirstOrDefault();
        var routePath = (ctx.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText;

        if (sub is null && !PublicRoutes.IsPublic(ctx.Request.Method, routePath))
        {
            ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }
        if (sub is not null) caller.SetSub(sub);
        await next(ctx);
    }
}
```
NOTE: `GetEndpoint()` is populated after routing. If the middleware runs before `UseRouting`/endpoint resolution, `routePath` is null and only the exact-path allowlist can't match — so place the middleware AFTER routing resolves the endpoint. In minimal APIs the endpoint is resolved by the routing middleware; register `app.UseRouting()` explicitly before this middleware if needed, OR match on `ctx.Request.Path` for the health check. Implement so `GET /v1/health` is reliably recognized as public — verify with the test.

- [ ] **Step 4: Register in `Program.cs`**

After `app.UseSerilogRequestLogging(...)` and before `app.MapOrderEndpoints()`, add scoped registration and the middleware:
```csharp
builder.Services.AddScoped<ICurrentCaller, CurrentCaller>();
// ... after build, in the pipeline:
app.UseMiddleware<CallerContextMiddleware>();
```
Place the `AddScoped` with the other service registrations (before `builder.Build()`), and `UseMiddleware` in the pipeline. Ensure ordering so the endpoint is resolvable (see Step 3 note).

- [ ] **Step 5: Refactor endpoints + CreateOrderService to use the context**

- `CreateOrderEndpoint.Handle`: remove `var sub = CallerIdentity.CognitoSub(ctx); if (sub is null) return Results.Unauthorized();`. Inject `ICurrentCaller` (or resolve from the service). `CreateOrderService.CreateAsync` no longer takes the sub string — it consumes `ICurrentCaller.ResolveInternalUserIdAsync(ct)` internally. Keep the `UnknownUserException`/`InsufficientStockException` → 404/409 mapping.
- `OrderEndpoints` my-orders / by-id: remove the two `if (sub is null)` checks; read `caller.CognitoSub` (guaranteed non-null past the middleware) and pass to `OrderReadService`.
- Delete `CallerIdentity.cs`.

- [ ] **Step 6: Build + full test suite**

Run: `cd services/orders && dotnet build && dotnet test`
Expected: build succeeds; all tests PASS (was 35; new `CurrentCallerTests` + `AuthMiddlewareTests` add to it). Fix any endpoint test that relied on `CallerIdentity` or the old inline 401.

- [ ] **Step 7: Confirm openapi.yaml unchanged (GOLDEN RULE)**

Run: `cd services/orders && dotnet build && git status --short services/orders/openapi.yaml`
Expected: NO change (middleware + DI only; no route/shape change). The endpoints still `.Produces(401)` — keep those annotations (the 401 now comes from the middleware, still a real response). If openapi.yaml changed, stop and report.

- [ ] **Step 8: Commit** (main session)

Staged: middleware, Program.cs, endpoints, CreateOrderService, deleted CallerIdentity, tests.
Message: `refactor(orders): resolve the caller in middleware via ICurrentCaller`

---

### Task 6: Orders — reads don't trigger gRPC; E2E verification both services

**Files:**
- Test: `services/orders/tests/Orders.Tests/Identity/ReadsNoGrpcTests.cs`
- (verification task; may touch `e2e` endpoint to route through the context)

- [ ] **Step 1: Assert reads never call the directory**

Add `services/orders/tests/Orders.Tests/Identity/ReadsNoGrpcTests.cs`: drive `GET /v1/orders/my-orders` and `GET /v1/orders/{id}` with a valid `x-user-id`, using a `Mock<IUserDirectory>` registered in the test host; assert `ResolveInternalUserIdAsync` was NEVER called (reads filter by cognito_sub only). Assert create-order DOES call it once.

- [ ] **Step 2: Run**

Run: `cd services/orders && dotnet test --filter ReadsNoGrpcTests`
Expected: PASS.

- [ ] **Step 3: Handle the e2e-cleanup route**

Ensure `E2eEndpoints` (which read the header directly) either goes through the context or is covered by the allowlist consistently when `E2E_TESTING_ENABLED`. If it must stay reading the header for the flag-gated path, note that explicitly. Keep its behavior identical.

- [ ] **Step 4: E2E verification (both services live)**

Run:
```bash
docker compose up -d --build users orders
sleep 8
# no header -> 401 on a protected route (both services)
curl -s -o /dev/null -w "users/me no-hdr: %{http_code}\n" http://localhost:3000/v1/users/me
curl -s -o /dev/null -w "orders/my-orders no-hdr: %{http_code}\n" http://localhost:3001/v1/orders/my-orders
# public routes still open
curl -s -o /dev/null -w "users health: %{http_code}\n" http://localhost:3000/v1/health
curl -s -o /dev/null -w "orders health: %{http_code}\n" http://localhost:3001/v1/health
# with header -> works
curl -s -o /dev/null -w "users/me hdr: %{http_code}\n" -H "x-user-id: some-sub" http://localhost:3000/v1/users/me
```
Expected: `401` for both no-header protected routes; `200` for both health; the authed `me` returns its normal status (200 or 404 depending on whether the sub resolves — NOT 401).

- [ ] **Step 5: Commit** (main session)

Staged: the reads-no-grpc test, any e2e handling.
Message: `test(orders): reads stay gRPC-free; verify auth gate end-to-end`

---

## Self-Review

**Spec coverage:**
- Middleware enforces auth + centralized allowlist → Users Tasks 1–2, Orders Tasks 4–5. ✓
- Scoped current-caller context (identity always + lazy cached resolve) → Users Task 2 (`CurrentUser`), Orders Task 4 (`CurrentCaller`). ✓
- Remove duplicated resolution/checks → Users Task 3 (use-cases), Orders Task 5 (4 checks + CallerIdentity retired). ✓
- Reads stay gRPC-free → Orders Task 6. ✓
- Users audit intact → Global Constraints + Task 2 keeps `actorContext.run`/`runAsActor` untouched. ✓
- No openapi changes → Tasks 3, 5, 6 verify. ✓
- Lazy cache correctness → Task 2 & Task 4 tests assert "called once". ✓

**Placeholder scan:** No TBD/"handle edge cases". The "adjust to actual namespace" notes (UnknownUserException, IUserDirectory signature, Prisma row type) are explicit verification instructions with a defined action, not placeholders — the implementer confirms the real symbol.

**Type consistency:** `CurrentUser({ db, identity })` + `.resolve()` consistent across Tasks 2–3. `ICurrentCaller` (`CognitoSub`, `SetSub`, `ResolveInternalUserIdAsync`) consistent across Tasks 4–6. `isPublicRoute(method, path)` / `PublicRoutes.IsPublic(method, path)` consistent across Tasks 1–2 / 4–5.

**Risk sequencing:** allowlist + context abstractions (Tasks 1, 4) come before the middleware wiring that depends on them (Tasks 2, 5). The two spec risks (Fastify `routeOptions.url` match key; Orders middleware ordering vs endpoint resolution) are called out inline in Tasks 2 Step 5 and Task 5 Step 3.

## Related

- [[2026-07-16-scoped-current-user-context-design]]
- [[ADR-0010-cognito-auth]]
- [[dependency-injection]]
