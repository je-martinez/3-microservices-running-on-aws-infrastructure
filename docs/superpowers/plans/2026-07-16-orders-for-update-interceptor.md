---
title: "Orders FOR UPDATE via LINQ + Interceptor"
type: plan
area: orders
status: draft
created: 2026-07-16
updated: 2026-07-16
tags: [type/plan, area/orders, status/draft]
related: ["[[2026-07-16-orders-for-update-interceptor-design]]", "[[orders-service-design]]", "[[2026-07-14-orders-service-milestone-design]]", "[[ADR-0004-soft-delete-only]]", "[[cqrs]]", "[[db-naming]]"]
---

# Orders FOR UPDATE via LINQ + Interceptor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the raw `FromSqlInterpolated(... FOR UPDATE)` from the Orders create-order path — replace it with a pure LINQ query (so the global soft-delete query filter applies automatically) plus an EF Core command interceptor that appends `FOR UPDATE` to the tagged query.

**Architecture:** A `ForUpdateInterceptor : DbCommandInterceptor` recognizes a shared tag constant (emitted by `TagWith(...)` as a SQL comment) and appends ` FOR UPDATE` to that SELECT before execution. The create-order service queries with LINQ + `TagWith(ForUpdateInterceptor.Tag)`; EF's `deleted_at IS NULL` filter applies on its own. The interceptor is registered on the WRITE DbContext's `OnConfiguring` next to `AuditInterceptor`.

**Tech Stack:** .NET / C#, EF Core 9 (Pomelo MySQL provider), MySQL (InnoDB), xUnit + Testcontainers-MySQL.

## Global Constraints

- **No raw SQL in business code.** The `FromSqlInterpolated` must be gone from `CreateOrderService`; the lock is applied by the interceptor.
- **Soft-delete (ADR-0004) applies via the global query filter** — the LINQ query must NOT hand-add `deleted_at`; EF's filter covers it. The existing `Rejects_soft_deleted_product` test must still pass.
- **MySQL-specific.** `FOR UPDATE` is emitted directly (Aurora MySQL / InnoDB). Document it as the single point to change if the engine ever changes.
- **Tag is a single shared constant** used by both `TagWith` and the interceptor matcher — they must never desync.
- **Write context only.** Register on `OrdersWriteDbContext` (the transaction lives there); never on the read context (pure reads must not lock).
- **Language:** converse in Spanish; write code/comments in English.
- **Implementers write only source code.** Leave work in the working tree; the main session commits.

---

## Task 1: ForUpdateInterceptor

**Files:**
- Create: `services/orders/src/Orders.Infrastructure/Persistence/ForUpdateInterceptor.cs`
- Test: `services/orders/tests/Orders.Tests/Infrastructure/ForUpdateInterceptorTests.cs`

**Interfaces:**
- Produces: `ForUpdateInterceptor : DbCommandInterceptor` with a public `const string Tag = "orders:for-update"`; overrides `ReaderExecuting` and `ReaderExecutingAsync` that append ` FOR UPDATE` to a tagged SELECT.

- [ ] **Step 1: Write the failing unit test (SQL rewrite logic)**

Create `services/orders/tests/Orders.Tests/Infrastructure/ForUpdateInterceptorTests.cs`. Test the pure command-text rewrite (extract the rewrite into a static internal method so it's unit-testable without a real DbCommand):

```csharp
using Orders.Infrastructure.Persistence;
using Xunit;

namespace Orders.Tests.Infrastructure;

public class ForUpdateInterceptorTests
{
    [Fact]
    public void Appends_for_update_to_a_tagged_select()
    {
        var sql = $"-- {ForUpdateInterceptor.Tag}\n\nSELECT p.id FROM product AS p WHERE p.id = 'x' AND p.deleted_at IS NULL";
        var rewritten = ForUpdateInterceptor.ApplyForUpdate(sql);
        Assert.EndsWith("FOR UPDATE", rewritten.TrimEnd());
    }

    [Fact]
    public void Leaves_untagged_sql_untouched()
    {
        var sql = "SELECT p.id FROM product AS p WHERE p.id = 'x'";
        Assert.Equal(sql, ForUpdateInterceptor.ApplyForUpdate(sql));
    }

    [Fact]
    public void Does_not_double_append_when_already_present()
    {
        var sql = $"-- {ForUpdateInterceptor.Tag}\nSELECT 1 FOR UPDATE";
        var rewritten = ForUpdateInterceptor.ApplyForUpdate(sql);
        Assert.Equal(1, System.Text.RegularExpressions.Regex.Matches(rewritten, "FOR UPDATE").Count);
    }

    [Fact]
    public void Does_not_touch_non_select_even_if_tagged()
    {
        var sql = $"-- {ForUpdateInterceptor.Tag}\nUPDATE product SET units_in_stock = 1";
        Assert.Equal(sql, ForUpdateInterceptor.ApplyForUpdate(sql));
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd services/orders && dotnet test --filter ForUpdateInterceptorTests`
Expected: FAIL — `ForUpdateInterceptor` / `ApplyForUpdate` don't exist.

- [ ] **Step 3: Implement the interceptor**

Create `services/orders/src/Orders.Infrastructure/Persistence/ForUpdateInterceptor.cs`:

```csharp
using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;

namespace Orders.Infrastructure.Persistence;

// Applies a pessimistic row lock (FOR UPDATE) to a query tagged with `Tag`, so the
// service can lock in pure LINQ instead of raw SQL — which lets EF Core's global
// soft-delete query filter (deleted_at IS NULL) apply automatically (ADR-0004).
//
// The service writes: _db.Products.TagWith(ForUpdateInterceptor.Tag).First...(...).
// EF emits that tag as a leading `-- orders:for-update` SQL comment; this
// interceptor detects it and appends ` FOR UPDATE`.
//
// MySQL-SPECIFIC: `FOR UPDATE` is InnoDB/Postgres syntax (Aurora MySQL here).
// If the engine ever changes, this is the single place to adjust.
public sealed class ForUpdateInterceptor : DbCommandInterceptor
{
    public const string Tag = "orders:for-update";

    public override InterceptionResult<DbDataReader> ReaderExecuting(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<DbDataReader> result)
    {
        command.CommandText = ApplyForUpdate(command.CommandText);
        return base.ReaderExecuting(command, eventData, result);
    }

    public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<DbDataReader> result,
        CancellationToken cancellationToken = default)
    {
        command.CommandText = ApplyForUpdate(command.CommandText);
        return base.ReaderExecutingAsync(command, eventData, result, cancellationToken);
    }

    // Pure, unit-testable rewrite. Appends FOR UPDATE only when: the SQL carries
    // our tag comment, is a SELECT, and doesn't already lock. Everything else is
    // returned unchanged.
    internal static string ApplyForUpdate(string sql)
    {
        if (!sql.Contains(Tag, StringComparison.Ordinal))
            return sql;
        if (sql.Contains("FOR UPDATE", StringComparison.OrdinalIgnoreCase))
            return sql;

        // Must be a SELECT (never mutate INSERT/UPDATE/DELETE). Check the first
        // non-comment statement keyword.
        var firstKeyword = FirstSqlKeyword(sql);
        if (!string.Equals(firstKeyword, "SELECT", StringComparison.OrdinalIgnoreCase))
            return sql;

        return sql.TrimEnd().TrimEnd(';') + " FOR UPDATE";
    }

    private static string FirstSqlKeyword(string sql)
    {
        foreach (var raw in sql.Split('\n'))
        {
            var line = raw.Trim();
            if (line.Length == 0 || line.StartsWith("--", StringComparison.Ordinal))
                continue;
            var space = line.IndexOf(' ');
            return space < 0 ? line : line[..space];
        }
        return string.Empty;
    }
}
```

> `ApplyForUpdate` strips a trailing `;` before appending (Pomelo may or may not terminate with one) and re-appends nothing after `FOR UPDATE`. The tag match uses `Contains` (looser than the exact `-- <Tag>\n` format) — robust to EF comment-format changes while still specific (the tag string is unique). Verify against Pomelo's actual generated SQL in Task 3's integration run.

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `cd services/orders && dotnet test --filter ForUpdateInterceptorTests`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add services/orders/src/Orders.Infrastructure/Persistence/ForUpdateInterceptor.cs services/orders/tests/Orders.Tests/Infrastructure/ForUpdateInterceptorTests.cs
git commit -m "feat(orders): ForUpdateInterceptor — append FOR UPDATE to a tagged LINQ query"
```

---

## Task 2: Register the interceptor on the write context

**Files:**
- Modify: `services/orders/src/Orders.Infrastructure/Persistence/OrdersWriteDbContext.cs`

**Interfaces:**
- Consumes: `ForUpdateInterceptor` (Task 1).
- Produces: the write context runs both `AuditInterceptor` and `ForUpdateInterceptor`.

- [ ] **Step 1: Add the interceptor**

In `OrdersWriteDbContext.cs`, `OnConfiguring` currently registers only `AuditInterceptor`. Add `ForUpdateInterceptor`:

```csharp
protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
{
    optionsBuilder.AddInterceptors(new AuditInterceptor(), new ForUpdateInterceptor());
}
```

- [ ] **Step 2: Build**

Run: `cd services/orders && dotnet build`
Expected: `Build succeeded`.

- [ ] **Step 3: Commit**

```bash
git add services/orders/src/Orders.Infrastructure/Persistence/OrdersWriteDbContext.cs
git commit -m "feat(orders): register ForUpdateInterceptor on the write DbContext"
```

---

## Task 3: Replace the raw query in CreateOrderService with tagged LINQ

**Files:**
- Modify: `services/orders/src/Orders.Infrastructure/Orders/CreateOrderService.cs`

**Interfaces:**
- Consumes: `ForUpdateInterceptor.Tag` (Task 1), the write context (Task 2).
- Produces: the product lock is now `_db.Products.TagWith(ForUpdateInterceptor.Tag).FirstOrDefaultAsync(...)` — no raw SQL.

- [ ] **Step 1: Replace the FromSqlInterpolated block**

In `CreateOrderService.cs`, replace the raw-SQL product lock (the `FromSqlInterpolated($"SELECT * FROM product WHERE id = {line.ProductId} AND deleted_at IS NULL FOR UPDATE")` block) with:

```csharp
                // Pessimistic lock so concurrent orders cannot oversell. Pure LINQ
                // tagged with ForUpdateInterceptor.Tag — the interceptor appends
                // FOR UPDATE, and EF Core's global query filter applies deleted_at
                // IS NULL automatically (ADR-0004), so a soft-deleted product is
                // never locked/read/sold. Requires the open write transaction above.
                var product = await _db.Products
                    .TagWith(ForUpdateInterceptor.Tag)
                    .FirstOrDefaultAsync(p => p.Id == line.ProductId, ct)
                    ?? throw new InsufficientStockException(line.ProductId);
```

Add the needed `using Orders.Infrastructure.Persistence;` if not already present (for `ForUpdateInterceptor`). Keep everything below (stock check, pricing, decrement) unchanged.

- [ ] **Step 2: Build**

Run: `cd services/orders && dotnet build`
Expected: `Build succeeded`. Confirm no `FromSqlInterpolated` remains: `grep -rn "FromSql" services/orders/src` returns nothing.

- [ ] **Step 3: Run the existing create-order + soft-delete tests**

Run: `cd services/orders && dotnet test --filter CreateOrderServiceTests`
Expected: PASS — includes `Rejects_soft_deleted_product` (now via the auto-applied query filter), happy path (stock decremented), insufficient stock (rollback), unknown user (throws). All must pass against Testcontainers-MySQL, proving the lock + transaction + soft-delete still work with the new mechanism.

- [ ] **Step 4: Commit**

```bash
git add services/orders/src/Orders.Infrastructure/Orders/CreateOrderService.cs
git commit -m "refactor(orders): lock products via tagged LINQ, dropping the raw FOR UPDATE SQL"
```

---

## Task 4: Integration test — the emitted SQL actually contains FOR UPDATE

**Files:**
- Test: `services/orders/tests/Orders.Tests/Infrastructure/ForUpdateEmittedSqlTests.cs`

**Interfaces:**
- Consumes: the write context + interceptor end-to-end.
- Produces: proof that a tagged query really executes with `FOR UPDATE` against MySQL (catches a desynced tag / EF comment-format change — the silent-failure risk from the design).

- [ ] **Step 1: Write the test capturing the final SQL**

Create `services/orders/tests/Orders.Tests/Infrastructure/ForUpdateEmittedSqlTests.cs`. Use the Testcontainers-MySQL pattern (see CreateOrderServiceTests / MigrationSeedTests for container + context setup). Attach a capturing `DbCommandInterceptor` AFTER `ForUpdateInterceptor` in the options so it sees the final CommandText, run the tagged query, and assert `FOR UPDATE` is present:

```csharp
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using System.Data.Common;
using Orders.Infrastructure.Persistence;
using Testcontainers.MySql;
using Xunit;

namespace Orders.Tests.Infrastructure;

public class ForUpdateEmittedSqlTests : IAsyncLifetime
{
    private readonly MySqlContainer _mysql = new MySqlBuilder("mysql:8.0").WithDatabase("orders").Build();
    public Task InitializeAsync() => _mysql.StartAsync();
    public Task DisposeAsync() => _mysql.DisposeAsync().AsTask();

    private sealed class CapturingInterceptor : DbCommandInterceptor
    {
        public string? LastSql;
        public override InterceptionResult<DbDataReader> ReaderExecuting(
            DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result)
        {
            LastSql = command.CommandText;
            return base.ReaderExecuting(command, eventData, result);
        }
        public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
            DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result,
            CancellationToken ct = default)
        {
            LastSql = command.CommandText;
            return base.ReaderExecutingAsync(command, eventData, result, ct);
        }
    }

    [Fact]
    public async Task Tagged_query_executes_with_for_update()
    {
        var cs = _mysql.GetConnectionString();
        var capture = new CapturingInterceptor();
        var options = new DbContextOptionsBuilder<OrdersWriteDbContext>()
            .UseMySql(cs, ServerVersion.AutoDetect(cs))
            // ForUpdateInterceptor runs first (from OnConfiguring), then capture sees the final text.
            .AddInterceptors(capture)
            .Options;

        await using var db = new OrdersWriteDbContext(options);
        await db.Database.MigrateAsync();

        await using var tx = await db.Database.BeginTransactionAsync();
        _ = await db.Products.TagWith(ForUpdateInterceptor.Tag)
            .FirstOrDefaultAsync(p => p.Id == "prd_none");
        await tx.CommitAsync();

        Assert.NotNull(capture.LastSql);
        Assert.Contains("FOR UPDATE", capture.LastSql!, StringComparison.OrdinalIgnoreCase);
        // And the soft-delete filter is still there (LINQ query filter applied):
        Assert.Contains("deleted_at", capture.LastSql!, StringComparison.OrdinalIgnoreCase);
    }
}
```

> Interceptor ordering: EF runs interceptors in registration order. `ForUpdateInterceptor` is registered in `OnConfiguring` (on the context); the capturing one is added via the options builder. Verify the capture sees the REWRITTEN text (post-FOR UPDATE) — if ordering makes it see the pre-rewrite text, register the capture so it runs after (or assert on a log sink instead). Adjust at implementation so the assertion observes the final SQL; the point is to prove FOR UPDATE reaches the DB.

- [ ] **Step 2: Run it**

Run: `cd services/orders && dotnet test --filter ForUpdateEmittedSqlTests`
Expected: PASS — the executed SQL contains both `FOR UPDATE` and `deleted_at` (lock applied + soft-delete filter applied).

> If the capture observes pre-rewrite SQL (no FOR UPDATE) due to interceptor ordering, switch to capturing via a `ListLoggerFactory`/`ToQueryString` is NOT enough (ToQueryString won't show the interceptor's change) — instead register the capturing interceptor so it runs last, or read the command from EF's `RelationalCommandExecuting` log. Make the assertion observe the final executed text.

- [ ] **Step 3: Full build + test + format**

Run: `cd services/orders && dotnet build && dotnet test && dotnet format --verify-no-changes`
Expected: build clean, ALL tests pass, format clean.

- [ ] **Step 4: Commit**

```bash
git add services/orders/tests/Orders.Tests/Infrastructure/ForUpdateEmittedSqlTests.cs
git commit -m "test(orders): assert the tagged query executes with FOR UPDATE + soft-delete filter"
```

---

## Self-review — spec coverage

- §1 mechanism: LINQ + TagWith(shared const) + interceptor appends FOR UPDATE → Tasks 1, 3. ✓
- §1 soft-delete filter applies automatically (no manual predicate) → Task 3 (LINQ query, filter via config) + Task 4 asserts `deleted_at` present. ✓
- §2a location: interceptor in Persistence/, registered on WRITE context OnConfiguring, not read context → Task 2. ✓
- §2b MySQL-specific FOR UPDATE, documented single point → Task 1 (interceptor comment). ✓
- §2c edge — tag desync / silent no-lock: shared const (Task 1) + Task 4 asserts FOR UPDATE actually emitted. ✓
- §2d idempotency: don't double-append, only SELECT → Task 1 (`ApplyForUpdate` guards) + unit tests. ✓
- §3a existing Rejects_soft_deleted_product still passes → Task 3 Step 3. ✓
- §3b assert FOR UPDATE emitted → Task 4. ✓
- §3c existing create-order integration tests pass → Task 3 Step 3. ✓
- Open questions: override both ReaderExecuting + async (Task 1, both done); match via Contains(Tag) looser form (Task 1, documented); handle trailing semicolon/whitespace (Task 1 `ApplyForUpdate` TrimEnd/TrimEnd(';')). ✓

## Related

- [[2026-07-16-orders-for-update-interceptor-design]]
- [[orders-service-design]]
- [[2026-07-14-orders-service-milestone-design]]
- [[ADR-0004-soft-delete-only]]
- [[cqrs]]
- [[db-naming]]
