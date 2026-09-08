using System.Data.Common;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Orders.Infrastructure.Persistence;
using Testcontainers.MySql;
using Xunit;

namespace Orders.Tests.Infrastructure;

// Proves a tagged LINQ query really reaches MySQL with FOR UPDATE, catching a desynced tag
// or an EF comment-format change — the silent no-lock risk.
// CONTRACT: Register a ForUpdateInterceptor on the OPTIONS first, then the capture right
// after it. EF invokes interceptors in registration order and options-supplied ones run
// before OnConfiguring's, so a capture relying on OnConfiguring's interceptor observes the
// PRE-rewrite SQL and the test passes while proving nothing.
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
