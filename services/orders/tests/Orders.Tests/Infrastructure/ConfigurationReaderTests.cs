using Microsoft.EntityFrameworkCore;
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
}
