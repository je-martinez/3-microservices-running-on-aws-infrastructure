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

        Assert.Equal(8, await db.Products.CountAsync());
        Assert.All(await db.Products.ToListAsync(), p =>
        {
            Assert.StartsWith("prd_", p.Id);
            // The audit interceptor stamps the semantic seed actor, not "system".
            Assert.Equal(AuditActor.ProductSeed, p.CreatedBy);
            Assert.Equal(AuditActor.ProductSeed, p.UpdatedBy);

            // Every seeded product is fully specified: a category and artwork.
            Assert.NotEmpty(p.Categories);
            Assert.NotNull(p.Image);

            // The relative-uri invariant, ENFORCED rather than documented: the stored
            // uri is a bucket key, never an absolute URL. An absolute one would be dead
            // data after the next `make clean` re-mints the bucket.
            Assert.StartsWith("products/", p.Image!.Uri);
            Assert.DoesNotContain("://", p.Image.Uri);
            Assert.NotEmpty(p.Image.Blurhash);
            Assert.True(p.Image.Width > 0 && p.Image.Height > 0);
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
