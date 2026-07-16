using System.Data.Common;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Orders.Infrastructure.Persistence;
using Testcontainers.MySql;
using Xunit;

namespace Orders.Tests.Infrastructure;

// End-to-end proof that a tagged LINQ query really executes with FOR UPDATE
// against MySQL — catches a desynced tag or an EF comment-format change (the
// silent-no-lock risk from the design). The capturing interceptor records the
// FINAL CommandText EF hands to the driver, so it must observe the text AFTER
// ForUpdateInterceptor has rewritten it.
//
// Interceptor ordering (verified empirically against EF Core 9 + Pomelo): EF
// invokes interceptors in registration order, and interceptors supplied to the
// options builder run BEFORE those added inside the context's OnConfiguring.
// So the options-supplied capture would see the PRE-rewrite SQL if it relied on
// OnConfiguring's ForUpdateInterceptor. To make the capture observe the rewritten
// text we register a ForUpdateInterceptor on the options FIRST, then the capture
// immediately AFTER it — the capture now sees the rewrite. OnConfiguring later
// adds its own ForUpdateInterceptor, which is a harmless no-op here because the
// SQL already contains FOR UPDATE (ApplyForUpdate's idempotency guard). This test
// therefore exercises the exact production rewrite and proves it reaches MySQL.
public class ForUpdateEmittedSqlTests : IAsyncLifetime
{
    private readonly MySqlContainer _mysql =
        new MySqlBuilder("mysql:8.0").WithDatabase("orders").Build();
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
            // Register ForUpdateInterceptor first, then capture — so the capture
            // observes the rewritten (FOR UPDATE-appended) CommandText. This mirrors
            // the production interceptor exactly; OnConfiguring re-adds it as a no-op.
            .AddInterceptors(new ForUpdateInterceptor(), capture)
            .Options;

        await using var db = new OrdersWriteDbContext(options);
        await db.Database.MigrateAsync();

        await using var tx = await db.Database.BeginTransactionAsync();
        _ = await db.Products.TagWith(ForUpdateInterceptor.Tag)
            .FirstOrDefaultAsync(p => p.Id == "prd_none");
        await tx.CommitAsync();

        Assert.NotNull(capture.LastSql);
        // Lock applied by the interceptor:
        Assert.Contains("FOR UPDATE", capture.LastSql!, StringComparison.OrdinalIgnoreCase);
        // And the soft-delete filter is still there (LINQ global query filter applied):
        Assert.Contains("deleted_at", capture.LastSql!, StringComparison.OrdinalIgnoreCase);
    }
}
