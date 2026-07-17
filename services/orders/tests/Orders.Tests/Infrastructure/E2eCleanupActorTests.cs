using Microsoft.EntityFrameworkCore;
using Orders.Application.Abstractions;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;
using Orders.Infrastructure.Persistence;
using Testcontainers.MySql;
using Xunit;

namespace Orders.Tests.Infrastructure;

// The e2e-cleanup endpoint soft-deletes via ExecuteUpdateAsync, which BYPASSES
// SaveChanges (and therefore the AuditInterceptor); it stamps DeletedBy
// explicitly with AuditActor.E2eCleanup. This test reproduces that exact update
// against a real MySQL and asserts the semantic actor lands in DeletedBy.
public class E2eCleanupActorTests : IAsyncLifetime
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
    public async Task Soft_delete_stamps_e2e_cleanup_actor()
    {
        const string sub = "sub-cleanup";
        await using var db = NewContext();
        await db.Database.MigrateAsync();

        var orderId = NanoId.NewId(NanoId.OrderPrefix);
        db.Orders.Add(new Order
        {
            Id = orderId,
            UserId = "usr_x",
            CognitoSub = sub,
            SubtotalCents = 0,
            TaxCents = 0,
            TotalCents = 0,
        });
        await db.SaveChangesAsync();

        var now = DateTime.UtcNow;
        await db.Orders.Where(o => o.CognitoSub == sub)
            .ExecuteUpdateAsync(s => s
                .SetProperty(o => o.DeletedAt, now)
                .SetProperty(o => o.DeletedBy, AuditActor.E2eCleanup));

        // IgnoreQueryFilters: the soft-deleted row is hidden by the global
        // DeletedAt == null filter otherwise.
        var order = await db.Orders.AsNoTracking().IgnoreQueryFilters().FirstAsync(o => o.Id == orderId);
        Assert.NotNull(order.DeletedAt);
        Assert.Equal(AuditActor.E2eCleanup, order.DeletedBy);
    }
}
