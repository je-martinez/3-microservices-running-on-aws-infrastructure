using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Orders.Application.Identity;
using Orders.Application.Tracking;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;
using Orders.Infrastructure.Persistence;
using Testcontainers.MySql;

namespace Orders.Tests.Api;

/// <summary>
/// In-process host for the E2E-tagging tests, parameterised on
/// <c>E2E_TESTING_ENABLED</c>.
/// </summary>
/// <remarks>
/// <para>
/// The flag has to be a property of the HOST, not of a request: Program only MAPS
/// <c>/v1/orders/e2e-cleanup</c> when it is set, and <c>CreateOrderEndpoint</c> reads
/// it from configuration. "Flag on" and "flag off" are therefore two different
/// applications, and the flag-off one is what a production runtime looks like — the
/// case the security assertions need.
/// </para>
/// <para>
/// Each subclass owns its own MySQL container rather than sharing
/// <c>OrdersApiFactory</c>'s. Two independent reasons: a cleanup run soft-deletes every
/// tagged order in its database by design, and the shared fixture seeds a fixed 5 units
/// of stock that its existing tests consume exactly, so an extra order placed there
/// fails an unrelated test with a 409.
/// </para>
/// </remarks>
public abstract class OrdersE2eApiFactoryBase : WebApplicationFactory<Program>, IAsyncLifetime
{
    private readonly MySqlContainer _mysql =
        new MySqlBuilder("mysql:8.0").WithDatabase("orders").Build();

    public const string KnownCognitoSub = "sub-known";
    public const string KnownUserId = "usr_known";

    // A second identity, so the cleanup can be shown to remove rows across users
    // rather than only the caller's — the whole point of deleting by tag.
    public const string OtherCognitoSub = "sub-other";
    public const string OtherUserId = "usr_other";

    public string SeededProductId { get; private set; } = string.Empty;

    // What the last order creation forwarded to Tracking. The real client is replaced
    // (no Tracking service in tests), and this is how the propagation of x-e2e-source
    // across the seam is asserted.
    public SpyTracking Tracking { get; } = new();

    /// <summary>Value of <c>E2E_TESTING_ENABLED</c> for this host.</summary>
    protected abstract bool E2eTestingEnabled { get; }

    public async Task InitializeAsync()
    {
        await _mysql.StartAsync();

        await using var db = NewContext();
        await db.Database.MigrateAsync();
        SeededProductId = NanoId.NewId(NanoId.ProductPrefix);
        db.Products.Add(new Product
        {
            Id = SeededProductId,
            Name = "Widget",
            Description = "d",
            UnitPriceCents = 1000,
            // Stocked generously: every test on this host draws from this single row,
            // and none of them is about running out.
            UnitsInStock = 1000,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow,
        });
        await db.SaveChangesAsync();

        await ConfigurationSeed.ApplyAsync(db);
    }

    // A context on the same database, for tests that need to inspect rows the API does
    // not expose — a soft-deleted row, or a column absent from the response DTO.
    public OrdersWriteDbContext NewContext()
    {
        var cs = _mysql.GetConnectionString();
        return new OrdersWriteDbContext(new DbContextOptionsBuilder<OrdersWriteDbContext>()
            .UseMySql(cs, ServerVersion.AutoDetect(cs)).Options);
    }

    public new async Task DisposeAsync()
    {
        await _mysql.DisposeAsync();
        await base.DisposeAsync();
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        var cs = _mysql.GetConnectionString();

        builder.UseSetting("DATABASE_READER_URL", cs);
        builder.UseSetting("DATABASE_WRITER_URL", cs);
        builder.UseSetting("USERS_GRPC_URL", "http://localhost:50051");
        builder.UseSetting("GRPC_API_KEY", "test-key");
        builder.UseSetting("TRACKING_BASE_URL", "http://localhost:8000");
        builder.UseSetting("E2E_TESTING_ENABLED", E2eTestingEnabled ? "true" : "false");

        builder.ConfigureTestServices(services =>
        {
            var directory = services.Single(d => d.ServiceType == typeof(IUserDirectory));
            services.Remove(directory);
            services.AddScoped<IUserDirectory>(_ => new StubDirectory());

            // Replaces the typed HTTP client so nothing is dialed and the forwarded
            // flags can be read back.
            var tracking = services.Single(d => d.ServiceType == typeof(ITrackingInitiator));
            services.Remove(tracking);
            services.AddSingleton<ITrackingInitiator>(Tracking);
        });
    }

    private sealed class StubDirectory : IUserDirectory
    {
        private static string? IdFor(string sub) => sub switch
        {
            KnownCognitoSub => KnownUserId,
            OtherCognitoSub => OtherUserId,
            _ => null,
        };

        public Task<string?> ResolveInternalUserIdAsync(string cognitoSub, CancellationToken ct = default)
            => Task.FromResult(IdFor(cognitoSub));

        public Task<CallerProfile?> ResolveCallerAsync(string cognitoSub, CancellationToken ct = default)
        {
            var id = IdFor(cognitoSub);
            return Task.FromResult(id is null
                ? null
                : new CallerProfile(
                    id,
                    new CallerAddress("1 Test St", null, "Testville", null, "Testland", null)));
        }
    }

    // Records what order creation forwarded to Tracking. Always reports success: these
    // tests are about the flags crossing the seam, not the degrade paths
    // (TrackingHttpClientTests covers those).
    public sealed class SpyTracking : ITrackingInitiator
    {
        public bool E2eSource { get; private set; }
        public bool TestMode { get; private set; }

        public Task<TrackingInitResult> InitTrackingAsync(
            string orderId, string? shippingAddressJson, string cognitoSub, bool testMode,
            bool e2eSource = false, CancellationToken ct = default)
        {
            TestMode = testMode;
            E2eSource = e2eSource;
            return Task.FromResult(new TrackingInitResult(TrackingInitOutcome.Created, 201));
        }
    }
}

/// <summary>Host WITH <c>E2E_TESTING_ENABLED</c> — the local/CI shape.</summary>
public sealed class OrdersE2eApiFactory : OrdersE2eApiFactoryBase
{
    protected override bool E2eTestingEnabled => true;
}

/// <summary>Host WITHOUT <c>E2E_TESTING_ENABLED</c> — the production shape.</summary>
public sealed class OrdersDisabledE2eApiFactory : OrdersE2eApiFactoryBase
{
    protected override bool E2eTestingEnabled => false;
}

/// <summary>
/// Serialises the classes driving the E2E-enabled host: the cleanup endpoint
/// soft-deletes every tagged order in the shared database, so two of these classes
/// running concurrently would delete each other's fixtures.
/// </summary>
[CollectionDefinition(Name)]
public class OrdersE2eApiCollection : ICollectionFixture<OrdersE2eApiFactory>
{
    public const string Name = "orders-e2e-api";
}
