using Microsoft.EntityFrameworkCore;
using Orders.Application.Abstractions;
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
        Assert.All(await db.Products.ToListAsync(), p =>
        {
            Assert.StartsWith("prd_", p.Id);
            // The audit interceptor stamps the semantic seed actor, not "system".
            Assert.Equal(AuditActor.ProductSeed, p.CreatedBy);
            Assert.Equal(AuditActor.ProductSeed, p.UpdatedBy);
        });
    }

    [Fact]
    public async Task Config_seed_stamps_config_seed_actor()
    {
        await using var db = NewContext();
        await db.Database.MigrateAsync();
        await ConfigurationSeed.ApplyAsync(db);

        var config = await db.Configurations.SingleAsync(c => c.Key == ConfigurationSeed.TaxRateKey);
        Assert.Equal(AuditActor.ConfigSeed, config.CreatedBy);
        Assert.Equal(AuditActor.ConfigSeed, config.UpdatedBy);
    }
}
