using System.Diagnostics;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Orders.Api.BackgroundServices;
using Orders.Application.Abstractions;
using Orders.Domain.Entities;
using Orders.Infrastructure.Observability;
using Orders.Infrastructure.Persistence;

namespace Orders.Tests.Observability;

/// <summary>
/// CONTRACT: Assert the tick's work runs INSIDE the span, not merely that a span named
/// metrics-tick exists — a span wrapping an empty body satisfies the latter while every
/// EF Core and PutMetricData span still roots its own trace and buries real requests.
/// The recording publisher and <see cref="SpanScopedLogger{T}"/> capture
/// <c>Activity.Current</c> when called, which is the only way to tell a child of the tick
/// span from a sibling beside it. See [[ADR-0019-distributed-tracing-opentelemetry]]
/// </summary>
public class OrdersMetricsPublisherTracingTests
{
    private sealed record Publication(
        string Name, double Value, string Dimensions, Activity? Activity);

    private sealed class RecordingMetricsPublisher : IMetricsPublisher
    {
        public List<Publication> Published { get; } = new();

        public Task PublishAsync(
            string name,
            double value,
            IReadOnlyDictionary<string, string> dimensions,
            CancellationToken cancellationToken = default)
        {
            Published.Add(new Publication(
                name,
                value,
                string.Join(",", dimensions.OrderBy(d => d.Key).Select(d => $"{d.Key}={d.Value}")),
                Activity.Current));
            return Task.CompletedTask;
        }
    }

    private sealed class ThrowingMetricsPublisher : IMetricsPublisher
    {
        public Task PublishAsync(
            string name,
            double value,
            IReadOnlyDictionary<string, string> dimensions,
            CancellationToken cancellationToken = default) =>
            throw new InvalidOperationException("cloudwatch is down");
    }

    // The tick opens its own DI scope per iteration (OrdersReadDbContext is scoped
    // while the hosted service is a singleton), so the test has to hand it a real
    // IServiceScopeFactory rather than a context instance. InMemory is enough here:
    // these tests assert span PARENTAGE, not SQL.
    private static ServiceProvider BuildProvider(string dbName, int orderCount)
    {
        var services = new ServiceCollection();
        services.AddDbContext<OrdersReadDbContext>(o => o.UseInMemoryDatabase(dbName));
        var provider = services.BuildServiceProvider();

        using var scope = provider.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<OrdersReadDbContext>();
        for (var i = 0; i < orderCount; i++)
        {
            db.Orders.Add(new Order
            {
                Id = $"ord_tick{i}",
                UserId = "usr_t",
                CognitoSub = "sub-t",
                CreatedAt = DateTime.UtcNow,
                UpdatedAt = DateTime.UtcNow,
            });
        }
        db.SaveChanges();

        return provider;
    }

    // WHY: A real Pomelo context aimed at a closed port, so the failure is the one
    // production sees — CountAsync throwing on connect — not a stubbed exception.
    private static ServiceProvider BuildUnreachableDbProvider()
    {
        var services = new ServiceCollection();
        services.AddDbContext<OrdersReadDbContext>(o => o.UseMySql(
            "Server=127.0.0.1;Port=1;Database=orders;User=orders;Password=x;Connection Timeout=2",
            new MySqlServerVersion(new Version(8, 0, 36))));
        return services.BuildServiceProvider();
    }

    private static IConfiguration EmptyConfig() =>
        new ConfigurationBuilder().AddInMemoryCollection().Build();

    private static ActivityListener ListenerFor(List<Activity> recorded) =>
        new()
        {
            // Scoped to the workflow source, the same constant Program.cs must pass
            // to AddSource(...). Without a listener StartActivity returns null and
            // nothing is recorded at all — the silent failure WorkflowTracerTests
            // documents.
            ShouldListenTo = source => source.Name == WorkflowTracer.ActivitySourceName,
            Sample = (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllData,
            ActivityStopped = recorded.Add,
        };

    [Fact]
    public async Task Tick_RunsItsWorkInsideAMetricsTickSpan()
    {
        var recorded = new List<Activity>();
        using var listener = ListenerFor(recorded);
        ActivitySource.AddActivityListener(listener);

        using var provider = BuildProvider(nameof(Tick_RunsItsWorkInsideAMetricsTickSpan), orderCount: 3);
        var metrics = new RecordingMetricsPublisher();
        var logger = new SpanScopedLogger<OrdersMetricsPublisher>();

        var publisher = new OrdersMetricsPublisher(
            provider.GetRequiredService<IServiceScopeFactory>(),
            metrics,
            new WorkflowTracer(),
            logger,
            EmptyConfig());

        await publisher.CollectAndPublishAsync(CancellationToken.None);

        var span = Assert.Single(recorded);
        Assert.Equal("metrics-tick", span.DisplayName);
        // WHY: INTERNAL, not CONSUMER — this is our own timer and consumes nothing.
        Assert.Equal(ActivityKind.Internal, span.Kind);
        Assert.Equal(ActivityStatusCode.Ok, span.Status);
        // CONTRACT: Stopped, not merely started — a running activity is never exported.
        Assert.NotEqual(default, span.Duration);
        Assert.Null(Activity.Current);

        // CONTRACT: Every publication must happen while the tick span is current, so the
        // PutMetricData spans hang off it instead of rooting their own trace. A sibling shows
        // a different (or null) ambient activity here even though the span above exists.
        Assert.NotEmpty(metrics.Published);
        Assert.All(metrics.Published, p => Assert.Same(span, p.Activity));

        // The count came from the DB read, which therefore also ran inside the span.
        var total = Assert.Single(metrics.Published, p => p.Name == "orders_total");
        Assert.Equal(3, total.Value);

        // Both error-counter seeds go out too, and they are what a "no errors" panel
        // renders instead of "Error Loading Data".
        Assert.Equal(2, metrics.Published.Count(p => p.Name == "http_errors_total"));

        // One success line, emitted from INSIDE the span so it carries the span's own
        // id — the failure line in ExecuteAsync is outside it by design, so this is
        // the only line a span-scoped log lookup can return. It states what was
        // published, not merely that the tick ran.
        var entry = Assert.Single(logger.Entries);
        Assert.Equal(LogLevel.Information, entry.Level);
        Assert.Same(span, entry.Activity);
        Assert.Equal("metrics_tick_succeeded", entry.Values["app_event"]);
        Assert.Equal(3, entry.Values["orders_total"]);
        // TagObjects, not Tags: Activity.Tags only surfaces string values, and the
        // count is set as an int (OTel's numeric attribute type).
        Assert.Contains(span.TagObjects, t => t.Key == "orders_total" && (int?)t.Value == 3);
    }

    [Fact]
    public async Task Tick_PublishesEverySeedAtZero_WhenTheDbReadFails()
    {
        var recorded = new List<Activity>();
        using var listener = ListenerFor(recorded);
        ActivitySource.AddActivityListener(listener);

        // CONTRACT: The expected seeds come from a healthy tick, not a hard-coded list, so
        // a seed added to the tick later is covered here without editing this test.
        using var healthyProvider = BuildProvider(
            nameof(Tick_PublishesEverySeedAtZero_WhenTheDbReadFails), orderCount: 1);
        var healthy = new RecordingMetricsPublisher();
        await new OrdersMetricsPublisher(
            healthyProvider.GetRequiredService<IServiceScopeFactory>(),
            healthy,
            new WorkflowTracer(),
            new SpanScopedLogger<OrdersMetricsPublisher>(),
            EmptyConfig()).CollectAndPublishAsync(CancellationToken.None);
        var expectedSeeds = healthy.Published
            .Where(p => p.Name != "orders_total")
            .Select(p => (p.Name, p.Dimensions))
            .ToHashSet();
        Assert.NotEmpty(expectedSeeds);
        recorded.Clear();

        using var failingProvider = BuildUnreachableDbProvider();
        var metrics = new RecordingMetricsPublisher();
        var logger = new SpanScopedLogger<OrdersMetricsPublisher>();
        var publisher = new OrdersMetricsPublisher(
            failingProvider.GetRequiredService<IServiceScopeFactory>(),
            metrics,
            new WorkflowTracer(),
            logger,
            EmptyConfig());

        // The read failure still reaches the caller, so ExecuteAsync logs it and the span
        // comes out ERROR exactly as for any other failed tick.
        var thrown = await Assert.ThrowsAnyAsync<Exception>(
            () => publisher.CollectAndPublishAsync(CancellationToken.None));
        var span = Assert.Single(recorded);
        Assert.Equal(ActivityStatusCode.Error, span.Status);
        Assert.Equal(thrown.Message, span.StatusDescription);
        Assert.Empty(logger.Entries);

        Assert.DoesNotContain(metrics.Published, p => p.Name == "orders_total");
        Assert.All(metrics.Published, p => Assert.Equal(0, p.Value));
        Assert.Equal(
            expectedSeeds,
            metrics.Published.Select(p => (p.Name, p.Dimensions)).ToHashSet());
    }

    [Fact]
    public async Task Tick_SpanComesOutError_WhenPublishingThrows()
    {
        var recorded = new List<Activity>();
        using var listener = ListenerFor(recorded);
        ActivitySource.AddActivityListener(listener);

        using var provider = BuildProvider(nameof(Tick_SpanComesOutError_WhenPublishingThrows), orderCount: 1);

        var publisher = new OrdersMetricsPublisher(
            provider.GetRequiredService<IServiceScopeFactory>(),
            new ThrowingMetricsPublisher(),
            new WorkflowTracer(),
            new SpanScopedLogger<OrdersMetricsPublisher>(),
            EmptyConfig());

        // The throw must reach the CALLER: ExecuteAsync's try/catch is what swallows
        // it (one bad tick may not kill the loop), and it sits OUTSIDE the span
        // precisely so the span sees the failure first. Catching inside the span
        // would leave every failed tick recorded as OK.
        await Assert.ThrowsAsync<InvalidOperationException>(
            () => publisher.CollectAndPublishAsync(CancellationToken.None));

        var span = Assert.Single(recorded);
        Assert.Equal("metrics-tick", span.DisplayName);
        Assert.Equal(ActivityStatusCode.Error, span.Status);
        Assert.Equal("cloudwatch is down", span.StatusDescription);
        Assert.NotEqual(default, span.Duration);
    }
}
