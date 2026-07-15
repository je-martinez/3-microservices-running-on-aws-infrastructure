using Microsoft.EntityFrameworkCore;
using Orders.Infrastructure.Persistence;
using Testcontainers.MySql;
using Xunit;

namespace Orders.Tests.Infrastructure;

public class MigrationSeedTests : IAsyncLifetime
{
    private readonly MySqlContainer _mysql =
        new MySqlBuilder("mysql:8.0").WithDatabase("orders").Build();

    public Task InitializeAsync() => _mysql.StartAsync();
    public Task DisposeAsync() => _mysql.DisposeAsync().AsTask();

    private OrdersWriteDbContext NewContext()
    {
        var cs = _mysql.GetConnectionString();
        var options = new DbContextOptionsBuilder<OrdersWriteDbContext>()
            .UseMySql(cs, ServerVersion.AutoDetect(cs))
            .Options;
        return new OrdersWriteDbContext(options);
    }

    [Fact]
    public async Task Migrations_apply_and_seed_inserts_catalog()
    {
        await using var db = NewContext();
        await db.Database.MigrateAsync();
        await ProductSeed.ApplyAsync(db);

        Assert.Equal(3, await db.Products.CountAsync());
        Assert.All(await db.Products.ToListAsync(), p => Assert.StartsWith("prd_", p.Id));
    }
}
