using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Orders.Application.Abstractions;
using Orders.Application.Identity;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;
using Orders.Infrastructure.Messaging;
using Orders.Infrastructure.Metrics;
using Orders.Infrastructure.Persistence;
using StackExchange.Redis;
using Testcontainers.MySql;
using Testcontainers.Redis;

namespace Orders.Tests.Api;

// Boots the real Program against a Testcontainers MySQL and replaces the gRPC
// IUserDirectory with an in-memory stub (no live Users service in tests). Seeds
// one product and one known cognito sub so happy-path/409 can be exercised.
public sealed class OrdersApiFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    private readonly MySqlContainer _mysql =
        new MySqlBuilder("mysql:8.0").WithDatabase("orders").Build();

    // A REAL Redis, not a fake: the response cache is exercised end to end through the
    // HTTP surface here, so the thing under test is the gateway talking to an actual
    // server (TTL bookkeeping, expiry, byte-for-byte replay) rather than a dictionary
    // that agrees with our assumptions about it.
    private readonly RedisContainer _redis = new RedisBuilder("redis:7-alpine").Build();

    public const string KnownCognitoSub = "sub-known";
    public const string KnownUserId = "usr_known";

    // A SECOND resolvable identity. Cross-user cache isolation cannot be tested with only
    // one: a second caller the stub does not resolve reaches the handler with a null
    // ResolvedInternalUserId, so the key builder declines and nothing is cached for them
    // at all — the isolation assertion would then pass because caching was SKIPPED, not
    // because the keys were scoped. That test would prove nothing and would keep passing
    // if the keys stopped carrying identity entirely.
    //
    // It lives here rather than on OrdersE2eApiFactory (which already has two identities)
    // because that host runs with CACHE_ENABLED=false and owns no Redis container, so it
    // emits no X-Cache header at all — deliberately, to keep the kill switch honest. This
    // factory is the only one with a real cache, so the second identity has to be here.
    public const string OtherCognitoSub = "sub-other";
    public const string OtherUserId = "usr_other";
    // Users returns an email on the same GetUserById response as the id; ORDER_CREATED
    // carries it to the pipeline, so the stub must supply one.
    public const string KnownEmail = "known@example.com";
    // Rides on the same GetUserById response as the email; ORDER_CREATED carries it so the
    // confirmation email can greet the buyer by name.
    public const string KnownFullName = "Known Buyer";
    public string SeededProductId { get; private set; } = string.Empty;

    public async Task InitializeAsync()
    {
        await _mysql.StartAsync();
        await _redis.StartAsync();

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
        await _redis.DisposeAsync();
        await base.DisposeAsync();
    }

    /// <summary>
    /// Empties the cache so a test can assert on a first-read MISS deterministically.
    /// </summary>
    /// <remarks>
    /// This factory is a COLLECTION fixture shared by every test class in the collection,
    /// so the cache survives across classes: without a flush, "the first read is a MISS"
    /// would pass or fail depending on whether some earlier class had already warmed the
    /// key. Ordering is not something a test may assume, so the state is reset instead.
    /// <c>allowAdmin=true</c> is required — FLUSHDB is an admin command and the client
    /// refuses it otherwise.
    /// </remarks>
    public async Task FlushCacheAsync()
    {
        await using var mux = await ConnectionMultiplexer.ConnectAsync(
            $"{_redis.Hostname}:{_redis.GetMappedPublicPort(6379)},allowAdmin=true");
        await mux.GetServer(mux.GetEndPoints().Single()).FlushDatabaseAsync();
    }

    // A fresh write context over the same container, for tests that need to exercise
    // EF/MySQL behaviour directly (e.g. the generated-column unique indexes) rather than
    // through the HTTP surface. Mirrors the construction InitializeAsync already does.
    public OrdersWriteDbContext NewWriteContext()
    {
        var cs = _mysql.GetConnectionString();
        return new OrdersWriteDbContext(new DbContextOptionsBuilder<OrdersWriteDbContext>()
            .UseMySql(cs, ServerVersion.AutoDetect(cs)).Options);
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
        // Well-formed placeholder so the typed Tracking client can be constructed.
        // Nothing in these tests calls it, so no request is ever dialed.
        builder.UseSetting("TRACKING_BASE_URL", "http://localhost:8000");
        // Well-formed placeholder so the SQS client can be constructed. Nothing is
        // ever sent to it: NoopEventPublisher replaces the real publisher below.
        builder.UseSetting("EVENTS_QUEUE_URL", "http://localhost:4566/000000000000/events");
        // Base URL the product read service prefixes onto each image's bucket key. A
        // fixed placeholder: these tests assert on the composed shape, not on a
        // reachable object, and nothing fetches the URL.
        builder.UseSetting("ASSETS_BASE_URL", "http://localhost:4566/test-assets");
        // The response cache runs for real in these tests, against the Redis container
        // above. CACHE_ENABLED is set explicitly rather than left to its default so the
        // intent is visible at the one place a reader looks for this factory's config.
        builder.UseSetting("REDIS_HOST", _redis.Hostname);
        builder.UseSetting("REDIS_PORT", _redis.GetMappedPublicPort(6379).ToString());
        builder.UseSetting("CACHE_ENABLED", "true");

        builder.ConfigureTestServices(services =>
        {
            var directory = services.Single(d => d.ServiceType == typeof(IUserDirectory));
            services.Remove(directory);
            services.AddScoped<IUserDirectory>(_ => new StubDirectory());

            // These tests must not emit: swap the real SQS publisher for the Noop, which
            // exists for exactly this. Without it, every order created here would attempt
            // a real SendMessage against a queue that does not exist.
            var events = services.Single(d => d.ServiceType == typeof(IEventPublisher));
            services.Remove(events);
            services.AddScoped<IEventPublisher, NoopEventPublisher>();

            // Same reason as the publisher above: the OrdersMetricsPublisher hosted
            // service ticks while these tests run, and the real client would attempt a
            // PutMetricData against a CloudWatch that is not there.
            var metricsDescriptor = services.SingleOrDefault(
                d => d.ServiceType == typeof(IMetricsPublisher));
            if (metricsDescriptor is not null)
            {
                services.Remove(metricsDescriptor);
            }
            services.AddSingleton<IMetricsPublisher>(new NoopMetricsPublisher());
        });
    }

    private sealed class StubDirectory : IUserDirectory
    {
        // Any OTHER sub still resolves to null, which is what keeps the
        // "unresolvable caller is never cached" case reachable.
        private static string? IdFor(string sub) => sub switch
        {
            KnownCognitoSub => KnownUserId,
            OtherCognitoSub => OtherUserId,
            _ => null,
        };

        public Task<string?> ResolveInternalUserIdAsync(string cognitoSub, CancellationToken ct = default)
            => Task.FromResult(IdFor(cognitoSub));

        // A populated address, so endpoint tests exercise the snapshot path rather
        // than the "user has none on file" branch.
        public Task<CallerProfile?> ResolveCallerAsync(string cognitoSub, CancellationToken ct = default)
        {
            var id = IdFor(cognitoSub);
            return Task.FromResult(id is null
                ? null
                : new CallerProfile(
                    id,
                    // The known user keeps its fixed email/name: existing tests assert on
                    // those exact constants in the ORDER_CREATED envelope. The second user
                    // derives its own from its id so the two stay distinguishable.
                    id == KnownUserId ? KnownEmail : $"{id}@example.com",
                    id == KnownUserId ? KnownFullName : $"Test {id}",
                    new CallerAddress("1 Test St", null, "Testville", null, "Testland", null)));
        }
    }
}
