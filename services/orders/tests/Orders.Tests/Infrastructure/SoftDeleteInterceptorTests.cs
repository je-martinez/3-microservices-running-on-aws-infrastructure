using Microsoft.EntityFrameworkCore;
using Orders.Application.Abstractions;
using Orders.Domain.Entities;
using Orders.Infrastructure.Persistence;
using Testcontainers.MySql;
using Xunit;

namespace Orders.Tests.Infrastructure;

// ADR-0004 (soft-delete only) enforced at the code layer: a tracked `.Remove()`
// on an AuditableEntity followed by SaveChanges must NOT physically delete the
// row. The AuditInterceptor rewrites the Deleted state to Modified and stamps the
// soft-delete columns, so EF issues an UPDATE instead of a DELETE. This test
// proves the row survives physically with DeletedAt/DeletedBy set and is hidden
// by the global query filter.
public class SoftDeleteInterceptorTests : IAsyncLifetime
{
    private readonly MySqlContainer _mysql =
        new MySqlBuilder("mysql:8.0").WithDatabase("orders").Build();

    public Task InitializeAsync() => _mysql.StartAsync();
    public Task DisposeAsync() => _mysql.DisposeAsync().AsTask();

    private OrdersWriteDbContext NewContext()
    {
        var cs = _mysql.GetConnectionString();
        return new OrdersWriteDbContext(new DbContextOptionsBuilder<OrdersWriteDbContext>()
            .UseMySql(cs, ServerVersion.AutoDetect(cs)).Options);
    }

    [Fact]
    public async Task Remove_becomes_soft_delete_row_survives_physically()
    {
        const string key = "soft_delete_probe";
        await using var db = NewContext();
        await db.Database.MigrateAsync();

        db.Configurations.Add(new Configuration { Key = key, Value = "v" });
        await db.SaveChangesAsync();

        // Physically DELETE via the change tracker, wrapped so the actor is stamped.
        await AmbientActor.RunAsync(AuditActor.E2eCleanup, async () =>
        {
            var config = await db.Configurations.SingleAsync(c => c.Key == key);
            db.Configurations.Remove(config);
            await db.SaveChangesAsync();
        });

        // The row must STILL EXIST physically (no DELETE happened) — found only via
        // IgnoreQueryFilters — and carry the soft-delete stamps.
        var survivor = await db.Configurations
            .AsNoTracking()
            .IgnoreQueryFilters()
            .SingleOrDefaultAsync(c => c.Key == key);

        Assert.NotNull(survivor);
        Assert.NotNull(survivor!.DeletedAt);
        Assert.Equal(AuditActor.E2eCleanup, survivor.DeletedBy);

        // A normal query (WITH the global DeletedAt == null filter) must NOT return
        // it — it is soft-deleted, so filtered out.
        var filtered = await db.Configurations
            .AsNoTracking()
            .SingleOrDefaultAsync(c => c.Key == key);

        Assert.Null(filtered);
    }
}
