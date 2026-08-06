using Microsoft.EntityFrameworkCore;
using Orders.Application.Abstractions;
using Orders.Domain.Entities;
using Orders.Infrastructure.Config;
using Orders.Infrastructure.Persistence;
using Testcontainers.MySql;
using Xunit;

namespace Orders.Tests.Infrastructure;

// Verifies ConfigurationReader reads and parses the `tax_rate` row from the
// configuration table (invariant-culture decimal), and throws when it is absent.
public class ConfigurationReaderTests : IAsyncLifetime
{
    private readonly MySqlContainer _mysql =
        new MySqlBuilder("mysql:8.0").WithDatabase("orders").Build();

    public Task InitializeAsync() => _mysql.StartAsync();
    public Task DisposeAsync() => _mysql.DisposeAsync().AsTask();

    private OrdersWriteDbContext WriteCtx()
    {
        var cs = _mysql.GetConnectionString();
        return new OrdersWriteDbContext(new DbContextOptionsBuilder<OrdersWriteDbContext>()
            .UseMySql(cs, ServerVersion.AutoDetect(cs)).Options);
    }

    private OrdersReadDbContext ReadCtx()
    {
        var cs = _mysql.GetConnectionString();
        return new OrdersReadDbContext(new DbContextOptionsBuilder<OrdersReadDbContext>()
            .UseMySql(cs, ServerVersion.AutoDetect(cs)).Options);
    }

    [Fact]
    public async Task Reads_and_parses_seeded_tax_rate()
    {
        await using (var write = WriteCtx())
        {
            await write.Database.MigrateAsync();
            await ConfigurationSeed.ApplyAsync(write);
        }

        await using var read = ReadCtx();
        var reader = new ConfigurationReader(read);

        Assert.Equal(0.08m, await reader.GetTaxRateAsync());
    }

    [Fact]
    public async Task Throws_when_tax_rate_missing()
    {
        await using (var write = WriteCtx())
        {
            await write.Database.MigrateAsync();   // schema only, no seed
        }

        await using var read = ReadCtx();
        var reader = new ConfigurationReader(read);

        await Assert.ThrowsAsync<InvalidOperationException>(() => reader.GetTaxRateAsync());
    }

    [Fact]
    public async Task Reads_and_parses_seeded_shipping_cents()
    {
        await using (var write = WriteCtx())
        {
            await write.Database.MigrateAsync();
            await ConfigurationSeed.ApplyAsync(write);
        }

        await using var read = ReadCtx();
        var reader = new ConfigurationReader(read);

        // Cents, not dollars: 1500 == $15.00. A reader that divided by 100 somewhere
        // would return 15 and fail here.
        Assert.Equal(1500L, await reader.GetShippingCentsAsync());
    }

    [Fact]
    public async Task Throws_when_shipping_cents_missing()
    {
        await using (var write = WriteCtx())
        {
            await write.Database.MigrateAsync();   // schema only, no seed
        }

        await using var read = ReadCtx();
        var reader = new ConfigurationReader(read);

        await Assert.ThrowsAsync<InvalidOperationException>(() => reader.GetShippingCentsAsync());
    }

    // The seed must add shipping_cents to a database that ALREADY has tax_rate. The
    // original single early-return on tax_rate would skip it, leaving every existing
    // deployment without the key and failing order creation on the missing-key throw.
    [Fact]
    public async Task Seeds_shipping_cents_onto_a_database_that_already_has_tax_rate()
    {
        await using (var write = WriteCtx())
        {
            await write.Database.MigrateAsync();
            // Simulate the pre-existing state: tax_rate present, shipping_cents absent.
            await AmbientActor.RunAsync(AuditActor.ConfigSeed, async () =>
            {
                var now = DateTime.UtcNow;
                write.Configurations.Add(new Configuration
                {
                    Key = ConfigurationSeed.TaxRateKey,
                    Value = "0.08",
                    CreatedAt = now,
                    UpdatedAt = now,
                });
                await write.SaveChangesAsync();
            });

            await ConfigurationSeed.ApplyAsync(write);
        }

        await using var read = ReadCtx();
        var reader = new ConfigurationReader(read);

        Assert.Equal(1500L, await reader.GetShippingCentsAsync());
        Assert.Equal(0.08m, await reader.GetTaxRateAsync());
    }
}
