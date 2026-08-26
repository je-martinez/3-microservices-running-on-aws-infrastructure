---
title: Cart Endpoints + Money Representation Implementation Plan
type: plan
area: orders
status: active
created: 2026-08-25
updated: 2026-08-25
tags:
  - type/plan
  - area/orders
  - status/active
propagates-to:
  - "[[orders-service-design]]"
  - "[[nano-id]]"
  - "[[money-representation]]"
related:
  - "[[2026-08-25-cart-endpoints-design]]"
  - "[[orders-service-design]]"
  - "[[nano-id]]"
  - "[[soft-delete]]"
  - "[[audit-fields]]"
  - "[[db-naming]]"
  - "[[testing]]"
  - "[[cqrs]]"
  - "[[money-representation]]"
---

# Cart Endpoints + Money Representation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all cart state and money calculation out of the frontend and into the Orders service: three `/v1/cart` endpoints backed by a new Cart aggregate, and a `Money` object that reports every amount in both cents and dollars across every Orders DTO.

**Architecture:** A new `Cart`/`CartItem` aggregate in Orders, with the "one active cart per user" invariant enforced by a database unique index over a generated column rather than by a C# check (which would race). `CartItem` stores no price — every read resolves price, name, image and stock live from the catalogue in one batched query, so the user always sees real prices and each line reports its own availability verdict instead of failing the request. `PUT /v1/cart` is a full replacement of the item set; a cart left with no live lines is deleted, which is the single invariant behind all four deletion paths. Separately, a `Money` record replaces every loose `*_cents` field in the HTTP DTOs, leaving persistence (`bigint`) and the `ORDER_CREATED` SQS envelope untouched.

**Tech Stack:** .NET 10 Minimal APIs, C#, EF Core 9 (Pomelo MySQL 9.0.0), Aurora MySQL (MySQL 8 locally via Floci), xUnit + Testcontainers-MySQL, Playwright (E2E).

**Spec:** `docs/superpowers/specs/2026-08-25-cart-endpoints-design.md`

## Global Constraints

- **Money is stored as integer cents** in `bigint` `_cents` columns, mapped to `long` in C#. Never `decimal`/`float` for stored money. `Money` is a DTO/HTTP-layer concern only — entities and columns do not change.
- **The `ORDER_CREATED` SQS envelope does NOT change.** It is a contract with events-pipeline, which has its own tests.
- **Soft-delete only.** The `orders_app` DB user has no `DELETE` grant. "Delete" always means setting `deleted_at`. See [[soft-delete]] / [[ADR-0004-soft-delete-only]].
- **Nano-id format:** alphabet is letters+digits only, random portion 24 chars, prefix 4 chars (`xxx_`), total stored width `NanoIdConfig.TotalLength` = 28. Every id column must be sized `NanoIdConfig.TotalLength` — MySQL truncates silently otherwise.
- **DB naming:** `snake_case` columns ↔ PascalCase properties. Table names singular (`order`, `product`) — so `cart`, `cart_item`.
- **Audit fields** on every entity via `ProductConfiguration.ApplyAudit(b)`; writes run under `AmbientActor.RunAsync(AuditActor.X, ...)` so `created_by`/`updated_by` read `orders_api:<action>`.
- **Every entity gets `b.HasQueryFilter(x => x.DeletedAt == null)`** — EF then excludes soft-deleted rows from every query automatically.
- **`openapi.yaml` is generated at build time** by `dotnet build`. A route or DTO change without a regenerated, committed `openapi.yaml` is an incomplete change. See `services/orders/CLAUDE.md` §2a.
- **Three test layers per endpoint** (§2b): unit/integration (xUnit + Testcontainers), internal E2E, gateway E2E with a real Cognito JWT. An endpoint without gateway E2E is incomplete.
- **API versioning:** all routes under `/v1`.
- **Never log** prices, cart contents, request bodies, or PII.
- Work happens on branch `feature/cart-endpoints`.

---

## File Structure

**New files:**

| File | Responsibility |
|---|---|
| `src/Orders.Domain/Money.cs` | The `Money` record + `FromCents` factory. Invariant-culture formatting. |
| `src/Orders.Domain/Entities/Cart.cs` | `Cart` entity: user ids, audit fields, `Items`. |
| `src/Orders.Domain/Entities/CartItem.cs` | `CartItem` entity: `CartId`, `ProductId`, `Quantity`. |
| `src/Orders.Application/Carts/CartDto.cs` | `CartDto`, `CartLineDto`, `UnavailableReason`. |
| `src/Orders.Application/Carts/UpdateCartCommand.cs` | `UpdateCartCommand` + `CartLineInput`. |
| `src/Orders.Infrastructure/Persistence/Configurations/CartConfiguration.cs` | EF mapping for `cart`, incl. the active-user unique index. |
| `src/Orders.Infrastructure/Persistence/Configurations/CartItemConfiguration.cs` | EF mapping for `cart_item`. |
| `src/Orders.Infrastructure/Carts/CartReadService.cs` | Reads a cart, resolves the catalogue, computes verdicts + totals. |
| `src/Orders.Infrastructure/Carts/CartWriteService.cs` | `PUT` replacement, `DELETE`, and the shared deletion path. |
| `src/Orders.Infrastructure/Carts/CartPricing.cs` | Pure cart-level totals from priced lines. |
| `src/Orders.Api/Endpoints/CartEndpoints.cs` | The three routes + request records + validation. |

**Modified files:**

| File | Change |
|---|---|
| `src/Orders.Infrastructure/Id/NanoId.cs` | Add `CartPrefix` (`crt_`), `CartItemPrefix` (`cti_`) to config, `Prefixes`, and `NanoId`. |
| `src/Orders.Application/Abstractions/AuditActor.cs` | Add `UpdateCart`, `DeleteCart`. |
| `src/Orders.Infrastructure/Persistence/OrdersWriteDbContext.cs` | `DbSet`s + `ApplyConfiguration` for both new entities. |
| `src/Orders.Infrastructure/Persistence/OrdersReadDbContext.cs` | Same. |
| `src/Orders.Application/Orders/OrderDto.cs` | `*_cents` fields → `Money`. |
| `src/Orders.Application/Orders/ProductDto.cs` | `UnitPriceCents` → `Money`. |
| `src/Orders.Infrastructure/Orders/OrderReadService.cs` | Map to `Money`. |
| `src/Orders.Infrastructure/Orders/CreateOrderService.cs` | Map to `Money`; delete the caller's active cart in-transaction. |
| `src/Orders.Infrastructure/Orders/ProductReadService.cs` | Map to `Money`. |
| `src/Orders.Api/Program.cs` | DI for the two cart services; `MapCartEndpoints`. |
| `services/orders/openapi.yaml` | Regenerated. |
| `e2e/tests/**` | Money shape updates + new cart specs. |

**Why these boundaries:** `CartPricing` is separated from `CartReadService` because totals are pure arithmetic that must be unit-testable without a database — the same reason `OrderPricing` exists apart from `CreateOrderService`. `CartReadService` and `CartWriteService` split along the CQRS line the service already follows (read replica vs. write replica). Both live in `Orders.Infrastructure`, not `Orders.Application`, because they touch a `DbContext` — Application must never reference EF Core, and `OrderReadService`/`CreateOrderService` already sit in Infrastructure for exactly this reason.

---

## Task 1: The `Money` object

Introduces the type without changing any DTO yet, so it can be reviewed on its own.

**Files:**
- Create: `services/orders/src/Orders.Domain/Money.cs`
- Test: `services/orders/tests/Orders.Tests/Domain/MoneyTests.cs`

**Interfaces:**
- Consumes: nothing.
- Produces: `Orders.Domain.Money` — `public sealed record Money(long Cents, string Amount, string Formatted, string Currency)` with `public static Money FromCents(long cents)` and `public const string Usd = "USD"`.

- [ ] **Step 1: Write the failing test**

Create `services/orders/tests/Orders.Tests/Domain/MoneyTests.cs`:

```csharp
using Orders.Domain;
using Xunit;

namespace Orders.Tests.Domain;

public class MoneyTests
{
    [Theory]
    [InlineData(0L, "0.00", "$0.00")]
    [InlineData(5L, "0.05", "$0.05")]
    [InlineData(320L, "3.20", "$3.20")]
    [InlineData(3998L, "39.98", "$39.98")]
    [InlineData(100000L, "1000.00", "$1,000.00")]
    public void FromCents_formats_amount_and_display(long cents, string amount, string formatted)
    {
        var money = Money.FromCents(cents);

        Assert.Equal(cents, money.Cents);
        Assert.Equal(amount, money.Amount);
        Assert.Equal(formatted, money.Formatted);
        Assert.Equal("USD", money.Currency);
    }

    // The whole point of pinning the culture. Under a de-DE container default,
    // an implementation using the ambient culture emits "39,98" and every client
    // parsing `amount` as a decimal breaks — silently, and only in that deployment.
    [Fact]
    public void FromCents_is_independent_of_the_ambient_culture()
    {
        var original = System.Globalization.CultureInfo.CurrentCulture;
        try
        {
            System.Globalization.CultureInfo.CurrentCulture =
                new System.Globalization.CultureInfo("de-DE");

            var money = Money.FromCents(3998);

            Assert.Equal("39.98", money.Amount);
            Assert.Equal("$39.98", money.Formatted);
        }
        finally
        {
            System.Globalization.CultureInfo.CurrentCulture = original;
        }
    }

    // Negative amounts are not a cart concern, but Money is now the ONLY money
    // type on the wire, so it must not produce nonsense if a refund-shaped value
    // ever reaches it.
    [Fact]
    public void FromCents_handles_a_negative_amount()
    {
        var money = Money.FromCents(-1999);

        Assert.Equal(-1999, money.Cents);
        Assert.Equal("-19.99", money.Amount);
        Assert.Equal("-$19.99", money.Formatted);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd services/orders && dotnet test --filter FullyQualifiedName~MoneyTests`
Expected: FAIL — compile error, `Money` does not exist.

- [ ] **Step 3: Write the implementation**

Create `services/orders/src/Orders.Domain/Money.cs`:

```csharp
using System.Globalization;

namespace Orders.Domain;

/// <summary>
/// A monetary amount on the wire, reported in BOTH integer cents and display dollars.
/// </summary>
/// <remarks>
/// <para>
/// Exists so no client ever divides by 100 or formats a currency itself. Every money
/// field in this service's HTTP DTOs is a <see cref="Money"/>, never a bare number.
/// </para>
/// <para>
/// PRESENTATION ONLY. Storage stays <c>bigint</c> cents and entities keep <c>long</c>;
/// this type must not reach a DbContext, a migration, or the ORDER_CREATED SQS envelope
/// (a contract with events-pipeline). <see cref="Cents"/> remains the authoritative value —
/// <see cref="Amount"/> and <see cref="Formatted"/> are derived views of it.
/// </para>
/// <para>
/// Both strings are built with <see cref="CultureInfo.InvariantCulture"/> deliberately.
/// Under the ambient culture a container whose default is, say, de-DE would emit
/// "39,98" — breaking every client that parses <see cref="Amount"/> as a decimal, in that
/// deployment only, with no error anywhere. Currency is a constant: this repo has no
/// multi-currency support, and inventing one here would be speculative.
/// </para>
/// </remarks>
public sealed record Money(long Cents, string Amount, string Formatted, string Currency)
{
    /// <summary>The only currency this service deals in.</summary>
    public const string Usd = "USD";

    /// <summary>Builds every representation from the authoritative cents value.</summary>
    public static Money FromCents(long cents)
    {
        var dollars = cents / 100m;

        return new Money(
            cents,
            // "F2" not "C2": a plain decimal string a client can parse.
            dollars.ToString("F2", CultureInfo.InvariantCulture),
            // "C2" against en-US, so the symbol and the thousands separator are stable
            // regardless of the host's locale.
            dollars.ToString("C2", CultureInfo.GetCultureInfo("en-US")),
            Usd);
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd services/orders && dotnet test --filter FullyQualifiedName~MoneyTests`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add services/orders/src/Orders.Domain/Money.cs services/orders/tests/Orders.Tests/Domain/MoneyTests.cs
git commit -m "feat(orders): add Money value type reporting cents and dollars"
```

---

## Task 2: Swap every Orders DTO to `Money`

The breaking DTO change, done in one task so the build is never half-migrated. The user confirmed there are no external consumers.

**Files:**
- Modify: `services/orders/src/Orders.Application/Orders/OrderDto.cs`
- Modify: `services/orders/src/Orders.Application/Orders/ProductDto.cs`
- Modify: `services/orders/src/Orders.Infrastructure/Orders/OrderReadService.cs`
- Modify: `services/orders/src/Orders.Infrastructure/Orders/CreateOrderService.cs`
- Modify: `services/orders/src/Orders.Infrastructure/Orders/ProductReadService.cs`
- Modify: `services/orders/openapi.yaml` (regenerated)
- Test: `services/orders/tests/Orders.Tests/Api/` (existing assertions updated)

**Interfaces:**
- Consumes: `Money.FromCents` (Task 1).
- Produces: `OrderDto(string Id, string UserId, string CognitoSub, Money Subtotal, Money Tax, Money Shipping, Money Total, DateTime CreatedAt, IReadOnlyList<OrderLineDto> Lines)`; `OrderLineDto(string ProductId, uint Quantity, Money Subtotal, Money Tax, Money Total)`; `ProductDto(string Id, string Name, string Description, Money UnitPrice, uint UnitsInStock, IReadOnlyList<string> Categories, ProductImageDto? Image)`.

- [ ] **Step 1: Update the DTO records**

In `services/orders/src/Orders.Application/Orders/OrderDto.cs`, replace the two records with:

```csharp
using Orders.Domain;

namespace Orders.Application.Orders;

public record OrderLineDto(string ProductId, uint Quantity, Money Subtotal, Money Tax, Money Total);

public record OrderDto(
    string Id,
    string UserId,
    string CognitoSub,
    Money Subtotal,
    Money Tax,
    // Order-level, not per-line: charged once per shipment, which is why
    // OrderLineDto has no counterpart. Exposed so a client can show the same
    // breakdown the confirmation email prints — without it, Total is
    // unexplainable from the other figures a caller can see.
    Money Shipping,
    Money Total,
    DateTime CreatedAt,
    IReadOnlyList<OrderLineDto> Lines);
```

In `services/orders/src/Orders.Application/Orders/ProductDto.cs`:

```csharp
using Orders.Domain;

namespace Orders.Application.Orders;

// Pure read DTO for the product catalog. Money is reported in cents AND dollars
// via Money, so no client divides by 100. No audit/soft-delete fields.
public record ProductDto(
    string Id,
    string Name,
    string Description,
    Money UnitPrice,
    uint UnitsInStock,
    IReadOnlyList<string> Categories,
    ProductImageDto? Image);
```

- [ ] **Step 2: Run the build to enumerate every call site**

Run: `cd services/orders && dotnet build`
Expected: FAIL, with a compile error at each place constructing an `OrderDto`, `OrderLineDto` or `ProductDto` from `long`s. That error list is the exact work list for the next step — do not guess at the call sites.

- [ ] **Step 3: Fix each mapping site**

In every location the build flagged, wrap the existing cents value in `Money.FromCents(...)`. The mapping in `OrderReadService.Map` becomes:

```csharp
private static OrderDto Map(Order order) => new(
    order.Id,
    order.UserId,
    order.CognitoSub,
    Money.FromCents(order.SubtotalCents),
    Money.FromCents(order.TaxCents),
    Money.FromCents(order.ShippingCents),
    Money.FromCents(order.TotalCents),
    order.CreatedAt,
    order.Details
        .Select(d => new OrderLineDto(
            d.ProductId,
            d.Quantity,
            Money.FromCents(d.SubtotalCents),
            Money.FromCents(d.TaxCents),
            Money.FromCents(d.TotalCents)))
        .ToList());
```

and the product mapping in `ProductReadService` becomes:

```csharp
private ProductDto Map(Product p) => new(
    p.Id,
    p.Name,
    p.Description,
    Money.FromCents(p.UnitPriceCents),
    p.UnitsInStock,
    p.Categories,
    p.Image is null
        ? null
        : new ProductImageDto(
            $"{_assetsBaseUrl}/{p.Image.Uri}",
            p.Image.Width,
            p.Image.Height,
            p.Image.Blurhash));
```

Add `using Orders.Domain;` to each file you touch. Apply the same `Money.FromCents(...)` wrapping in `CreateOrderService` wherever it builds an `OrderDto`.

**Do NOT change** the entity properties, the EF configurations, any migration, or `SqsEventPublisher` — the SQS envelope keeps raw cents.

- [ ] **Step 4: Verify the build passes**

Run: `cd services/orders && dotnet build`
Expected: PASS, no errors.

- [ ] **Step 5: Update the existing tests that assert on money fields**

Run: `cd services/orders && dotnet test`
Expected: FAIL — assertions reading e.g. `dto.SubtotalCents` no longer compile.

Update each to read through `Money`: `dto.Subtotal.Cents` for the numeric assertion. Where a test asserted a total, add one assertion on the dollar view so the new contract is actually covered, e.g.:

```csharp
Assert.Equal(3998, dto.Subtotal.Cents);
Assert.Equal("39.98", dto.Subtotal.Amount);
```

Verify the SQS envelope test still asserts raw cents and is UNCHANGED — if that test needed editing, the envelope was altered by mistake and must be reverted.

- [ ] **Step 6: Run the full suite**

Run: `cd services/orders && dotnet test`
Expected: PASS, including `TrackingContractTests`.

- [ ] **Step 7: Regenerate `openapi.yaml`**

Run: `cd services/orders && dotnet build`

Confirm `openapi.yaml` now shows a `Money` component schema and that `OrderDto`/`ProductDto` reference it instead of `*_cents` integers:

Run: `grep -n "Money" services/orders/openapi.yaml | head`
Expected: a `Money` schema plus `$ref` hits.

- [ ] **Step 8: Commit**

```bash
git add services/orders/src services/orders/tests services/orders/openapi.yaml
git commit -m "feat(orders)!: report every DTO amount in cents and dollars via Money

BREAKING CHANGE: OrderDto, OrderLineDto and ProductDto replace their *_cents
integer fields with Money objects carrying cents, amount, formatted and currency.
The ORDER_CREATED SQS envelope is unchanged."
```

---

## Task 3: Cart entities, id prefixes and the migration

Schema only. No endpoint yet, so the invariant can be reviewed in isolation.

**Files:**
- Create: `services/orders/src/Orders.Domain/Entities/Cart.cs`
- Create: `services/orders/src/Orders.Domain/Entities/CartItem.cs`
- Create: `services/orders/src/Orders.Infrastructure/Persistence/Configurations/CartConfiguration.cs`
- Create: `services/orders/src/Orders.Infrastructure/Persistence/Configurations/CartItemConfiguration.cs`
- Modify: `services/orders/src/Orders.Infrastructure/Id/NanoId.cs`
- Modify: `services/orders/src/Orders.Infrastructure/Persistence/OrdersWriteDbContext.cs`
- Modify: `services/orders/src/Orders.Infrastructure/Persistence/OrdersReadDbContext.cs`
- Test: `services/orders/tests/Orders.Tests/Infrastructure/CartSchemaTests.cs`

**Interfaces:**
- Consumes: `NanoIdConfig.TotalLength`, `ProductConfiguration.ApplyAudit`.
- Produces: `Cart` (`Id`, `UserId`, `CognitoSub`, `Items`), `CartItem` (`Id`, `CartId`, `ProductId`, `Quantity`), `NanoId.CartPrefix` = `"crt_"`, `NanoId.CartItemPrefix` = `"cti_"`, `OrdersWriteDbContext.Carts`, `.CartItems`.

- [ ] **Step 1: Add the id prefixes**

In `services/orders/src/Orders.Infrastructure/Id/NanoId.cs`, add to `NanoIdConfig` after `OrderDetailPrefix`:

```csharp
    /// <inheritdoc cref="ProductPrefix"/>
    public const string CartPrefix = "crt_";

    /// <inheritdoc cref="ProductPrefix"/>
    public const string CartItemPrefix = "cti_";
```

Add both to the `Prefixes` list (after `OrderDetailPrefix`), and expose them on `NanoId` alongside the existing re-exports:

```csharp
    /// <inheritdoc cref="NanoIdConfig.CartPrefix"/>
    public const string CartPrefix = NanoIdConfig.CartPrefix;

    /// <inheritdoc cref="NanoIdConfig.CartItemPrefix"/>
    public const string CartItemPrefix = NanoIdConfig.CartItemPrefix;
```

- [ ] **Step 2: Write the entities**

Create `services/orders/src/Orders.Domain/Entities/Cart.cs`:

```csharp
namespace Orders.Domain.Entities;

/// <summary>
/// A user's in-progress selection of products. At most ONE active cart per user.
/// </summary>
/// <remarks>
/// <para>
/// The one-active-cart invariant is enforced by a UNIQUE INDEX in the database
/// (see CartConfiguration), not by a check in service code — two concurrent
/// requests would both pass a "does one already exist?" read and both insert.
/// </para>
/// <para>
/// A cart with no live lines DOES NOT EXIST: emptying a cart deletes it. See
/// CartWriteService, which routes every deletion path through one method.
/// </para>
/// </remarks>
public class Cart : AuditableEntity
{
    public string UserId { get; set; } = string.Empty;      // internal usr_ id
    public string CognitoSub { get; set; } = string.Empty;  // from the gateway

    public List<CartItem> Items { get; set; } = new();
}
```

Create `services/orders/src/Orders.Domain/Entities/CartItem.cs`:

```csharp
namespace Orders.Domain.Entities;

/// <summary>One product and its quantity within a <see cref="Cart"/>.</summary>
/// <remarks>
/// Carries NO price, deliberately. The catalogue price is resolved live on every
/// read, so the user always sees the current price and there is never a frozen
/// figure that disagrees with what checkout actually charges. An Order is the
/// opposite — it freezes its prices, because a past order must keep reporting
/// what it really cost.
/// </remarks>
public class CartItem : AuditableEntity
{
    public string CartId { get; set; } = string.Empty;
    public string ProductId { get; set; } = string.Empty;
    public uint Quantity { get; set; }
}
```

- [ ] **Step 3: Write the EF configurations**

Create `services/orders/src/Orders.Infrastructure/Persistence/Configurations/CartConfiguration.cs`:

```csharp
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;

namespace Orders.Infrastructure.Persistence.Configurations;

public class CartConfiguration : IEntityTypeConfiguration<Cart>
{
    /// <summary>
    /// The generated column backing the one-active-cart invariant: it equals
    /// <c>user_id</c> while the row is live and is NULL once soft-deleted. MySQL
    /// ignores NULLs in a unique index, so a user may accumulate any number of
    /// deleted carts and at most one active one.
    /// </summary>
    public const string ActiveUserIdColumn = "active_user_id";

    public void Configure(EntityTypeBuilder<Cart> b)
    {
        b.ToTable("cart");
        b.HasKey(c => c.Id);
        b.Property(c => c.Id).HasColumnName("id").HasMaxLength(NanoIdConfig.TotalLength);
        b.Property(c => c.UserId).HasColumnName("user_id").HasMaxLength(NanoIdConfig.TotalLength);
        b.Property(c => c.CognitoSub).HasColumnName("cognito_sub").HasMaxLength(255);
        ProductConfiguration.ApplyAudit(b);
        b.Ignore(c => c.IsDeleted);

        b.HasMany(c => c.Items).WithOne().HasForeignKey(i => i.CartId);

        // The invariant itself. Declared as a STORED generated column so the unique
        // index can cover it; a virtual column cannot be indexed the same way across
        // MySQL versions. The expression must stay in sync with the query filter
        // below — both define "active" as deleted_at IS NULL.
        b.Property<string?>(ActiveUserIdColumn)
            .HasColumnName(ActiveUserIdColumn)
            .HasMaxLength(NanoIdConfig.TotalLength)
            .HasComputedColumnSql(
                "(CASE WHEN `deleted_at` IS NULL THEN `user_id` ELSE NULL END)",
                stored: true);

        b.HasIndex(ActiveUserIdColumn)
            .IsUnique()
            .HasDatabaseName("uq_cart_active_user_id");

        b.HasIndex(c => c.CognitoSub).HasDatabaseName("idx_cart_cognito_sub");
        b.HasIndex(c => c.DeletedAt).HasDatabaseName("idx_cart_deleted_at");
        b.HasQueryFilter(c => c.DeletedAt == null);
    }
}
```

Create `services/orders/src/Orders.Infrastructure/Persistence/Configurations/CartItemConfiguration.cs`:

```csharp
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;

namespace Orders.Infrastructure.Persistence.Configurations;

public class CartItemConfiguration : IEntityTypeConfiguration<CartItem>
{
    /// <summary>
    /// Same trick as CartConfiguration.ActiveUserIdColumn, one level down: it holds
    /// the cart id while the line is live and NULL once soft-deleted, so a cart cannot
    /// hold two live lines for the same product while keeping its deleted history.
    /// </summary>
    public const string ActiveCartIdColumn = "active_cart_id";

    public void Configure(EntityTypeBuilder<CartItem> b)
    {
        b.ToTable("cart_item");
        b.HasKey(i => i.Id);
        b.Property(i => i.Id).HasColumnName("id").HasMaxLength(NanoIdConfig.TotalLength);
        b.Property(i => i.CartId).HasColumnName("cart_id").HasMaxLength(NanoIdConfig.TotalLength);
        b.Property(i => i.ProductId).HasColumnName("product_id").HasMaxLength(NanoIdConfig.TotalLength);
        // uint maps to MySQL `int unsigned`; a cart line is never negative and the
        // API rejects a negative quantity before it reaches here.
        b.Property(i => i.Quantity).HasColumnName("quantity");
        ProductConfiguration.ApplyAudit(b);
        b.Ignore(i => i.IsDeleted);

        b.Property<string?>(ActiveCartIdColumn)
            .HasColumnName(ActiveCartIdColumn)
            .HasMaxLength(NanoIdConfig.TotalLength)
            .HasComputedColumnSql(
                "(CASE WHEN `deleted_at` IS NULL THEN `cart_id` ELSE NULL END)",
                stored: true);

        b.HasIndex(ActiveCartIdColumn, nameof(CartItem.ProductId))
            .IsUnique()
            .HasDatabaseName("uq_cart_item_active_cart_product");

        b.HasIndex(i => i.DeletedAt).HasDatabaseName("idx_cart_item_deleted_at");
        b.HasQueryFilter(i => i.DeletedAt == null);
    }
}
```

- [ ] **Step 4: Register both entities on the two contexts**

In `OrdersWriteDbContext.cs`, add the `DbSet`s after `Configurations`:

```csharp
    public DbSet<Cart> Carts => Set<Cart>();
    public DbSet<CartItem> CartItems => Set<CartItem>();
```

and in `OnModelCreating`:

```csharp
        modelBuilder.ApplyConfiguration(new CartConfiguration());
        modelBuilder.ApplyConfiguration(new CartItemConfiguration());
```

Apply the identical two additions to `OrdersReadDbContext.cs`. Both contexts must map the same model — a divergence means reads and writes disagree about the schema.

- [ ] **Step 5: Create the migration**

Run from `services/orders`:

```bash
dotnet ef migrations add AddCart \
  --project src/Orders.Infrastructure \
  --startup-project src/Orders.Infrastructure \
  --context OrdersWriteDbContext
```

Note the startup project is **Infrastructure, not Api** (see `services/orders/CLAUDE.md` §2).

Open the generated migration and confirm it creates `cart` and `cart_item`, both computed columns, and both unique indexes. If the computed columns are missing, the `HasComputedColumnSql` calls did not take — fix before continuing rather than hand-editing the migration.

- [ ] **Step 6: Write the schema test**

Create `services/orders/tests/Orders.Tests/Infrastructure/CartSchemaTests.cs`:

```csharp
using Microsoft.EntityFrameworkCore;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;
using Orders.Tests.Api;
using Xunit;

namespace Orders.Tests.Infrastructure;

[Collection(nameof(OrdersApiCollection))]
public class CartSchemaTests
{
    private readonly OrdersApiFactory _factory;

    public CartSchemaTests(OrdersApiFactory factory) => _factory = factory;

    // The invariant this whole design rests on. If the index is missing or its
    // expression is wrong, this passes silently in code review and fails in
    // production as two live carts for one user.
    [Fact]
    public async Task A_user_cannot_hold_two_active_carts()
    {
        await using var db = _factory.NewWriteContext();
        var userId = NanoId.NewId("usr_");

        db.Carts.Add(new Cart { Id = NanoId.NewId(NanoId.CartPrefix), UserId = userId, CognitoSub = "sub-a" });
        await db.SaveChangesAsync();

        db.Carts.Add(new Cart { Id = NanoId.NewId(NanoId.CartPrefix), UserId = userId, CognitoSub = "sub-a" });

        await Assert.ThrowsAnyAsync<DbUpdateException>(() => db.SaveChangesAsync());
    }

    // The other half: soft-deleting frees the slot. Without the CASE expression the
    // unique index would block a user from ever starting a second cart.
    [Fact]
    public async Task A_soft_deleted_cart_frees_the_slot()
    {
        await using var db = _factory.NewWriteContext();
        var userId = NanoId.NewId("usr_");

        var first = new Cart { Id = NanoId.NewId(NanoId.CartPrefix), UserId = userId, CognitoSub = "sub-b" };
        db.Carts.Add(first);
        await db.SaveChangesAsync();

        first.DeletedAt = DateTime.UtcNow;
        await db.SaveChangesAsync();

        db.Carts.Add(new Cart { Id = NanoId.NewId(NanoId.CartPrefix), UserId = userId, CognitoSub = "sub-b" });

        // No throw: the deleted row's generated column is NULL, which the unique index ignores.
        await db.SaveChangesAsync();
    }

    [Fact]
    public async Task A_cart_cannot_hold_two_active_lines_for_one_product()
    {
        await using var db = _factory.NewWriteContext();
        var cart = new Cart { Id = NanoId.NewId(NanoId.CartPrefix), UserId = NanoId.NewId("usr_"), CognitoSub = "sub-c" };
        db.Carts.Add(cart);
        await db.SaveChangesAsync();

        var productId = _factory.SeededProductId;
        db.CartItems.Add(new CartItem { Id = NanoId.NewId(NanoId.CartItemPrefix), CartId = cart.Id, ProductId = productId, Quantity = 1 });
        await db.SaveChangesAsync();

        db.CartItems.Add(new CartItem { Id = NanoId.NewId(NanoId.CartItemPrefix), CartId = cart.Id, ProductId = productId, Quantity = 2 });

        await Assert.ThrowsAnyAsync<DbUpdateException>(() => db.SaveChangesAsync());
    }
}
```

If `OrdersApiFactory` has no `NewWriteContext()` helper, add one that returns a fresh `OrdersWriteDbContext` over the container's connection string, mirroring how `InitializeAsync` builds one. If the factory is not exposed through a collection fixture named `OrdersApiCollection`, follow whatever fixture pattern the neighbouring tests in `tests/Orders.Tests/Api/` already use rather than inventing a second one.

- [ ] **Step 7: Run the tests**

Run: `cd services/orders && dotnet test --filter FullyQualifiedName~CartSchemaTests`
Expected: PASS — 3 tests. Requires Docker for Testcontainers.

- [ ] **Step 8: Commit**

```bash
git add services/orders/src services/orders/tests
git commit -m "feat(orders): add cart and cart_item schema with one-active-cart invariant"
```

---

## Task 4: Cart DTOs and pure totals

Pure types and arithmetic — no database, no HTTP. Fast to test and it locks the contract every later task maps onto.

**Files:**
- Create: `services/orders/src/Orders.Application/Carts/CartDto.cs`
- Create: `services/orders/src/Orders.Application/Carts/UpdateCartCommand.cs`
- Create: `services/orders/src/Orders.Infrastructure/Carts/CartPricing.cs`
- Test: `services/orders/tests/Orders.Tests/Domain/CartPricingTests.cs`

**Interfaces:**
- Consumes: `Money` (Task 1), `OrderPricing.PriceLine`, `ProductImageDto`.
- Produces: `CartDto`, `CartLineDto`, `UnavailableReason`, `UpdateCartCommand`, `CartLineInput`, and `CartPricing.Totalize(IReadOnlyList<CartLineDto>, decimal taxRate, long shippingCents)` returning `(Money Subtotal, Money Tax, Money Shipping, Money Total, bool CanCheckout)`.

- [ ] **Step 1: Write the DTOs**

Create `services/orders/src/Orders.Application/Carts/CartDto.cs`:

```csharp
using Orders.Application.Orders;
using Orders.Domain;

namespace Orders.Application.Carts;

/// <summary>Why a cart line cannot currently be bought.</summary>
/// <remarks>
/// Serialized as the snake_case strings the API contract names. Absent — never null —
/// when the line IS available, per the omit-unknown-fields convention.
/// </remarks>
public static class UnavailableReason
{
    /// <summary>The product no longer exists in the catalogue (or was deleted).</summary>
    public const string UnknownProduct = "unknown_product";

    /// <summary>The product exists but has no units at all.</summary>
    public const string OutOfStock = "out_of_stock";

    /// <summary>Some units remain, but fewer than the line asks for.</summary>
    public const string InsufficientStock = "insufficient_stock";
}

/// <summary>One line of the cart, priced live from the catalogue.</summary>
/// <param name="UnitPrice">
/// Null only for <see cref="UnavailableReason.UnknownProduct"/> — there is no catalogue
/// row left to read a price from.
/// </param>
/// <param name="Subtotal">
/// What this line WOULD cost (unit price × quantity). Always reported, even when the line
/// is unavailable, so the frontend can render it normally with an unavailable badge. An
/// unavailable line is excluded from the CART totals, not from its own.
/// </param>
/// <param name="UnavailableReason">Omitted when <paramref name="Available"/> is true.</param>
public record CartLineDto(
    string ProductId,
    string? Name,
    uint Quantity,
    uint UnitsInStock,
    bool Available,
    Money? UnitPrice,
    Money? Subtotal,
    ProductImageDto? Image,
    string? UnavailableReason);

/// <summary>The whole cart, fully calculated so the frontend computes nothing.</summary>
/// <param name="Id">Null when the user has no cart — an empty cart is a 200, not a 404.</param>
/// <param name="CanCheckout">
/// True only when there is at least one line and EVERY line is available. A hint for
/// enabling the checkout button — NOT a guarantee: another buyer may take the last unit
/// between this read and POST /v1/orders, which is why order creation still locks stock
/// with SELECT ... FOR UPDATE and may return 409.
/// </param>
public record CartDto(
    string? Id,
    IReadOnlyList<CartLineDto> Items,
    Money Subtotal,
    Money Tax,
    Money Shipping,
    Money Total,
    bool CanCheckout);
```

Create `services/orders/src/Orders.Application/Carts/UpdateCartCommand.cs`:

```csharp
namespace Orders.Application.Carts;

/// <param name="Quantity">
/// Zero means REMOVE this line — it is a valid instruction, not an error. Negative values
/// are rejected at the API boundary before a command is ever built.
/// </param>
public record CartLineInput(string ProductId, uint Quantity);

/// <summary>
/// A full REPLACEMENT of the cart's line set: whatever is not in <paramref name="Items"/>
/// is removed. An empty list therefore deletes the cart.
/// </summary>
public record UpdateCartCommand(IReadOnlyList<CartLineInput> Items);
```

- [ ] **Step 2: Write the failing pricing test**

Create `services/orders/tests/Orders.Tests/Domain/CartPricingTests.cs`:

```csharp
using Orders.Application.Carts;
using Orders.Domain;
using Orders.Infrastructure.Carts;
using Xunit;

namespace Orders.Tests.Domain;

public class CartPricingTests
{
    private const decimal TaxRate = 0.08m;
    private const long ShippingCents = 599;

    private static CartLineDto Available(long unitPriceCents, uint quantity) =>
        new(
            ProductId: "prd_x",
            Name: "Widget",
            Quantity: quantity,
            UnitsInStock: 50,
            Available: true,
            UnitPrice: Money.FromCents(unitPriceCents),
            Subtotal: Money.FromCents(unitPriceCents * quantity),
            Image: null,
            UnavailableReason: null);

    private static CartLineDto Unavailable(long unitPriceCents, uint quantity) =>
        new(
            ProductId: "prd_y",
            Name: "Keyboard",
            Quantity: quantity,
            UnitsInStock: 0,
            Available: false,
            UnitPrice: Money.FromCents(unitPriceCents),
            Subtotal: Money.FromCents(unitPriceCents * quantity),
            Image: null,
            UnavailableReason: UnavailableReason.OutOfStock);

    [Fact]
    public void Totals_sum_available_lines_and_add_tax_and_shipping_once()
    {
        var totals = CartPricing.Totalize(
            [Available(1999, 2)], TaxRate, ShippingCents);

        Assert.Equal(3998, totals.Subtotal.Cents);
        Assert.Equal(320, totals.Tax.Cents);              // round(3998 * 0.08) = 320
        Assert.Equal(599, totals.Shipping.Cents);
        Assert.Equal(4917, totals.Total.Cents);           // 3998 + 320 + 599
        Assert.True(totals.CanCheckout);
    }

    // Shipping is an ORDER/CART-level charge. Two lines must not be charged twice.
    [Fact]
    public void Shipping_is_charged_once_regardless_of_line_count()
    {
        var totals = CartPricing.Totalize(
            [Available(1000, 1), Available(2000, 1)], TaxRate, ShippingCents);

        Assert.Equal(3000, totals.Subtotal.Cents);
        Assert.Equal(599, totals.Shipping.Cents);
    }

    // The rule that keeps the user from being charged for what cannot ship.
    [Fact]
    public void Unavailable_lines_are_excluded_from_the_totals()
    {
        var totals = CartPricing.Totalize(
            [Available(1999, 2), Unavailable(8999, 1)], TaxRate, ShippingCents);

        Assert.Equal(3998, totals.Subtotal.Cents);        // the 8999 line is not counted
        Assert.Equal(4917, totals.Total.Cents);
        Assert.False(totals.CanCheckout);                 // ...but it does block checkout
    }

    // Shipping is ALWAYS reported, including on an empty cart: `total = subtotal + tax
    // + shipping` holds with no exceptions, which is the rule the spec states. A
    // consequence worth knowing: an empty cart reports a non-zero total. The frontend
    // must therefore not paint `total` as "what you owe" next to an empty basket.
    [Fact]
    public void An_empty_cart_still_reports_the_delivery_charge()
    {
        var totals = CartPricing.Totalize([], TaxRate, ShippingCents);

        Assert.Equal(0, totals.Subtotal.Cents);
        Assert.Equal(0, totals.Tax.Cents);
        Assert.Equal(599, totals.Shipping.Cents);
        Assert.Equal(599, totals.Total.Cents);
        Assert.False(totals.CanCheckout);
    }

    // Same rule where every line is unavailable: nothing is charged for the goods,
    // but the delivery figure is still reported unconditionally.
    [Fact]
    public void A_cart_with_only_unavailable_lines_still_reports_the_delivery_charge()
    {
        var totals = CartPricing.Totalize([Unavailable(8999, 1)], TaxRate, ShippingCents);

        Assert.Equal(0, totals.Subtotal.Cents);
        Assert.Equal(599, totals.Shipping.Cents);
        Assert.Equal(599, totals.Total.Cents);
        Assert.False(totals.CanCheckout);
    }
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd services/orders && dotnet test --filter FullyQualifiedName~CartPricingTests`
Expected: FAIL — `CartPricing` does not exist.

- [ ] **Step 4: Write `CartPricing`**

Create `services/orders/src/Orders.Infrastructure/Carts/CartPricing.cs`:

```csharp
using Orders.Application.Carts;
using Orders.Domain;
using Orders.Domain.Pricing;

namespace Orders.Infrastructure.Carts;

/// <summary>
/// Cart-level arithmetic over already-priced lines. Pure: no database, no catalogue,
/// no clock — which is why it can be unit-tested exhaustively, exactly like
/// <see cref="OrderPricing"/>.
/// </summary>
public static class CartPricing
{
    /// <summary>
    /// Sums the AVAILABLE lines, applies tax to that subtotal, and adds the flat
    /// delivery charge once.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Unavailable lines are excluded deliberately: charging for what cannot be shipped
    /// is worse than showing a smaller total. They still block <c>CanCheckout</c>, so the
    /// user is told rather than silently short-changed.
    /// </para>
    /// <para>
    /// Shipping is reported UNCONDITIONALLY — including for an empty cart, and for one
    /// whose lines are all unavailable. <c>total = subtotal + tax + shipping</c> holds
    /// with no exceptions, which is the rule as specified. The consequence is that an
    /// empty cart reports a non-zero total, so a client must not render
    /// <c>total</c> as "amount due" beside an empty basket. Do not "fix" this by zeroing
    /// shipping when nothing is shippable: that was considered and rejected, because it
    /// makes the total formula conditional.
    /// </para>
    /// </remarks>
    public static (Money Subtotal, Money Tax, Money Shipping, Money Total, bool CanCheckout) Totalize(
        IReadOnlyList<CartLineDto> lines,
        decimal taxRate,
        long shippingCents)
    {
        var subtotalCents = lines.Where(l => l.Available).Sum(l => l.Subtotal?.Cents ?? 0L);

        // Tax on the CART subtotal, rounded once — not per line then summed, which can
        // drift by a cent. Same rounding mode as OrderPricing so a cart and the order it
        // becomes agree to the cent.
        var taxCents = (long)Math.Round(subtotalCents * taxRate, MidpointRounding.AwayFromZero);
```

> [!warning] Correction (final review, before merge) — this comment's claim is backwards
> The code above is what this task originally executed and is left as the historical record
> of what ran. It shipped with a real defect: rounding tax **once over the cart subtotal**
> is exactly what caused the drift this comment claims it prevents. `CreateOrderService`
> rounds tax **per line** (`OrderPricing.PriceLine`, accumulated as `tax += lineTax`), so a
> cart computed the "once over the subtotal" way could disagree with the order it becomes by
> a cent — worked example at this repo's 0.08 rate: three lines of 333 cents. Per-line:
> `round(333 × 0.08) = 27` each → **81**. Whole-subtotal: `round(999 × 0.08) = round(79.92)`
> → **80**. The user saw $10.79 and was charged $10.80.
>
> **Fixed in `CartPricing.Totalize`** (`services/orders/src/Orders.Infrastructure/Carts/CartPricing.cs`)
> before merge, user-approved: the cart now sums **per-line** rounded tax, mirroring
> `OrderPricing.PriceLine` exactly. `CreateOrderService`/the order itself was deliberately
> **left unchanged** — it is the incumbent and it is what actually bills, so changing it
> would rewrite the pricing of every future order and disagree with historical ones. Two
> tests now pin the equivalence by computing the expected figure from
> `OrderPricing.PriceLine` itself rather than a hardcoded number, so the two cannot drift
> apart again. Full rule, generalized beyond this one cart: [[money-representation#Rounding point, not just rounding mode]].
> Propagated to [[orders-service-design]] and a new lesson,
> [[2026-08-25-preview-must-mirror-charging-roundings-application-point]].

```csharp
        var canCheckout = lines.Count > 0 && lines.All(l => l.Available);

        return (
            Money.FromCents(subtotalCents),
            Money.FromCents(taxCents),
            Money.FromCents(shippingCents),
            Money.FromCents(subtotalCents + taxCents + shippingCents),
            canCheckout);
    }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd services/orders && dotnet test --filter FullyQualifiedName~CartPricingTests`
Expected: PASS — 5 tests.

- [ ] **Step 6: Commit**

```bash
git add services/orders/src/Orders.Application/Carts services/orders/src/Orders.Infrastructure/Carts services/orders/tests/Orders.Tests/Domain/CartPricingTests.cs
git commit -m "feat(orders): add cart DTOs and cart-level pricing"
```

---

## Task 5: `CartReadService` — live catalogue resolution and verdicts

**Files:**
- Create: `services/orders/src/Orders.Infrastructure/Carts/CartReadService.cs`
- Test: `services/orders/tests/Orders.Tests/Infrastructure/CartReadServiceTests.cs`

**Interfaces:**
- Consumes: `OrdersReadDbContext`, `IConfigurationReader.GetTaxRateAsync` / `.GetShippingCentsAsync`, `CartPricing.Totalize`, `Money`, `ProductImageDto`.
- Produces: `CartReadService.GetMyCartAsync(string callerSub, CancellationToken ct = default)` → `Task<CartDto>`, and `CartReadService.BuildAsync(Cart?, CancellationToken)` → `Task<CartDto>` used by the write path to render its response without a second round trip.

- [ ] **Step 1: Write the failing test**

Create `services/orders/tests/Orders.Tests/Infrastructure/CartReadServiceTests.cs`:

```csharp
using Microsoft.Extensions.DependencyInjection;
using Orders.Application.Carts;
using Orders.Domain.Entities;
using Orders.Infrastructure.Carts;
using Orders.Infrastructure.Id;
using Orders.Tests.Api;
using Xunit;

namespace Orders.Tests.Infrastructure;

[Collection(nameof(OrdersApiCollection))]
public class CartReadServiceTests
{
    private readonly OrdersApiFactory _factory;

    public CartReadServiceTests(OrdersApiFactory factory) => _factory = factory;

    // An empty cart is a 200 with zeros, never a 404 — the frontend must not branch.
    [Fact]
    public async Task A_user_with_no_cart_reads_an_empty_cart()
    {
        using var scope = _factory.Services.CreateScope();
        var reads = scope.ServiceProvider.GetRequiredService<CartReadService>();

        var cart = await reads.GetMyCartAsync("sub-with-no-cart");

        Assert.Null(cart.Id);
        Assert.Empty(cart.Items);
        Assert.Equal(0, cart.Subtotal.Cents);
        Assert.False(cart.CanCheckout);
    }

    [Fact]
    public async Task An_available_line_is_priced_from_the_live_catalogue()
    {
        var sub = $"sub-{Guid.NewGuid():N}";
        await SeedCartAsync(sub, _factory.SeededProductId, quantity: 2);

        using var scope = _factory.Services.CreateScope();
        var reads = scope.ServiceProvider.GetRequiredService<CartReadService>();

        var cart = await reads.GetMyCartAsync(sub);

        var line = Assert.Single(cart.Items);
        Assert.True(line.Available);
        Assert.Null(line.UnavailableReason);           // omitted, never a value
        Assert.Equal("Widget", line.Name);
        Assert.Equal(1000, line.UnitPrice!.Cents);     // the seeded product's price
        Assert.Equal(2000, line.Subtotal!.Cents);
        Assert.Equal(2000, cart.Subtotal.Cents);
        Assert.True(cart.CanCheckout);
    }

    [Fact]
    public async Task A_line_asking_for_more_than_stock_is_insufficient_stock()
    {
        var sub = $"sub-{Guid.NewGuid():N}";
        // The seeded product carries 5 units.
        await SeedCartAsync(sub, _factory.SeededProductId, quantity: 99);

        using var scope = _factory.Services.CreateScope();
        var reads = scope.ServiceProvider.GetRequiredService<CartReadService>();

        var cart = await reads.GetMyCartAsync(sub);

        var line = Assert.Single(cart.Items);
        Assert.False(line.Available);
        Assert.Equal(UnavailableReason.InsufficientStock, line.UnavailableReason);
        // Still reports what it WOULD cost, and still says how many remain.
        Assert.Equal(99000, line.Subtotal!.Cents);
        Assert.Equal(5u, line.UnitsInStock);
        // ...but contributes nothing to the cart.
        Assert.Equal(0, cart.Subtotal.Cents);
        Assert.False(cart.CanCheckout);
    }

    [Fact]
    public async Task A_line_whose_product_vanished_is_unknown_product()
    {
        var sub = $"sub-{Guid.NewGuid():N}";
        await SeedCartAsync(sub, NanoId.NewId(NanoId.ProductPrefix), quantity: 1);

        using var scope = _factory.Services.CreateScope();
        var reads = scope.ServiceProvider.GetRequiredService<CartReadService>();

        var cart = await reads.GetMyCartAsync(sub);

        var line = Assert.Single(cart.Items);
        Assert.False(line.Available);
        Assert.Equal(UnavailableReason.UnknownProduct, line.UnavailableReason);
        // No catalogue row left, so no price, no name, no artwork.
        Assert.Null(line.UnitPrice);
        Assert.Null(line.Subtotal);
        Assert.Null(line.Name);
        Assert.Null(line.Image);
    }

    private async Task SeedCartAsync(string sub, string productId, uint quantity)
    {
        await using var db = _factory.NewWriteContext();
        var cart = new Cart
        {
            Id = NanoId.NewId(NanoId.CartPrefix),
            UserId = NanoId.NewId("usr_"),
            CognitoSub = sub,
        };
        db.Carts.Add(cart);
        db.CartItems.Add(new CartItem
        {
            Id = NanoId.NewId(NanoId.CartItemPrefix),
            CartId = cart.Id,
            ProductId = productId,
            Quantity = quantity,
        });
        await db.SaveChangesAsync();
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd services/orders && dotnet test --filter FullyQualifiedName~CartReadServiceTests`
Expected: FAIL — `CartReadService` does not exist.

- [ ] **Step 3: Write `CartReadService`**

Create `services/orders/src/Orders.Infrastructure/Carts/CartReadService.cs`:

```csharp
using Microsoft.EntityFrameworkCore;
using Orders.Application.Abstractions;
using Orders.Application.Carts;
using Orders.Application.Orders;
using Orders.Domain;
using Orders.Domain.Entities;
using Orders.Infrastructure.Persistence;

namespace Orders.Infrastructure.Carts;

/// <summary>
/// Reads the caller's active cart and renders it fully calculated.
/// </summary>
/// <remarks>
/// <para>
/// Ownership is enforced IN the query (WHERE cognito_sub = caller), the same way
/// OrderReadService does it — a cart belonging to someone else simply is not found.
/// </para>
/// <para>
/// Lives in Infrastructure because it depends on OrdersReadDbContext; Application must
/// not reference EF Core.
/// </para>
/// </remarks>
public class CartReadService
{
    private readonly OrdersReadDbContext _db;
    private readonly IConfigurationReader _config;
    private readonly string _assetsBaseUrl;

    public CartReadService(OrdersReadDbContext db, IConfigurationReader config, string assetsBaseUrl)
    {
        _db = db;
        _config = config;
        // Trimmed once here so composing a URL below is a plain concatenation and can
        // never produce a double slash — same treatment as ProductReadService.
        _assetsBaseUrl = assetsBaseUrl.TrimEnd('/');
    }

    /// <summary>The caller's cart, or an EMPTY cart when they have none.</summary>
    public async Task<CartDto> GetMyCartAsync(string callerSub, CancellationToken ct = default)
    {
        // The soft-delete query filter makes "the active cart" simply "the cart":
        // deleted rows are already invisible to every query on this context.
        var cart = await _db.Carts.AsNoTracking()
            .Include(c => c.Items)
            .FirstOrDefaultAsync(c => c.CognitoSub == callerSub, ct);

        return await BuildAsync(cart, ct);
    }

    /// <summary>
    /// Renders a cart entity (or null, for "no cart") into its fully-calculated DTO.
    /// </summary>
    /// <remarks>
    /// Public so the write path can render its own response from the entity it just
    /// saved, instead of issuing a second read for state it already holds.
    /// </remarks>
    public async Task<CartDto> BuildAsync(Cart? cart, CancellationToken ct = default)
    {
        var taxRate = await _config.GetTaxRateAsync(ct);
        var shippingCents = await _config.GetShippingCentsAsync(ct);

        // `.Where(i => !i.IsDeleted)` is NOT redundant with the soft-delete query filter.
        // The filter applies to rows LOADED from the database; the write path calls this
        // with an entity it is still tracking, whose removed lines are in memory with
        // DeletedAt already set. Without this, a PUT that dropped a line would answer
        // with that line still in the cart — the deletion would look like it failed.
        var items = cart?.Items.Where(i => !i.IsDeleted).ToList() ?? [];

        // ONE catalogue query for every product in the cart. A per-line lookup here
        // would turn a ten-item cart into eleven round trips on a hot read path.
        var productIds = items.Select(i => i.ProductId).Distinct().ToArray();
        var products = productIds.Length == 0
            ? new Dictionary<string, Product>()
            : await _db.Products.AsNoTracking()
                .Where(p => productIds.Contains(p.Id))
                .ToDictionaryAsync(p => p.Id, ct);

        var lines = items.Select(item => BuildLine(item, products)).ToList();

        var totals = CartPricing.Totalize(lines, taxRate, shippingCents);

        return new CartDto(
            cart?.Id,
            lines,
            totals.Subtotal,
            totals.Tax,
            totals.Shipping,
            totals.Total,
            totals.CanCheckout);
    }

    private CartLineDto BuildLine(CartItem item, IReadOnlyDictionary<string, Product> products)
    {
        // The product is gone (deleted, or never existed). Nothing to price and nothing
        // to show but the id and the quantity the user asked for.
        if (!products.TryGetValue(item.ProductId, out var product))
        {
            return new CartLineDto(
                item.ProductId,
                Name: null,
                item.Quantity,
                UnitsInStock: 0,
                Available: false,
                UnitPrice: null,
                Subtotal: null,
                Image: null,
                UnavailableReason: UnavailableReason.UnknownProduct);
        }

        // Ordered most-specific-first: zero stock is "out of stock", not "insufficient".
        // Reversing these would report every empty product as insufficient_stock and the
        // frontend could not distinguish "gone for now" from "you asked for too many".
        string? reason = product.UnitsInStock == 0
            ? UnavailableReason.OutOfStock
            : product.UnitsInStock < item.Quantity
                ? UnavailableReason.InsufficientStock
                : null;

        return new CartLineDto(
            item.ProductId,
            product.Name,
            item.Quantity,
            product.UnitsInStock,
            Available: reason is null,
            // Priced even when unavailable: the line still reports what it WOULD cost so
            // the frontend renders it normally with a badge. Exclusion happens at the
            // CART level, in CartPricing.
            Money.FromCents(product.UnitPriceCents),
            Money.FromCents(product.UnitPriceCents * item.Quantity),
            product.Image is null
                ? null
                // Absolute URL composed on read from ASSETS_BASE_URL. Rows store a bucket
                // key relative to it — Floci re-mints the bucket on every apply, so a
                // persisted absolute URL would be dead data after the next rebuild.
                : new ProductImageDto(
                    $"{_assetsBaseUrl}/{product.Image.Uri}",
                    product.Image.Width,
                    product.Image.Height,
                    product.Image.Blurhash),
            reason);
    }
}
```

- [ ] **Step 4: Register the service in DI**

In `services/orders/src/Orders.Api/Program.cs`, next to where `ProductReadService` is registered (it takes the same `assetsBaseUrl` string, so copy that registration's shape exactly):

```csharp
builder.Services.AddScoped(sp => new CartReadService(
    sp.GetRequiredService<OrdersReadDbContext>(),
    sp.GetRequiredService<IConfigurationReader>(),
    assetsBaseUrl));
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd services/orders && dotnet test --filter FullyQualifiedName~CartReadServiceTests`
Expected: PASS — 4 tests.

- [ ] **Step 6: Commit**

```bash
git add services/orders/src services/orders/tests
git commit -m "feat(orders): add CartReadService with live catalogue pricing and per-line availability"
```

---

## Task 6: `CartWriteService` — replacement, deletion, and the single invariant

**Files:**
- Create: `services/orders/src/Orders.Infrastructure/Carts/CartWriteService.cs`
- Modify: `services/orders/src/Orders.Application/Abstractions/AuditActor.cs`
- Test: `services/orders/tests/Orders.Tests/Infrastructure/CartWriteServiceTests.cs`

**Interfaces:**
- Consumes: `OrdersWriteDbContext`, `IUserDirectory.ResolveCallerAsync`, `CartReadService.BuildAsync`, `AmbientActor.RunAsync`, `NanoId`, `UnknownUserException`.
- Produces: `CartWriteService.ReplaceAsync(UpdateCartCommand, string cognitoSub, CancellationToken)` → `Task<CartDto>`; `CartWriteService.DeleteAsync(string cognitoSub, CancellationToken)` → `Task`; `CartWriteService.DeleteForUserAsync(OrdersWriteDbContext, string cognitoSub, CancellationToken)` → `Task` (static; the shared deletion path Task 8 reuses inside the order transaction).

- [ ] **Step 1: Add the audit actors**

In `services/orders/src/Orders.Application/Abstractions/AuditActor.cs`, add after `CreateOrder`:

```csharp
    public const string UpdateCart = "orders_api:update_cart";
    public const string DeleteCart = "orders_api:delete_cart";
```

- [ ] **Step 2: Write the failing test**

Create `services/orders/tests/Orders.Tests/Infrastructure/CartWriteServiceTests.cs`:

```csharp
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Orders.Application.Carts;
using Orders.Infrastructure.Carts;
using Orders.Tests.Api;
using Xunit;

namespace Orders.Tests.Infrastructure;

[Collection(nameof(OrdersApiCollection))]
public class CartWriteServiceTests
{
    private readonly OrdersApiFactory _factory;

    public CartWriteServiceTests(OrdersApiFactory factory) => _factory = factory;

    [Fact]
    public async Task A_first_put_creates_the_cart()
    {
        var sub = OrdersApiFactory.KnownCognitoSub;
        using var scope = _factory.Services.CreateScope();
        var writes = scope.ServiceProvider.GetRequiredService<CartWriteService>();

        var cart = await writes.ReplaceAsync(
            new UpdateCartCommand([new CartLineInput(_factory.SeededProductId, 2)]), sub);

        Assert.NotNull(cart.Id);
        Assert.StartsWith("crt_", cart.Id);
        var line = Assert.Single(cart.Items);
        Assert.Equal(2u, line.Quantity);

        await CleanupAsync(sub);
    }

    // Replacement, not merge: the second PUT is the whole truth about the cart.
    [Fact]
    public async Task A_second_put_replaces_the_line_set()
    {
        var sub = OrdersApiFactory.KnownCognitoSub;
        using var scope = _factory.Services.CreateScope();
        var writes = scope.ServiceProvider.GetRequiredService<CartWriteService>();

        var first = await writes.ReplaceAsync(
            new UpdateCartCommand([new CartLineInput(_factory.SeededProductId, 2)]), sub);

        var second = await writes.ReplaceAsync(
            new UpdateCartCommand([new CartLineInput(_factory.SeededProductId, 5)]), sub);

        // Same cart, updated quantity — not a second cart, and not two lines.
        Assert.Equal(first.Id, second.Id);
        var line = Assert.Single(second.Items);
        Assert.Equal(5u, line.Quantity);

        await CleanupAsync(sub);
    }

    // quantity: 0 removes the line rather than being rejected, so the frontend can
    // send its desired state verbatim without filtering zeros out first.
    [Fact]
    public async Task A_zero_quantity_removes_that_line()
    {
        var sub = OrdersApiFactory.KnownCognitoSub;
        using var scope = _factory.Services.CreateScope();
        var writes = scope.ServiceProvider.GetRequiredService<CartWriteService>();
        var otherProductId = await _factory.SeedExtraProductAsync();

        await writes.ReplaceAsync(new UpdateCartCommand(
        [
            new CartLineInput(_factory.SeededProductId, 2),
            new CartLineInput(otherProductId, 1),
        ]), sub);

        var after = await writes.ReplaceAsync(new UpdateCartCommand(
        [
            new CartLineInput(_factory.SeededProductId, 2),
            new CartLineInput(otherProductId, 0),
        ]), sub);

        var line = Assert.Single(after.Items);
        Assert.Equal(_factory.SeededProductId, line.ProductId);

        await CleanupAsync(sub);
    }

    // The one invariant behind every deletion path: a cart with no live lines
    // does not exist. All three inputs below must reach the same state.
    [Theory]
    [InlineData("empty-array")]
    [InlineData("all-zeros")]
    public async Task A_cart_left_with_no_lines_is_deleted(string how)
    {
        var sub = OrdersApiFactory.KnownCognitoSub;
        using var scope = _factory.Services.CreateScope();
        var writes = scope.ServiceProvider.GetRequiredService<CartWriteService>();

        await writes.ReplaceAsync(
            new UpdateCartCommand([new CartLineInput(_factory.SeededProductId, 2)]), sub);

        var emptying = how == "empty-array"
            ? new UpdateCartCommand([])
            : new UpdateCartCommand([new CartLineInput(_factory.SeededProductId, 0)]);

        var after = await writes.ReplaceAsync(emptying, sub);

        Assert.Null(after.Id);
        Assert.Empty(after.Items);
        // Subtotal, not Total: shipping is reported unconditionally, so an emptied
        // cart's Total is the delivery charge, not zero. See CartPricing.
        Assert.Equal(0, after.Subtotal.Cents);
        Assert.False(after.CanCheckout);

        // And it is really gone from the database, not merely absent from the DTO.
        await using var db = _factory.NewWriteContext();
        Assert.False(await db.Carts.AnyAsync(c => c.CognitoSub == sub));
    }

    // Emptying frees the slot, so the user can start again. This is the pairing the
    // unique index would break if the generated column were wrong.
    [Fact]
    public async Task A_user_can_start_a_new_cart_after_emptying_one()
    {
        var sub = OrdersApiFactory.KnownCognitoSub;
        using var scope = _factory.Services.CreateScope();
        var writes = scope.ServiceProvider.GetRequiredService<CartWriteService>();

        var first = await writes.ReplaceAsync(
            new UpdateCartCommand([new CartLineInput(_factory.SeededProductId, 1)]), sub);
        await writes.ReplaceAsync(new UpdateCartCommand([]), sub);

        var second = await writes.ReplaceAsync(
            new UpdateCartCommand([new CartLineInput(_factory.SeededProductId, 1)]), sub);

        Assert.NotNull(second.Id);
        Assert.NotEqual(first.Id, second.Id);

        await CleanupAsync(sub);
    }

    [Fact]
    public async Task Delete_removes_the_cart_and_is_idempotent()
    {
        var sub = OrdersApiFactory.KnownCognitoSub;
        using var scope = _factory.Services.CreateScope();
        var writes = scope.ServiceProvider.GetRequiredService<CartWriteService>();

        await writes.ReplaceAsync(
            new UpdateCartCommand([new CartLineInput(_factory.SeededProductId, 1)]), sub);

        await writes.DeleteAsync(sub);
        // Second call must not throw: DELETE is idempotent.
        await writes.DeleteAsync(sub);

        await using var db = _factory.NewWriteContext();
        Assert.False(await db.Carts.AnyAsync(c => c.CognitoSub == sub));
    }

    private async Task CleanupAsync(string sub)
    {
        using var scope = _factory.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<CartWriteService>().DeleteAsync(sub);
    }
}
```

Add `SeedExtraProductAsync()` to `OrdersApiFactory` if it does not exist: it inserts a second product with stock and returns its id, mirroring how `InitializeAsync` seeds `SeededProductId`.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd services/orders && dotnet test --filter FullyQualifiedName~CartWriteServiceTests`
Expected: FAIL — `CartWriteService` does not exist.

- [ ] **Step 4: Write `CartWriteService`**

Create `services/orders/src/Orders.Infrastructure/Carts/CartWriteService.cs`:

```csharp
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Orders.Application.Abstractions;
using Orders.Application.Carts;
using Orders.Application.Identity;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;
using Orders.Infrastructure.Observability;
using Orders.Infrastructure.Persistence;

namespace Orders.Infrastructure.Carts;

/// <summary>
/// Every write to a cart. Mirrors CreateOrderService: transactional, run under an
/// AmbientActor so the audit columns say what produced the row.
/// </summary>
public class CartWriteService
{
    private readonly OrdersWriteDbContext _db;
    private readonly IUserDirectory _users;
    private readonly CartReadService _reads;
    private readonly IWorkflowTracer _tracer;
    private readonly ILogger<CartWriteService> _logger;

    public CartWriteService(
        OrdersWriteDbContext db,
        IUserDirectory users,
        CartReadService reads,
        IWorkflowTracer tracer,
        ILogger<CartWriteService> logger)
    {
        _db = db;
        _users = users;
        _reads = reads;
        _tracer = tracer;
        _logger = logger;
    }

    /// <summary>
    /// Replaces the caller's cart lines with exactly <paramref name="command"/>.
    /// </summary>
    /// <remarks>
    /// FULL REPLACEMENT: a product absent from the command is removed, and a product
    /// sent at quantity 0 is removed too (deliberately redundant, so the frontend may
    /// send its list pre-filtered or not). If nothing live remains afterwards the cart
    /// itself is deleted — see <see cref="DeleteForUserAsync"/> for why that is one
    /// path rather than three branches.
    /// </remarks>
    public Task<CartDto> ReplaceAsync(
        UpdateCartCommand command,
        string cognitoSub,
        CancellationToken ct = default) =>
        _tracer.TraceWorkflowAsync(
            "update_cart",
            new Dictionary<string, object?> { ["app_event"] = "update_cart_started" },
            () => ReplaceInternalAsync(command, cognitoSub, ct));

    private async Task<CartDto> ReplaceInternalAsync(
        UpdateCartCommand command,
        string cognitoSub,
        CancellationToken ct)
    {
        _logger.LogInformation(
            "Starting cart update {app_event} {line_count}",
            "update_cart_started", command.Items.Count);

        var caller = await _users.ResolveCallerAsync(cognitoSub, ct);
        if (caller is null)
        {
            _logger.LogError(
                "Cart update failed: the caller is not a known user {app_event} {reason}",
                "update_cart_failed", "unknown_user");
            _tracer.SetReason("unknown_user");
            throw new UnknownUserException(cognitoSub);
        }

        // Zero means "remove", so it is dropped here, once, before any persistence
        // logic runs. Everything downstream then deals only in live lines.
        var wanted = command.Items.Where(i => i.Quantity > 0).ToList();

        return await AmbientActor.RunAsync(AuditActor.UpdateCart, async () =>
        {
            await using var tx = await _db.Database.BeginTransactionAsync(ct);

            var cart = await _db.Carts
                .Include(c => c.Items)
                .FirstOrDefaultAsync(c => c.CognitoSub == cognitoSub, ct);

            // Nothing left to hold: a cart with no live lines does not exist.
            if (wanted.Count == 0)
            {
                if (cart is not null)
                {
                    SoftDelete(cart);
                }

                await _db.SaveChangesAsync(ct);
                await tx.CommitAsync(ct);

                _logger.LogInformation(
                    "Cart update emptied and removed the cart {app_event}", "update_cart_succeeded");

                return await _reads.BuildAsync(null, ct);
            }

            if (cart is null)
            {
                cart = new Cart
                {
                    Id = NanoId.NewId(NanoId.CartPrefix),
                    UserId = caller.InternalUserId,
                    CognitoSub = cognitoSub,
                };
                _db.Carts.Add(cart);
            }

            SyncLines(cart, wanted);

            await _db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);

            _logger.LogInformation(
                "Cart updated {app_event} {line_count}", "update_cart_succeeded", wanted.Count);

            return await _reads.BuildAsync(cart, ct);
        });
    }

    /// <summary>Deletes the caller's active cart. Idempotent.</summary>
    public async Task DeleteAsync(string cognitoSub, CancellationToken ct = default)
    {
        await AmbientActor.RunAsync(AuditActor.DeleteCart, async () =>
        {
            await DeleteForUserAsync(_db, cognitoSub, ct);
            await _db.SaveChangesAsync(ct);
            return true;
        });
    }

    /// <summary>
    /// Soft-deletes a user's active cart and its lines on the GIVEN context, without
    /// saving.
    /// </summary>
    /// <remarks>
    /// Static and context-taking so order creation can call it INSIDE its own
    /// transaction (see CreateOrderService) rather than duplicating the deletion
    /// logic. There are three call sites — an emptying PUT, DELETE /v1/cart, and a
    /// completed order — and they must not be allowed to drift apart. The caller
    /// owns SaveChanges, which is what lets the order path make cart removal part
    /// of the same atomic commit as the order itself.
    /// </remarks>
    public static async Task DeleteForUserAsync(
        OrdersWriteDbContext db,
        string cognitoSub,
        CancellationToken ct = default)
    {
        var cart = await db.Carts
            .Include(c => c.Items)
            .FirstOrDefaultAsync(c => c.CognitoSub == cognitoSub, ct);

        if (cart is not null)
        {
            SoftDelete(cart);
        }
    }

    private static void SoftDelete(Cart cart)
    {
        var now = DateTime.UtcNow;
        cart.DeletedAt = now;

        // The lines go too. Leaving them live would keep the cart_item unique index
        // occupied, so the user's NEXT cart could not hold the same product.
        foreach (var item in cart.Items)
        {
            item.DeletedAt = now;
        }
    }

    private static void SyncLines(Cart cart, IReadOnlyList<CartLineInput> wanted)
    {
        var now = DateTime.UtcNow;
        var wantedById = wanted.ToDictionary(i => i.ProductId, i => i.Quantity);

        // Remove what the caller no longer wants. Replacement semantics: absence from
        // the command IS the instruction to remove.
        foreach (var existing in cart.Items.Where(i => !wantedById.ContainsKey(i.ProductId)))
        {
            existing.DeletedAt = now;
        }

        foreach (var (productId, quantity) in wantedById)
        {
            var existing = cart.Items.FirstOrDefault(i => i.ProductId == productId);
            if (existing is null)
            {
                cart.Items.Add(new CartItem
                {
                    Id = NanoId.NewId(NanoId.CartItemPrefix),
                    CartId = cart.Id,
                    ProductId = productId,
                    Quantity = quantity,
                });
            }
            else
            {
                existing.Quantity = quantity;
            }
        }
    }
}
```

- [ ] **Step 5: Register the service in DI**

In `services/orders/src/Orders.Api/Program.cs`, beside the `CartReadService` registration from Task 5:

```csharp
builder.Services.AddScoped<CartWriteService>();
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd services/orders && dotnet test --filter FullyQualifiedName~CartWriteServiceTests`
Expected: PASS — 7 tests (the `[Theory]` contributes 2).

- [ ] **Step 7: Commit**

```bash
git add services/orders/src services/orders/tests
git commit -m "feat(orders): add CartWriteService with replacement semantics and single deletion path"
```

---

## Task 7: The three HTTP endpoints

**Files:**
- Create: `services/orders/src/Orders.Api/Endpoints/CartEndpoints.cs`
- Modify: `services/orders/src/Orders.Api/Program.cs`
- Modify: `services/orders/openapi.yaml` (regenerated)
- Test: `services/orders/tests/Orders.Tests/Api/CartEndpointsTests.cs`

**Interfaces:**
- Consumes: `CartReadService`, `CartWriteService`, `ICurrentCaller`, `UnknownUserException`.
- Produces: routes `GET /v1/cart` (`GetMyCart`), `PUT /v1/cart` (`UpdateCart`), `DELETE /v1/cart` (`DeleteCart`); request record `UpdateCartRequest(IReadOnlyList<UpdateCartItemRequest>? Items)` and `UpdateCartItemRequest(string? ProductId, int Quantity)`.

Note `Quantity` is **`int`, not `uint`**, on the request record deliberately: a negative number must be *rejected with a 400*, and binding it to `uint` makes `System.Text.Json` fail before the handler runs, producing a generic framework error instead of the documented `invalid_request` body.

- [ ] **Step 1: Write the failing endpoint tests**

Create `services/orders/tests/Orders.Tests/Api/CartEndpointsTests.cs`:

```csharp
using System.Net;
using System.Net.Http.Json;
using Xunit;

namespace Orders.Tests.Api;

[Collection(nameof(OrdersApiCollection))]
public class CartEndpointsTests
{
    private readonly OrdersApiFactory _factory;

    public CartEndpointsTests(OrdersApiFactory factory) => _factory = factory;

    private HttpClient Client()
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("x-user-id", OrdersApiFactory.KnownCognitoSub);
        return client;
    }

    [Fact]
    public async Task Get_returns_200_with_an_empty_cart_when_there_is_none()
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("x-user-id", $"sub-{Guid.NewGuid():N}");

        var response = await client.GetAsync("/v1/cart");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonCart>();
        Assert.Null(body!.Id);
        Assert.Empty(body.Items);
    }

    [Fact]
    public async Task Put_creates_the_cart_and_returns_it_fully_calculated()
    {
        var client = Client();

        var response = await client.PutAsJsonAsync("/v1/cart", new
        {
            items = new[] { new { product_id = _factory.SeededProductId, quantity = 2 } },
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonCart>();
        Assert.NotNull(body!.Id);
        var line = Assert.Single(body.Items);
        Assert.Equal(2, line.Quantity);
        // Both money views present — the whole point of the change.
        Assert.Equal(2000, line.Subtotal!.Cents);
        Assert.Equal("20.00", line.Subtotal.Amount);
        Assert.Equal("$20.00", line.Subtotal.Formatted);

        await client.DeleteAsync("/v1/cart");
    }

    [Fact]
    public async Task Delete_returns_204_and_is_idempotent()
    {
        var client = Client();
        await client.PutAsJsonAsync("/v1/cart", new
        {
            items = new[] { new { product_id = _factory.SeededProductId, quantity = 1 } },
        });

        Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync("/v1/cart")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync("/v1/cart")).StatusCode);
    }

    [Theory]
    // A negative quantity is the only quantity that is an error.
    [InlineData("{\"items\":[{\"product_id\":\"prd_x\",\"quantity\":-1}]}")]
    // Two entries for one product is ambiguous under replacement semantics.
    [InlineData("{\"items\":[{\"product_id\":\"prd_x\",\"quantity\":1},{\"product_id\":\"prd_x\",\"quantity\":2}]}")]
    // A missing/misspelled key binds items to null — the bug that produced an opaque
    // 500 on POST /v1/orders before it was guarded.
    [InlineData("{}")]
    [InlineData("{\"items\":null}")]
    [InlineData("{\"items\":[{\"quantity\":1}]}")]
    public async Task Put_rejects_an_invalid_body_with_400(string json)
    {
        var client = Client();

        var response = await client.PutAsync("/v1/cart",
            new StringContent(json, System.Text.Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Cart_routes_require_identity()
    {
        var anonymous = _factory.CreateClient();

        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/v1/cart")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.DeleteAsync("/v1/cart")).StatusCode);
    }

    // Minimal shapes for asserting on the JSON contract, so a rename of a C# property
    // that changes the wire format fails here rather than silently reaching clients.
    private record JsonMoney(long Cents, string Amount, string Formatted, string Currency);
    private record JsonLine(string Product_Id, int Quantity, bool Available, JsonMoney? Subtotal);
    private record JsonCart(string? Id, List<JsonLine> Items, JsonMoney Total, bool Can_Checkout);
}
```

If the project's JSON options use snake_case (check `Program.cs` — the `ORDER_CREATED` envelope is snake_case, but HTTP DTOs may not be), adjust these record property names to match the actual serialized casing. Assert against the real wire format, whichever it is; do not change the service's casing to fit the test.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd services/orders && dotnet test --filter FullyQualifiedName~CartEndpointsTests`
Expected: FAIL — 404s on every route.

- [ ] **Step 3: Write the endpoints**

Create `services/orders/src/Orders.Api/Endpoints/CartEndpoints.cs`:

```csharp
using Orders.Api.Identity;
using Orders.Application.Abstractions;
using Orders.Application.Carts;
using Orders.Infrastructure.Carts;

namespace Orders.Api.Endpoints;

/// <param name="Quantity">
/// Bound as int, NOT uint, deliberately: a negative value must come back as the
/// documented 400 `invalid_request` body, and uint would make the JSON binder fail
/// first with a generic framework error the caller cannot act on.
/// </param>
public record UpdateCartItemRequest(string? ProductId, int Quantity);

public record UpdateCartRequest(IReadOnlyList<UpdateCartItemRequest>? Items);

public static class CartEndpoints
{
    public static void MapCartEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/v1/cart").WithTags("Cart");

        group.MapGet("", async (
            ICurrentCaller caller,
            CartReadService reads,
            CancellationToken ct) =>
        {
            // x-user-id absence already 401'd by CallerContextMiddleware.
            // Always 200: a user with no cart gets an empty one, never a 404, so the
            // frontend has a single shape to render.
            return Results.Ok(await reads.GetMyCartAsync(caller.CognitoSub!, ct));
        })
            .WithName("GetMyCart")
            .WithSummary("Read the caller's active cart, fully priced and calculated.")
            .Produces<CartDto>(StatusCodes.Status200OK)
            .Produces(StatusCodes.Status401Unauthorized);

        group.MapPut("", Handle)
            .WithName("UpdateCart")
            .WithSummary("Replace the caller's cart lines; an empty set deletes the cart.")
            .Accepts<UpdateCartRequest>("application/json")
            .Produces<CartDto>(StatusCodes.Status200OK)
            .Produces(StatusCodes.Status400BadRequest)
            .Produces(StatusCodes.Status401Unauthorized)
            .Produces(StatusCodes.Status404NotFound);

        group.MapDelete("", async (
            ICurrentCaller caller,
            CartWriteService writes,
            CancellationToken ct) =>
        {
            await writes.DeleteAsync(caller.CognitoSub!, ct);
            // Idempotent: 204 whether or not there was a cart. A 404 for "already gone"
            // would make a retry after a dropped response look like a failure.
            return Results.NoContent();
        })
            .WithName("DeleteCart")
            .WithSummary("Delete the caller's active cart and all its lines.")
            .Produces(StatusCodes.Status204NoContent)
            .Produces(StatusCodes.Status401Unauthorized);
    }

    private static async Task<IResult> Handle(
        ICurrentCaller caller,
        UpdateCartRequest body,
        CartWriteService writes,
        CancellationToken ct)
    {
        // Validate BEFORE anything else. `Items` is declared nullable precisely because
        // System.Text.Json does not enforce non-nullable annotations: a body that omits
        // the key, misspells it, or sends an explicit null binds it to null. Without
        // this guard the first dereference downstream becomes a 500 — a server fault
        // reported for what is entirely a caller mistake. This is the same bug that
        // POST /v1/orders had to be guarded against.
        //
        // An EMPTY array is NOT rejected here: it is the documented way to empty (and
        // therefore delete) the cart.
        if (body?.Items is null)
        {
            return Results.BadRequest(new
            {
                error = "invalid_request",
                detail = "The 'items' array is required.",
            });
        }

        if (body.Items.Any(i => string.IsNullOrWhiteSpace(i.ProductId)))
        {
            return Results.BadRequest(new
            {
                error = "invalid_request",
                detail = "Every item requires a non-empty 'product_id'.",
            });
        }

        // Zero is valid — it means "remove this line". Only negatives are an error.
        if (body.Items.Any(i => i.Quantity < 0))
        {
            return Results.BadRequest(new
            {
                error = "invalid_request",
                detail = "'quantity' cannot be negative; send 0 to remove a line.",
            });
        }

        // Under full-replacement semantics two entries for one product is ambiguity on
        // the caller's side, not an intent to sum. Rejecting is the honest answer.
        if (body.Items.Select(i => i.ProductId).Distinct().Count() != body.Items.Count)
        {
            return Results.BadRequest(new
            {
                error = "invalid_request",
                detail = "Each 'product_id' may appear at most once.",
            });
        }

        try
        {
            var command = new UpdateCartCommand(
                body.Items.Select(i => new CartLineInput(i.ProductId!, (uint)i.Quantity)).ToList());

            return Results.Ok(await writes.ReplaceAsync(command, caller.CognitoSub!, ct));
        }
        catch (UnknownUserException)
        {
            return Results.NotFound(new { error = "unknown_user" });
        }
    }
}
```

- [ ] **Step 4: Map the endpoints**

In `services/orders/src/Orders.Api/Program.cs`, beside the existing `app.MapOrderEndpoints();`:

```csharp
app.MapCartEndpoints();
```

Check `services/orders/src/Orders.Api/Identity/PublicRoutes.cs` — cart routes must **NOT** be listed there. Every cart route requires identity.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd services/orders && dotnet test --filter FullyQualifiedName~CartEndpointsTests`
Expected: PASS — 10 tests (the `[Theory]` contributes 5).

- [ ] **Step 6: Regenerate and verify `openapi.yaml`**

Run: `cd services/orders && dotnet build`

Verify the three routes are documented with their real statuses:

Run: `grep -n "/v1/cart" -A 5 services/orders/openapi.yaml | head -40`
Expected: `get`, `put`, `delete` under `/v1/cart`, with 200/400/401/404/204 as declared above and a `CartDto` component schema.

- [ ] **Step 7: Run the whole suite**

Run: `cd services/orders && dotnet test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add services/orders/src services/orders/tests services/orders/openapi.yaml
git commit -m "feat(orders): add GET/PUT/DELETE /v1/cart endpoints"
```

---

## Task 8: Order creation deletes the cart

The single point where the cart touches existing order code.

**Files:**
- Modify: `services/orders/src/Orders.Infrastructure/Orders/CreateOrderService.cs`
- Test: `services/orders/tests/Orders.Tests/Api/CartCheckoutTests.cs`

**Interfaces:**
- Consumes: `CartWriteService.DeleteForUserAsync(OrdersWriteDbContext, string, CancellationToken)` (Task 6).
- Produces: no new public API.

- [ ] **Step 1: Write the failing test**

Create `services/orders/tests/Orders.Tests/Api/CartCheckoutTests.cs`:

```csharp
using System.Net;
using System.Net.Http.Json;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace Orders.Tests.Api;

[Collection(nameof(OrdersApiCollection))]
public class CartCheckoutTests
{
    private readonly OrdersApiFactory _factory;

    public CartCheckoutTests(OrdersApiFactory factory) => _factory = factory;

    private HttpClient Client()
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("x-user-id", OrdersApiFactory.KnownCognitoSub);
        return client;
    }

    // Without this, the user reloads after checking out and finds the cart they
    // just bought still sitting there, ready to be bought again.
    [Fact]
    public async Task Creating_an_order_deletes_the_callers_cart()
    {
        var client = Client();
        await client.PutAsJsonAsync("/v1/cart", new
        {
            items = new[] { new { product_id = _factory.SeededProductId, quantity = 1 } },
        });

        var order = await client.PostAsJsonAsync("/v1/orders", new
        {
            lines = new[] { new { productId = _factory.SeededProductId, quantity = 1u } },
        });
        Assert.Equal(HttpStatusCode.Created, order.StatusCode);

        await using var db = _factory.NewWriteContext();
        Assert.False(await db.Carts.AnyAsync(c => c.CognitoSub == OrdersApiFactory.KnownCognitoSub));
    }

    // A user who orders without ever using a cart must not hit an error path.
    [Fact]
    public async Task Creating_an_order_without_a_cart_succeeds()
    {
        var client = Client();
        await client.DeleteAsync("/v1/cart");

        var order = await client.PostAsJsonAsync("/v1/orders", new
        {
            lines = new[] { new { productId = _factory.SeededProductId, quantity = 1u } },
        });

        Assert.Equal(HttpStatusCode.Created, order.StatusCode);
    }

    // The deletion is part of the order transaction: a rolled-back order must leave
    // the cart intact, or the user loses their selection AND gets no order.
    [Fact]
    public async Task A_failed_order_leaves_the_cart_intact()
    {
        var client = Client();
        await client.PutAsJsonAsync("/v1/cart", new
        {
            items = new[] { new { product_id = _factory.SeededProductId, quantity = 1 } },
        });

        // Far beyond the seeded stock, so the write rolls back with 409.
        var order = await client.PostAsJsonAsync("/v1/orders", new
        {
            lines = new[] { new { productId = _factory.SeededProductId, quantity = 9999u } },
        });
        Assert.Equal(HttpStatusCode.Conflict, order.StatusCode);

        await using var db = _factory.NewWriteContext();
        Assert.True(await db.Carts.AnyAsync(c => c.CognitoSub == OrdersApiFactory.KnownCognitoSub));

        await client.DeleteAsync("/v1/cart");
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd services/orders && dotnet test --filter FullyQualifiedName~CartCheckoutTests`
Expected: FAIL on `Creating_an_order_deletes_the_callers_cart` — the cart is still there. The other two should already pass.

- [ ] **Step 3: Delete the cart inside the order transaction**

In `services/orders/src/Orders.Infrastructure/Orders/CreateOrderService.cs`, add the using:

```csharp
using Orders.Infrastructure.Carts;
```

and inside `CreateInternalAsync`, after the order and its details are added and stock is decremented but **before** `SaveChangesAsync`/commit:

```csharp
            // The cart the buyer just converted has served its purpose. Inside THIS
            // transaction on purpose: if the order rolls back (insufficient stock, a
            // failed write), the cart must survive — losing the selection AND the
            // order is the worst outcome for the user.
            //
            // Routed through CartWriteService's shared deletion path rather than
            // reimplemented here, so the three ways a cart dies cannot drift apart.
            // No-ops when the caller had no cart, which is the common API-only case.
            await CartWriteService.DeleteForUserAsync(_db, cognitoSub, ct);
```

Do **not** move it after the commit, and do not swallow its exceptions: unlike the SQS publish (which is deliberately best-effort because a queue outage must not roll back a paid order), this is a local write in a transaction that is already open.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd services/orders && dotnet test --filter FullyQualifiedName~CartCheckoutTests`
Expected: PASS — 3 tests.

- [ ] **Step 5: Run the whole suite**

Run: `cd services/orders && dotnet test`
Expected: PASS. Confirm no existing order test regressed.

- [ ] **Step 6: Commit**

```bash
git add services/orders/src services/orders/tests
git commit -m "feat(orders): delete the caller's cart when their order is created"
```

---

## Task 9: E2E — internal and gateway

Required by `services/orders/CLAUDE.md` §2b. An endpoint without gateway E2E is an incomplete change. **Delegate this task to the `e2e-impl` agent**, which owns the testing surface and reads `e2e/CLAUDE.md`.

**Files:**
- Create: `e2e/tests/gateway/cart.spec.ts`
- Modify: existing internal/gateway specs asserting on money fields
- Test: the specs are the deliverable

**Interfaces:**
- Consumes: the routes and shapes from Tasks 2–8.
- Produces: no source API.

- [ ] **Step 1: Update existing specs for the Money shape**

Every existing assertion reading `subtotal_cents`, `total_cents`, `unit_price_cents` etc. from an Orders response must move to the `Money` shape (`subtotal.cents`, and at least one `subtotal.amount` assertion so the dollar view is actually covered).

Run: `grep -rn "_cents" e2e/tests` to find them all.

- [ ] **Step 2: Write the gateway spec**

Create `e2e/tests/gateway/cart.spec.ts`, following the structure and auth helpers of the existing gateway specs (real Cognito JWT via the gateway URL — do not fake the authorizer). Cover the full cycle against the real gateway:

1. `GET /v1/cart` with no cart → 200, `id: null`, `items: []`.
2. `PUT /v1/cart` with one line → 200, cart id starts `crt_`, the line carries `name`, `image`, `unit_price.cents` **and** `unit_price.amount`, `available: true`, and `can_checkout: true`.
3. `PUT /v1/cart` with that line at `quantity: 0` → 200, `id: null`, `items: []` (the cart is gone).
4. `PUT /v1/cart` again with a line, then `DELETE /v1/cart` → 204; a second `DELETE` → 204 (idempotent).
5. `PUT /v1/cart` with a negative quantity → 400.
6. `PUT /v1/cart`, then `POST /v1/orders`, then `GET /v1/cart` → 200 with `id: null` (order creation consumed the cart).

Send `x-e2e-source: true` on the order creation so the existing teardown reclaims it, exactly as the other gateway specs do.

These six scenarios are what catch gateway-only faults — a missing route, a dropped verb, an unmapped method — which in-process tests structurally cannot see.

- [ ] **Step 3: Run the E2E suite**

Run: `make bootstrap && pnpm --filter @3mrai/e2e test`
Expected: PASS, including the new cart spec.

- [ ] **Step 4: Commit**

```bash
git add e2e
git commit -m "test(orders): add gateway E2E for the cart endpoints and Money shape"
```

---

## Task 10: Propagate to the vault

Required before the PR by the doc-propagation convention. **Route every `docs/` write through the `obsidian-vault` agent** — it is the sole writer of the vault.

**Files:**
- Modify: `docs/domains/orders/specs/orders-service-design.md`
- Modify: `docs/shared/conventions/nano-id.md`
- Create: `docs/shared/conventions/money-representation.md`
- Modify: `docs/superpowers/specs/2026-08-25-cart-endpoints-design.md` (add the new target to `propagates-to:`, set `status: active`)
- Modify: `services/orders/CLAUDE.md`

- [ ] **Step 1: Write the Money convention note**

Create `docs/shared/conventions/money-representation.md`: every HTTP amount is a `Money` object (`cents`, `amount`, `formatted`, `currency`); storage stays integer cents; the SQS envelope is unaffected; formatting is invariant-culture; `Money` never crosses into persistence. Frontmatter per vault rules, plus a `## Related` section.

- [ ] **Step 2: Update the existing targets**

- `orders-service-design.md`: the three `/v1/cart` routes, the cart aggregate, the one-active-cart index, the deletion invariant, and the `Money` DTO change. Bump `updated:`.
- `nano-id.md`: add `crt_` and `cti_` to the prefix table. Bump `updated:`.
- `services/orders/CLAUDE.md` §6: list the three cart routes with their status codes, next to the existing order routes.

- [ ] **Step 3: Close the loop on the spec**

Add `"[[money-representation]]"` to the spec's `propagates-to:` (it resolves now that the note exists) and set `status: active`.

- [ ] **Step 4: Validate**

Run: `nvm use && node scripts/validate-vault.mjs`
Expected: `Vault validation passed` with no broken wikilinks and the propagation gate green.

- [ ] **Step 5: Commit**

```bash
git add docs services/orders/CLAUDE.md
git commit -m "docs(vault): propagate cart endpoints and Money representation"
```

---

## Final verification

- [ ] `cd services/orders && dotnet build` — passes, `openapi.yaml` regenerated and committed
- [ ] `cd services/orders && dotnet test` — full suite passes
- [ ] `cd services/orders && dotnet format --verify-no-changes` — clean
- [ ] `pnpm --filter @3mrai/e2e test` — internal + gateway specs pass
- [ ] `nvm use && node scripts/validate-vault.mjs` — vault green
- [ ] `git status` — no stray files; `openapi.yaml` is committed alongside the code that changed it
- [ ] The `ORDER_CREATED` envelope test is untouched — confirm with `git diff main --stat -- services/orders/tests/Orders.Tests/Messaging`, which must report no changes

## Related

- [[2026-08-25-cart-endpoints-design]]
- [[orders-service-design]]
- [[nano-id]]
- [[soft-delete]]
- [[audit-fields]]
- [[db-naming]]
- [[testing]]
- [[cqrs]]
- [[money-representation]] — the cross-cutting convention Task 1's `Money` object propagated
  into.
- [[2026-08-25-cart-innodb-generated-column-fk-restriction]]
- [[2026-08-25-route-works-in-process-but-404s-at-gateway]]
- [[2026-08-25-preview-must-mirror-charging-roundings-application-point]] — the tax-rounding
  drift found and fixed in final review, corrected in Task 4's code block above via an inline
  amendment callout.
- [[2026-08-25-reads-are-not-exempt-from-observability]] — `GET`/`DELETE /v1/cart` shipped
  with no span or log line at all; the design spec's own "GET carries no flow logs" claim
  carries the corresponding amendment.
