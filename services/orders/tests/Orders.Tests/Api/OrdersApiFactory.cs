using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Orders.Application.Abstractions;
using Orders.Application.Identity;
using Orders.Application.Tracking;
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

    // WHY: A real Redis, not a fake — the tests exercise TTL bookkeeping, expiry and
    // byte-for-byte replay, which a dictionary would only agree with.
    private readonly RedisContainer _redis = new RedisBuilder("redis:7-alpine").Build();

    public const string KnownCognitoSub = "sub-known";
    public const string KnownUserId = "usr_known";

    // CONTRACT: Keep a second RESOLVABLE identity here. An unresolvable caller reaches the
    // handler with a null ResolvedInternalUserId, so nothing is cached for them and the
    // isolation assertion passes because caching was SKIPPED — it would keep passing if the
    // keys stopped carrying identity at all. This is the only factory with a real cache.
    public const string OtherCognitoSub = "sub-other";
    public const string OtherUserId = "usr_other";

    // CONTRACT: A caller authenticating with its internal usr_ id, not a sub, resolving to
    // itself. Not artificial — GetUserById accepts either identifier and the E2E direct path
    // sends exactly this, so cache keys really are filed under a usr_ id. Dropping it hides
    // the half of the account-deletion cascade that sweeps by sub only.
    public const string SelfResolvingUserId = "usr_selfref";
    // WHY: Rides on the GetUserById response; ORDER_CREATED carries it to the pipeline.
    public const string KnownEmail = "known@example.com";
    // WHY: Same response as the email; the confirmation mail greets the buyer by name.
    public const string KnownFullName = "Known Buyer";
    public string SeededProductId { get; private set; } = string.Empty;

    /// <summary>
    /// The trackings the stubbed <see cref="ITrackingReader"/> reports, keyed by order id.
    /// CONTRACT: A test that sets this MUST clear it again (<see cref="ClearTrackings"/>) —
    /// the factory is a collection fixture, so an entry left behind leaks into every later
    /// class. See [[testing]]
    /// </summary>
    public Dictionary<string, TrackingDto> StubTrackings { get; } = new();

    /// <summary>Builds a minimal well-formed tracking for <paramref name="orderId"/>.</summary>
    public static TrackingDto TrackingFor(string orderId, string userId = KnownUserId) =>
        new(
            Id: $"trk_{orderId}",
            UserId: userId,
            OrderId: orderId,
            Status: "PENDING",
            Datetime: "2026-08-26T00:00:00Z",
            History: Array.Empty<TrackingHistoryEntryDto>());

    public void ClearTrackings() => StubTrackings.Clear();

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

        // WHY: CreateOrderService reads the tax rate per-request from the configuration
        // table, so the row must exist before any order is created.
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
    /// CONTRACT: Keep <c>allowAdmin=true</c> — FLUSHDB is an admin command the client
    /// otherwise refuses. See [[testing]]
    /// </summary>
    public async Task FlushCacheAsync()
    {
        await using var mux = await ConnectionMultiplexer.ConnectAsync(
            $"{_redis.Hostname}:{_redis.GetMappedPublicPort(6379)},allowAdmin=true");
        await mux.GetServer(mux.GetEndPoints().Single()).FlushDatabaseAsync();
    }

    /// <summary>
    /// Whether <paramref name="key"/> is present in Redis right now, for entries with no
    /// HTTP surface. The identity mapping is read behind every route and never reaches an
    /// <c>X-Cache</c> header, so the header alone says nothing about it.
    /// </summary>
    public async Task<bool> CacheKeyExistsAsync(string key)
    {
        await using var mux = await ConnectionMultiplexer.ConnectAsync(
            $"{_redis.Hostname}:{_redis.GetMappedPublicPort(6379)}");
        return await mux.GetDatabase().KeyExistsAsync(key);
    }

    /// <summary>
    /// Writes raw JSON at <paramref name="key"/>, bypassing the service.
    /// CONTRACT: A test proving the identity mapping is invalidated must seed it here —
    /// <c>ConfigureTestServices</c> discards the <c>CachedUserDirectory</c> decorator that
    /// writes that key, so the alternative asserts an absent key is absent, which passes
    /// against an invalidator that does nothing. See [[testing]]
    /// </summary>
    public async Task SetCacheKeyAsync(string key, string value, TimeSpan ttl)
    {
        await using var mux = await ConnectionMultiplexer.ConnectAsync(
            $"{_redis.Hostname}:{_redis.GetMappedPublicPort(6379)}");
        await mux.GetDatabase().StringSetAsync(key, value, ttl);
    }

    // WHY: A fresh write context over the same container, for tests exercising EF/MySQL
    // behaviour directly (the generated-column unique indexes) rather than over HTTP.
    public OrdersWriteDbContext NewWriteContext()
    {
        var cs = _mysql.GetConnectionString();
        return new OrdersWriteDbContext(new DbContextOptionsBuilder<OrdersWriteDbContext>()
            .UseMySql(cs, ServerVersion.AutoDetect(cs)).Options);
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        var cs = _mysql.GetConnectionString();

        // WHY: Program reads these from configuration, so the host needs valid values.
        // USERS_GRPC_URL is a placeholder — the stub below replaces the real client.
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
        // WHY: The response cache runs for real against the container above; CACHE_ENABLED
        // is explicit so this factory's intent is visible where a reader looks for it.
        builder.UseSetting("REDIS_HOST", _redis.Hostname);
        builder.UseSetting("REDIS_PORT", _redis.GetMappedPublicPort(6379).ToString());
        builder.UseSetting("CACHE_ENABLED", "true");

        builder.ConfigureTestServices(services =>
        {
            var directory = services.Single(d => d.ServiceType == typeof(IUserDirectory));
            services.Remove(directory);
            services.AddScoped<IUserDirectory>(_ => new StubDirectory());

            // CONTRACT: Keep the Noop publisher — otherwise every order created here attempts
            // a real SendMessage against a queue that does not exist.
            var events = services.Single(d => d.ServiceType == typeof(IEventPublisher));
            services.Remove(events);
            services.AddScoped<IEventPublisher, NoopEventPublisher>();

            // WHY: The tracking READ port, stubbed off StubTrackings above. The real client
            // reaches a placeholder address on every includeTracking=true read — it degrades
            // to null, so only the null half of the behaviour would ever be reachable.
            var trackingReader = services.SingleOrDefault(
                d => d.ServiceType == typeof(ITrackingReader));
            if (trackingReader is not null)
            {
                services.Remove(trackingReader);
            }
            services.AddScoped<ITrackingReader>(_ => new StubTrackingReader(this));

            var metricsDescriptor = services.SingleOrDefault(
                d => d.ServiceType == typeof(IMetricsPublisher));
            if (metricsDescriptor is not null)
            {
                services.Remove(metricsDescriptor);
            }
            services.AddSingleton<IMetricsPublisher>(new NoopMetricsPublisher());
        });
    }

    /// <summary>
    /// Reports whatever <see cref="StubTrackings"/> currently holds, read at CALL time so a
    /// test can flip the state mid-test — the async-tracking window is a transition from
    /// absent to present between two reads on one order.
    /// </summary>
    private sealed class StubTrackingReader : ITrackingReader
    {
        private readonly OrdersApiFactory _factory;

        public StubTrackingReader(OrdersApiFactory factory) => _factory = factory;

        public Task<IReadOnlyDictionary<string, TrackingDto>> GetTrackingsAsync(
            IReadOnlyCollection<string> orderIds,
            string cognitoSub,
            CancellationToken ct = default)
        {
            var found = orderIds
                .Where(_factory.StubTrackings.ContainsKey)
                .ToDictionary(id => id, id => _factory.StubTrackings[id]);
            return Task.FromResult<IReadOnlyDictionary<string, TrackingDto>>(found);
        }
    }

    private sealed class StubDirectory : IUserDirectory
    {
        // WHY: Any other sub resolves to null, keeping "an unresolvable caller is never
        // cached" reachable.
        private static string? IdFor(string sub) => sub switch
        {
            KnownCognitoSub => KnownUserId,
            OtherCognitoSub => OtherUserId,
            // WHY: Resolves to ITSELF, mirroring GetUserById, which accepts either
            // identifier and returns the same user.
            SelfResolvingUserId => SelfResolvingUserId,
            _ => null,
        };

        public Task<string?> ResolveInternalUserIdAsync(string cognitoSub, CancellationToken ct = default)
            => Task.FromResult(IdFor(cognitoSub));

        // WHY: A populated address, so tests exercise the snapshot path rather than the
        // "no address on file" branch.
        public Task<CallerProfile?> ResolveCallerAsync(string cognitoSub, CancellationToken ct = default)
        {
            var id = IdFor(cognitoSub);
            return Task.FromResult(id is null
                ? null
                : new CallerProfile(
                    id,
                    // CONTRACT: The known user keeps its fixed email/name — tests assert on
                    // those exact constants in the ORDER_CREATED envelope.
                    id == KnownUserId ? KnownEmail : $"{id}@example.com",
                    id == KnownUserId ? KnownFullName : $"Test {id}",
                    new CallerAddress("1 Test St", null, "Testville", null, "Testland", null)));
        }
    }
}
