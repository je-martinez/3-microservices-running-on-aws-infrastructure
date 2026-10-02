using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Orders.Api.BackgroundServices;
using Orders.Application.Abstractions;
using Orders.Infrastructure.Caching;
using Orders.Infrastructure.Observability;
using Orders.Infrastructure.Persistence;

namespace Orders.Tests.Metrics;

/// <summary>
/// CONTRACT: Assert the seeded dimension sets literally. Floci does not aggregate across
/// dimensions, so a seed whose set differs from what <see cref="CacheGateway"/> emits creates
/// a separate series and the card still throws in a quiet window. See [[ADR-0017-floci-local]]
/// </summary>
public class OrdersMetricsPublisherCacheSeedTests
{
    private sealed record Publication(string Name, double Value, IReadOnlyDictionary<string, string> Dimensions);

    private sealed class RecordingMetricsPublisher : IMetricsPublisher
    {
        public List<Publication> Published { get; } = new();

        public Task PublishAsync(
            string name,
            double value,
            IReadOnlyDictionary<string, string> dimensions,
            CancellationToken cancellationToken = default)
        {
            Published.Add(new Publication(name, value, dimensions));
            return Task.CompletedTask;
        }
    }

    private static async Task<List<Publication>> RunOneTickAsync(string dbName)
    {
        var services = new ServiceCollection();
        services.AddDbContext<OrdersReadDbContext>(o => o.UseInMemoryDatabase(dbName));
        using var provider = services.BuildServiceProvider();
        var metrics = new RecordingMetricsPublisher();

        var publisher = new OrdersMetricsPublisher(
            provider.GetRequiredService<IServiceScopeFactory>(),
            metrics,
            new WorkflowTracer(),
            NullLogger<OrdersMetricsPublisher>.Instance,
            new ConfigurationBuilder().AddInMemoryCollection().Build());

        await publisher.CollectAndPublishAsync(CancellationToken.None);
        return metrics.Published;
    }

    [Fact]
    public async Task Tick_SeedsCacheRequestsAtZero_ForEveryPrefixAndResult()
    {
        var published = await RunOneTickAsync(nameof(Tick_SeedsCacheRequestsAtZero_ForEveryPrefixAndResult));

        var seeds = published.Where(p => p.Name == "cache_requests_total").ToList();
        Assert.All(seeds, s => Assert.Equal(0, s.Value));
        Assert.All(seeds, s => Assert.Equal(
            new[] { "KeyPrefix", "Result", "Service" },
            s.Dimensions.Keys.Order().ToArray()));

        var expected =
            from prefix in new[]
            {
                "orders:products:v1",
                "orders:cart:v1",
                "orders:my-orders:v1",
                "orders:order:v1",
                "identity:sub-to-user:v1",
            }
            from result in new[] { "hit", "miss", "bypass" }
            select $"orders|{prefix}|{result}";
        var actual = seeds.Select(s =>
            $"{s.Dimensions["Service"]}|{s.Dimensions["KeyPrefix"]}|{s.Dimensions["Result"]}");
        Assert.Equal(expected.Order(), actual.Order());
    }

    [Fact]
    public async Task Tick_DoesNotSeedCacheOperationDuration()
    {
        var published = await RunOneTickAsync(nameof(Tick_DoesNotSeedCacheOperationDuration));

        Assert.DoesNotContain(published, p => p.Name == "cache_operation_duration_ms");
    }

    [Fact]
    public void ReadPrefixes_CoversThePrefixOfEveryReadKeyBuilder()
    {
        var readKeys = new[]
        {
            CacheKeys.Products,
            CacheKeys.Cart("sub", "usr_1"),
            CacheKeys.MyOrders("sub", "usr_1", includeTracking: true),
            CacheKeys.Order("sub", "usr_1", "ord_1", includeTracking: false),
            CacheKeys.Identity("sub"),
        };

        Assert.Equal(
            readKeys.Select(CacheKeys.PrefixOf).Order(),
            CacheKeys.ReadPrefixes.Order());
    }
}
