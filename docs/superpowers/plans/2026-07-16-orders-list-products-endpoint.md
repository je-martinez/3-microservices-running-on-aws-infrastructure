# Orders — List Products Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an authenticated `GET /v1/products` endpoint to the Orders service that returns the active product catalog as `IReadOnlyList<ProductDto>`.

**Architecture:** Mirror the existing Orders read pattern — a pure `ProductDto` record in Application, a concrete `ProductReadService` in Infrastructure (`AsNoTracking` over `OrdersReadDbContext.Products`), and a `ProductEndpoints` route group in Api. The endpoint is private (gated by the existing `CallerContextMiddleware`; NOT added to the public allowlist). Soft-deleted rows are excluded automatically by the `product` table's global query filter.

**Tech Stack:** .NET 10 Minimal APIs, EF Core (Pomelo MySQL), xUnit + Testcontainers-MySQL.

## Global Constraints

- **Money in cents:** `UnitPriceCents` is `long` (integer cents), exposed as-is — never `decimal`/`float`. Matches `OrderDto`.
- **Private endpoint:** requires `x-user-id`. Gated by `CallerContextMiddleware`; do NOT add `/v1/products` to `PublicRoutes.IsPublic`. No per-endpoint auth check (the middleware owns the 401). The endpoint does NOT read the caller (products have no owner) and does NOT resolve the internal usr_ id (no gRPC).
- **Read pattern:** concrete `ProductReadService` in `Orders.Infrastructure` (NOT Application — it depends on `OrdersReadDbContext`; Application must not reference EF Core). `AsNoTracking`. `ProductDto` is a pure record in `Orders.Application`.
- **Soft-delete:** excluded by the existing global query filter (`HasQueryFilter(p => p.DeletedAt == null)` in `ProductConfiguration`) — do NOT add a manual `Where(!IsDeleted)`.
- **GOLDEN RULE (services/orders/CLAUDE.md §2a):** a new route changes the contract → regenerate `services/orders/openapi.yaml` via `dotnet build` and commit it WITH the code. `ProductDto` surfaces as `#/components/schemas/ProductDto`. Keep `.Produces<T>` annotations accurate.
- **Git:** main session commits per task (commit-only, no push); implementers write only source code, never git/Linear. Conventional Commits, scope `orders`.

---

### Task 1: ProductDto + ProductReadService (+ unit test)

**Files:**
- Create: `services/orders/src/Orders.Application/Orders/ProductDto.cs`
- Create: `services/orders/src/Orders.Infrastructure/Orders/ProductReadService.cs`
- Test: `services/orders/tests/Orders.Tests/Infrastructure/ProductReadServiceTests.cs`

**Interfaces:**
- Produces:
  - `record ProductDto(string Id, string Name, string Description, long UnitPriceCents, uint UnitsInStock)` in `Orders.Application.Orders`.
  - `ProductReadService` (concrete, in `Orders.Infrastructure.Orders`) with `Task<IReadOnlyList<ProductDto>> GetProductsAsync()` — `_db.Products.AsNoTracking()`, maps via a private static `Map`. Consumed by the endpoint in Task 2.

- [ ] **Step 1: Write the failing test**

Create `services/orders/tests/Orders.Tests/Infrastructure/ProductReadServiceTests.cs`. Follow the existing Testcontainers-MySQL read-test harness (look at an existing Infrastructure test, e.g. `MigrationSeedTests.cs` or `OrderReadServiceTests.cs`, for how the test DbContext/container is set up — reuse that exact fixture pattern). The test:
- Seeds two products (one active, one soft-deleted: set `DeletedAt` to a non-null value).
- Constructs `ProductReadService` with the read DbContext.
- Asserts `GetProductsAsync()` returns ONLY the active product, mapped to `ProductDto` with the right `Id`/`Name`/`Description`/`UnitPriceCents`/`UnitsInStock`.

IMPLEMENTATION NOTE: match how `OrderReadServiceTests` (if it exists) builds its context and seeds rows. If seeding a soft-deleted row through the write context triggers the audit/soft-delete interceptor, set `DeletedAt` directly on the entity before `SaveChanges`, or use the write context's raw insert — the point is the global query filter must hide it from the read service. If the harness makes the soft-delete assertion impractical, at minimum assert active products are returned + mapped correctly, and note the limitation.

- [ ] **Step 2: Run to verify it fails**

Run: `cd services/orders && dotnet test --filter ProductReadServiceTests`
Expected: FAIL — `ProductDto` / `ProductReadService` don't exist (compile error).

- [ ] **Step 3: Create `ProductDto`**

Create `services/orders/src/Orders.Application/Orders/ProductDto.cs`:
```csharp
namespace Orders.Application.Orders;

// Pure read DTO for the product catalog. Money in integer cents (service
// convention). No audit/soft-delete fields.
public record ProductDto(
    string Id,
    string Name,
    string Description,
    long UnitPriceCents,
    uint UnitsInStock);
```

- [ ] **Step 4: Create `ProductReadService`**

Create `services/orders/src/Orders.Infrastructure/Orders/ProductReadService.cs` (mirror `OrderReadService`):
```csharp
using Microsoft.EntityFrameworkCore;
using Orders.Application.Orders;
using Orders.Infrastructure.Persistence;

namespace Orders.Infrastructure.Orders;

// Read-only product catalog. Lives in Infrastructure because it depends on
// OrdersReadDbContext (Application must not reference EF Core). Soft-deleted rows
// are excluded by the product global query filter (ProductConfiguration) — no
// manual filter here. No gRPC / caller on reads (products have no owner).
public class ProductReadService
{
    private readonly OrdersReadDbContext _db;
    public ProductReadService(OrdersReadDbContext db) => _db = db;

    public async Task<IReadOnlyList<ProductDto>> GetProductsAsync()
    {
        var products = await _db.Products.AsNoTracking().ToListAsync();
        return products.Select(Map).ToList();
    }

    private static ProductDto Map(Domain.Entities.Product p) =>
        new(p.Id, p.Name, p.Description, p.UnitPriceCents, p.UnitsInStock);
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd services/orders && dotnet test --filter ProductReadServiceTests`
Expected: PASS.

- [ ] **Step 6: Full build + suite**

Run: `cd services/orders && dotnet build && dotnet test`
Expected: build succeeds; full suite green (was 43). `openapi.yaml` NOT yet changed (no route added yet — the endpoint is Task 2). Confirm `git status --short services/orders/openapi.yaml` is empty here.

- [ ] **Step 7: Commit** (main session)

Staged: `ProductDto.cs`, `ProductReadService.cs`, `ProductReadServiceTests.cs`.
Message: `feat(orders): ProductReadService + ProductDto for the product catalog`

---

### Task 2: GET /v1/products endpoint + wiring + openapi

**Files:**
- Create: `services/orders/src/Orders.Api/Endpoints/ProductEndpoints.cs`
- Modify: `services/orders/src/Orders.Api/Program.cs` (register `ProductReadService` scoped; `app.MapProductEndpoints()`)
- Modify: `services/orders/openapi.yaml` (regenerated by build)
- Test: `services/orders/tests/Orders.Tests/Api/ProductEndpointsTests.cs`

**Interfaces:**
- Consumes: `ProductReadService.GetProductsAsync()` (Task 1), `OrdersApiFactory` (test harness).

- [ ] **Step 1: Write the failing endpoint test**

Create `services/orders/tests/Orders.Tests/Api/ProductEndpointsTests.cs` using `OrdersApiFactory` (look at `CreateOrderEndpointTests.cs` / `AuthMiddlewareTests.cs` for the factory + HttpClient pattern):
- `GET /v1/products` WITH `x-user-id: sub-1` → 200, body is a JSON array of products (the seeded catalog: Widget/Gadget/Gizmo if seeding runs in the test host; if the test host doesn't seed, seed a product in the test or assert the array shape/`ProductDto` fields on whatever is present).
- `GET /v1/products` with NO `x-user-id` → 401 (the middleware gate).

- [ ] **Step 2: Run to verify it fails**

Run: `cd services/orders && dotnet test --filter ProductEndpointsTests`
Expected: FAIL — route not mapped (404 instead of 200/401, or compile error if the test references a not-yet-existing type).

- [ ] **Step 3: Create `ProductEndpoints`**

Create `services/orders/src/Orders.Api/Endpoints/ProductEndpoints.cs` (mirror `OrderEndpoints`):
```csharp
using Orders.Application.Orders;
using Orders.Infrastructure.Orders;

namespace Orders.Api.Endpoints;

public static class ProductEndpoints
{
    public static void MapProductEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/v1/products").WithTags("Products");

        group.MapGet("", async (ProductReadService reads) =>
            Results.Ok(await reads.GetProductsAsync()))
            .WithName("GetProducts")
            .WithSummary("List the active product catalog.")
            .Produces<IReadOnlyList<ProductDto>>(StatusCodes.Status200OK)
            .Produces(StatusCodes.Status401Unauthorized);
    }
}
```
NOTE: no `ICurrentCaller` parameter — the endpoint doesn't need the caller. The middleware still gates it (401 without header) because `/v1/products` is not in `PublicRoutes.IsPublic`. Keep `.Produces(401)` so the 401 (from the middleware) is documented.

- [ ] **Step 4: Wire in `Program.cs`**

- Add `builder.Services.AddScoped<ProductReadService>();` immediately after the `OrderReadService` registration (Program.cs:29).
- Add `app.MapProductEndpoints();` immediately after `app.MapOrderEndpoints();` (Program.cs:130).

- [ ] **Step 5: Build (regenerates openapi.yaml) + verify the route landed**

Run:
```bash
cd services/orders && dotnet build
git status --short services/orders/openapi.yaml
grep -n "/v1/products" services/orders/openapi.yaml
grep -n "ProductDto" services/orders/openapi.yaml
```
Expected: build succeeds; `openapi.yaml` shows as MODIFIED; the `/v1/products` path is present with `get` + 200/401 responses; `ProductDto` appears under components/schemas. The document must stay OpenAPI 3.1.

- [ ] **Step 6: Run the endpoint test + full suite**

Run: `cd services/orders && dotnet test`
Expected: `ProductEndpointsTests` PASS (200 with header, 401 without); full suite green.

- [ ] **Step 7: Commit** (main session)

Staged: `ProductEndpoints.cs`, `Program.cs`, `openapi.yaml`, `ProductEndpointsTests.cs`.
Message: `feat(orders): GET /v1/products endpoint (authenticated product catalog)`

---

### Task 3: Live E2E verification

**Files:** none (verification only).

- [ ] **Step 1: Rebuild orders + ensure the auth stack is up**

Run:
```bash
docker compose up -d --build orders
sleep 8
```

- [ ] **Step 2: Verify the endpoint live**

Run:
```bash
# no header -> 401
curl -s -o /dev/null -w "no-hdr: %{http_code}\n" http://localhost:3001/v1/products
# with header -> 200 + the seeded catalog
curl -s -w "\nwith-hdr: %{http_code}\n" -H "x-user-id: some-sub" http://localhost:3001/v1/products
```
Expected: `no-hdr: 401`; `with-hdr: 200` with a JSON array of products (Widget/Gadget/Gizmo) showing `id` (prd_…), `name`, `description`, `unitPriceCents`, `unitsInStock`.

- [ ] **Step 3: Commit** (main session) — only if any verification artifact was produced; otherwise nothing to commit (this task is a gate). Record the result in the ledger.

---

## Self-Review

**Spec coverage:**
- `GET /v1/products` returns active products as `IReadOnlyList<ProductDto>` → Task 2 (endpoint) + Task 1 (service/DTO). ✓
- Private / 401 without header via middleware, not added to allowlist → Task 2 Step 3 note + Global Constraints; verified Task 2 Step 1 + Task 3. ✓
- Read pattern (concrete Infra service, AsNoTracking, pure Application DTO) → Task 1. ✓
- Soft-deleted excluded by global filter (no manual filter) → Global Constraints + Task 1 test. ✓
- No gRPC / no caller on the endpoint → Task 2 Step 3 note. ✓
- openapi regenerated + committed → Task 2 Steps 5/7. ✓
- Testing (endpoint 200/401 + service soft-delete) → Task 1 + Task 2 tests. ✓

**Placeholder scan:** No TBD/"handle edge cases". The test-harness notes ("match the existing fixture", "if seeding impractical, assert active + note") are explicit fallbacks with a defined action, tied to reusing a real existing pattern — not placeholders.

**Type consistency:** `ProductDto(Id, Name, Description, UnitPriceCents, UnitsInStock)` identical across Tasks 1–2. `ProductReadService.GetProductsAsync(): Task<IReadOnlyList<ProductDto>>` consistent between the service (Task 1) and the endpoint consuming it (Task 2). `MapProductEndpoints` name consistent (Task 2 create + Program.cs wire).

## Related

- [[2026-07-16-orders-list-products-endpoint-design]]
- [[orders-service-design]]
- [[cqrs]]
