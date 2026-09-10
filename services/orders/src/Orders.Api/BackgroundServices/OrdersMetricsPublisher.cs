using Microsoft.EntityFrameworkCore;
using Orders.Application.Abstractions;
using Orders.Infrastructure.Observability;
using Orders.Infrastructure.Persistence;

namespace Orders.Api.BackgroundServices;

/// <summary>
/// Periodically publishes <c>orders_total</c>, the count of live orders. A gauge, not a
/// counter: its difference against Tracking's DELIVERED + IN_PROGRESS counts is exactly the
/// set of orders whose init-tracking call failed, and is zero in normal operation.
/// </summary>
public class OrdersMetricsPublisher : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly IMetricsPublisher _metrics;
    private readonly IWorkflowTracer _tracer;
    private readonly ILogger<OrdersMetricsPublisher> _logger;
    private readonly TimeSpan _interval;

    public OrdersMetricsPublisher(
        IServiceScopeFactory scopeFactory,
        IMetricsPublisher metrics,
        IWorkflowTracer tracer,
        ILogger<OrdersMetricsPublisher> logger,
        IConfiguration configuration)
    {
        _scopeFactory = scopeFactory;
        _metrics = metrics;
        _tracer = tracer;
        _logger = logger;
        // The 15s default is only the fallback: real AWS and the local stack both
        // run at 60s via METRICS_INTERVAL_MS. Defaulted so no env file breaks by
        // omitting it.
        _interval = TimeSpan.FromMilliseconds(
            configuration.GetValue<int?>("METRICS_INTERVAL_MS") ?? 15_000);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(_interval);
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                await CollectAndPublishAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;   // normal shutdown
            }
            catch (Exception ex)
            {
                // CONTRACT: Swallow and keep ticking — one bad tick must not kill the loop.
                // Keep this catch OUTSIDE the span: the span must SEE the throw to come out
                // ERROR, so this line does not carry its span id, and the span's recorded
                // exception tells the same story. See [[logging-context]]
                _logger.LogWarning(
                    ex, "{app_event} reason={reason}", "metrics_collection_failed", ex.Message);
            }
        }
    }

    /// <summary>
    /// One tick, wrapped in its own <c>metrics-tick</c> span. Public so a test can
    /// drive it without waiting on the timer.
    /// </summary>
    /// <remarks>
    /// CONTRACT: Keep the wrapper span. The tick runs on a PeriodicTimer with no ambient
    /// request span, so without it each tick's EF Core and CloudWatch spans arrive as their
    /// OWN root traces and bury the traces of real requests. INTERNAL, not CONSUMER — this
    /// timer consumes nothing. The caller's try/catch stays outside so the span sees the
    /// throw. See [[ADR-0019-distributed-tracing-opentelemetry]]
    /// </remarks>
    public async Task CollectAndPublishAsync(CancellationToken stoppingToken) =>
        await _tracer.TraceWorkflowAsync(
            "metrics-tick",
            new Dictionary<string, object?> { ["app_event"] = "metrics_tick_started" },
            async () =>
            {
                // OrdersReadDbContext is registered SCOPED, so a singleton hosted
                // service must open its own scope per tick.
                using var scope = _scopeFactory.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<OrdersReadDbContext>();

                // The global query filter (o => o.DeletedAt == null) applies
                // automatically — no Where() needed, and never filter on IsDeleted,
                // which is a computed property EF cannot translate.
                var total = await db.Orders.AsNoTracking().CountAsync(stoppingToken);

                await _metrics.PublishAsync(
                    "orders_total",
                    total,
                    new Dictionary<string, string> { ["Service"] = "orders" },
                    stoppingToken);

                // CONTRACT: Seed the failure counters at zero. http_errors_total is emitted
                // from the error path only, so until something fails the series does not
                // exist and its panel renders "Error Loading Data" — a healthy system reads
                // as broken. The zero is free: CloudWatch sums within a period.
                foreach (var statusClass in new[] { "4xx", "5xx" })
                {
                    await _metrics.PublishAsync(
                        "http_errors_total",
                        0,
                        new Dictionary<string, string>
                        {
                            ["Service"] = "orders",
                            ["StatusClass"] = statusClass,
                        },
                        stoppingToken);
                }

                // Logged from INSIDE the span, deliberately: the failure line in
                // ExecuteAsync is outside it (see above), so this success line is the
                // only one that carries the tick span's own id and makes a span-scoped
                // log lookup return anything. It also states WHAT went out — "the tick
                // ran" alone would not distinguish a healthy publish from one that
                // shipped a zero because the count silently matched nothing.
                _tracer.SetAttribute("app_event", "metrics_tick_succeeded");
                _tracer.SetAttribute("orders_total", total);
                _logger.LogInformation(
                    "{app_event} orders_total={orders_total}", "metrics_tick_succeeded", total);

                // TraceWorkflowAsync has no void overload; the tick has no result to
                // report, so it returns a discarded placeholder.
                return true;
            });
}
