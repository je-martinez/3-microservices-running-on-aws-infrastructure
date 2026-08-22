using Microsoft.EntityFrameworkCore;
using Orders.Application.Abstractions;
using Orders.Infrastructure.Observability;
using Orders.Infrastructure.Persistence;

namespace Orders.Api.BackgroundServices;

/// <summary>
/// Periodically publishes <c>orders_total</c> — the true count of live orders.
///
/// A gauge, not a counter: it reports current state, and it is what makes the
/// Orders-to-Tracking gap visible. Tracking publishes DELIVERED + IN_PROGRESS
/// counts of orders that HAVE a tracking row; the difference against this number
/// is exactly the set of orders whose init-tracking call failed (see
/// TrackingInitResult's remarks). In normal operation the difference is zero.
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
        // 15s locally, 60s in real AWS. Defaulted so no env file breaks by omitting it.
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
                // Swallow and keep ticking: one bad tick must not kill the loop.
                //
                // Stays OUTSIDE the span on purpose (see CollectAndPublishAsync):
                // the span has to SEE the throw to come out ERROR, so by the time
                // this line runs the activity has already ended and the line does
                // not carry its span id. The span still tells the failure story on
                // its own — ERROR status plus the recorded exception carrying this
                // same message.
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
    /// The tick runs on a PeriodicTimer, so there is no ambient request span to hang
    /// off: without this wrapper each tick's EF Core and CloudWatch spans arrive at
    /// Jaeger as their OWN root traces (60 orphans were measured in an hour, rooted at
    /// <c>orders</c> and <c>CloudWatch.PutMetricData</c>), burying the traces of real
    /// requests and giving whoever opens one no way to tell which process produced it.
    ///
    /// INTERNAL, not CONSUMER — events-pipeline's identically-named <c>metrics-tick</c>
    /// is CONSUMER because EventBridge wakes it; this one is our own timer and consumes
    /// nothing. The name is shared across services on purpose so it means the same thing
    /// everywhere.
    ///
    /// The caller's try/catch stays outside this method so the span sees the throw.
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

                // Seed the failure counters at zero.
                //
                // http_errors_total is emitted from the error path only
                // (HttpErrorMetricsMiddleware), so until something fails the
                // series does not exist — and a panel over a non-existent
                // stream renders "Error Loading Data". That is backwards for an
                // incident card: the one that should read "no errors" is the
                // one that looks broken, which makes a real outage
                // indistinguishable from a healthy system.
                //
                // The zero is arithmetically free: CloudWatch sums within a
                // period, so it never alters a real count.
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
