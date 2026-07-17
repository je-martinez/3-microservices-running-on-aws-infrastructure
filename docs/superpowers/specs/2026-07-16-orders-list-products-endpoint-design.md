---
title: Orders — List Products Endpoint Design
type: spec
area: orders
status: draft
created: 2026-07-16
updated: 2026-07-16
tags:
  - type/spec
  - area/orders
  - status/draft
related:
  - "[[orders-service-design]]"
  - "[[cqrs]]"
  - "[[soft-delete]]"
  - "[[versioning]]"
---

# Orders — List Products Endpoint Design

## Summary

Add a new authenticated read endpoint `GET /v1/products` to the Orders service that returns the
active product catalog from the database. Product data exists today (the `Product` entity,
`product` table, seed data, and the create-order stock-locking flow) but there is NO read path that
exposes it — `OrdersReadDbContext.Products` is defined but unused by any read service. This design
adds a `ProductReadService`, a `ProductDto`, and a `ProductEndpoints` route group, mirroring the
existing `OrderReadService` / `OrderDto` / `OrderEndpoints` pattern exactly.

The endpoint is **private** (requires `x-user-id`): it is gated by the existing
`CallerContextMiddleware` and is NOT added to the public-route allowlist. It does not use the caller
for filtering (products have no owner) — only the presence of the header, which the middleware
already guarantees.

## Goals

- `GET /v1/products` returns all active products (soft-deleted excluded) as `IReadOnlyList<ProductDto>`.
- Authenticated: 401 without `x-user-id` (via the middleware, no per-endpoint check).
- Follow the established Orders read pattern (concrete Infrastructure read service, `AsNoTracking`,
  pure Application DTO record, Minimal-API endpoint with `.Produces<T>`).

## Non-Goals

- Pagination, filtering, or sorting — the local catalog is tiny (3 seeded products); YAGNI.
- A single-product `GET /v1/products/{id}` — not requested.
- Any write path (create/update/delete products) — read-only.
- Exposing audit/soft-delete metadata on the DTO.
- gRPC / internal `usr_` id resolution — products have no owner, reads stay gRPC-free.

## Endpoint

`GET /v1/products`

- **Auth:** private. Gated by `CallerContextMiddleware` (any route not in `PublicRoutes.IsPublic` —
  which is only `GET /v1/health` — requires `x-user-id`). No change to the allowlist. No
  per-endpoint auth check.
- **Responses:**
  - `200 OK` → `IReadOnlyList<ProductDto>` (all active products; empty list if none).
  - `401 Unauthorized` → missing `x-user-id` (from the middleware).

### ProductDto

A pure Application record (no EF), alongside `OrderDto.cs`:

```csharp
public record ProductDto(
    string Id,
    string Name,
    string Description,
    long UnitPriceCents,
    uint UnitsInStock);
```

Money is exposed as integer cents, consistent with `OrderDto` and the service's money convention.
No audit or soft-delete fields.

## Structure (mirrors the Orders read pattern)

- **`src/Orders.Application/Orders/ProductDto.cs`** — the record above. Pure, no dependencies.
- **`src/Orders.Infrastructure/Orders/ProductReadService.cs`** — concrete class (not
  interface-backed, matching `OrderReadService`), constructor-injects `OrdersReadDbContext`. A
  `GetProductsAsync()` method runs `_db.Products.AsNoTracking()` and maps each entity to `ProductDto`
  via a private static `Map`. Lives in Infrastructure (not Application) per the same
  dependency-direction rule as `OrderReadService` (a class touching a DbContext stays in
  Infrastructure). Soft-deleted rows are excluded automatically by the global query filter
  (`HasQueryFilter(p => p.DeletedAt == null)` in `ProductConfiguration`).
- **`src/Orders.Api/Endpoints/ProductEndpoints.cs`** — `MapProductEndpoints(this WebApplication app)`
  registering a `/v1/products` group with `.WithTags("Products")`. `MapGet("", ...)` injects
  `ProductReadService` as a handler parameter, returns `Results.Ok(await reads.GetProductsAsync())`,
  and declares `.WithName("GetProducts")`, `.WithSummary(...)`, `.Produces<IReadOnlyList<ProductDto>>(200)`,
  `.Produces(401)`.
- **DI:** `builder.Services.AddScoped<ProductReadService>();` next to `OrderReadService` in
  `Program.cs`; `app.MapProductEndpoints();` next to `app.MapOrderEndpoints();`.

## OpenAPI (GOLDEN RULE)

A new route changes the contract, so `services/orders/openapi.yaml` MUST be regenerated and committed
with the code. Regenerate via `dotnet build` (build-time generation — there is no separate script).
`ProductDto` will surface as `#/components/schemas/ProductDto` (the generator prunes unreferenced
schemas, so it appears because `.Produces<IReadOnlyList<ProductDto>>` references it). Verify the new
`GET /v1/products` path is present with its 200/401 responses and that the document stays OpenAPI 3.1.

## Testing

- **Endpoint test** (via `OrdersApiFactory`): `GET /v1/products` with `x-user-id` → 200 with the
  seeded products; without the header → 401 (the middleware gate).
- **`ProductReadService` test:** returns the active products mapped to `ProductDto`; a soft-deleted
  product is excluded (the global query filter). Uses the Testcontainers-MySQL harness like the
  existing read tests.

## Verification

- `dotnet build && dotnet test` green; `openapi.yaml` regenerated and contains `GET /v1/products`
  + `ProductDto`.
- Live: `GET /v1/products` with `x-user-id` returns the seeded catalog (Widget/Gadget/Gizmo) as
  JSON with cents pricing; without the header returns 401.

## Related

- [[orders-service-design]]
- [[cqrs]]
- [[soft-delete]]
- [[versioning]]
