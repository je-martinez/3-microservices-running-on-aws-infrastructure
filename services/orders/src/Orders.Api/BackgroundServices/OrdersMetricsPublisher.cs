using Microsoft.EntityFrameworkCore;
using Orders.Application.Abstractions;
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
    private readonly ILogger<OrdersMetricsPublisher> _logger;
    private readonly TimeSpan _interval;

    public OrdersMetricsPublisher(
        IServiceScopeFactory scopeFactory,
        IMetricsPublisher metrics,
        ILogger<OrdersMetricsPublisher> logger,
        IConfiguration configuration)
    {
        _scopeFactory = scopeFactory;
        _metrics = metrics;
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
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;   // normal shutdown
            }
            catch (Exception ex)
            {
                // Swallow and keep ticking: one bad tick must not kill the loop.
                _logger.LogWarning(
                    ex, "{app_event} reason={reason}", "metrics_collection_failed", ex.Message);
            }
        }
    }
}
