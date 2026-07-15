using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Orders.Application.Identity;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;
using Orders.Infrastructure.Persistence;
using Testcontainers.MySql;

namespace Orders.Tests.Api;

// Boots the real Program against a Testcontainers MySQL and replaces the gRPC
// IUserDirectory with an in-memory stub (no live Users service in tests). Seeds
// one product and one known cognito sub so happy-path/409 can be exercised.
public sealed class OrdersApiFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    private readonly MySqlContainer _mysql =
        new MySqlBuilder("mysql:8.0").WithDatabase("orders").Build();

    public const string KnownCognitoSub = "sub-known";
    public const string KnownUserId = "usr_known";
    public string SeededProductId { get; private set; } = string.Empty;

    public async Task InitializeAsync()
    {
        await _mysql.StartAsync();

        var cs = _mysql.GetConnectionString();
        await using var db = new OrdersWriteDbContext(new DbContextOptionsBuilder<OrdersWriteDbContext>()
            .UseMySql(cs, ServerVersion.AutoDetect(cs)).Options);
        await db.Database.MigrateAsync();
        SeededProductId = NanoId.NewId(NanoId.ProductPrefix);
        db.Products.Add(new Product
        {
            Id = SeededProductId,
            Name = "Widget",
            Description = "d",
            UnitPriceCents = 1000,
            UnitsInStock = 5,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow,
        });
        await db.SaveChangesAsync();

        // Tax rate now lives in the configuration table (was ORDERS_TAX_RATE);
        // CreateOrderService reads it per-request, so it must exist for the DB.
        await ConfigurationSeed.ApplyAsync(db);
    }

    public new async Task DisposeAsync()
    {
        await _mysql.DisposeAsync();
        await base.DisposeAsync();
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        var cs = _mysql.GetConnectionString();

        // Program reads these from configuration; supply valid values so the
        // host builds. USERS_GRPC_URL is a well-formed placeholder — the stub
        // IUserDirectory below replaces the real client, so no channel is dialed.
        builder.UseSetting("DATABASE_READER_URL", cs);
        builder.UseSetting("DATABASE_WRITER_URL", cs);
        builder.UseSetting("USERS_GRPC_URL", "http://localhost:50051");
        builder.UseSetting("GRPC_API_KEY", "test-key");

        builder.ConfigureTestServices(services =>
        {
            var directory = services.Single(d => d.ServiceType == typeof(IUserDirectory));
            services.Remove(directory);
            services.AddScoped<IUserDirectory>(_ => new StubDirectory());
        });
    }

    private sealed class StubDirectory : IUserDirectory
    {
        public Task<string?> ResolveInternalUserIdAsync(string cognitoSub, CancellationToken ct = default)
            => Task.FromResult<string?>(cognitoSub == KnownCognitoSub ? KnownUserId : null);
    }
}
