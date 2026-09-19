using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Orders.Application.Messaging;
using Orders.Infrastructure.Caching;
using Orders.Infrastructure.Observability;
using Orders.Infrastructure.Persistence;

namespace Orders.Infrastructure.Orders;

/// <summary>
/// Forgets the cached order responses for one order, for
/// <c>POST /v1/orders/{orderId}/cache-invalidation</c>.
/// </summary>
/// <remarks>
/// CONTRACT: Takes an order id and nothing else — never a cache key and never a wildcard.
/// The owner is resolved here, from the order row. See [[x-cache-response-header]]
/// </remarks>
public class InvalidateOrderCacheService
{
    private readonly OrdersReadDbContext _db;
    private readonly IWorkflowTracer _tracer;
    private readonly ICacheInvalidator _cache;
    private readonly ILogger<InvalidateOrderCacheService> _logger;

    public InvalidateOrderCacheService(
        OrdersReadDbContext db,
        IWorkflowTracer tracer,
        // The INTERFACE, never ICacheGateway: with CACHE_ENABLED=false no gateway is
        // registered at all, and resolving one directly would make the kill switch take
        // this route down. NoopCacheInvalidator satisfies this in that branch.
        ICacheInvalidator cache,
        ILogger<InvalidateOrderCacheService> logger)
    {
        _db = db;
        _tracer = tracer;
        _cache = cache;
        _logger = logger;
    }

    /// <summary>
    /// Sweeps the owner's cached order responses, with no instrumentation of its own.
    /// </summary>
    /// <remarks>
    /// CONTRACT: Emit nothing here — the bus pipeline owns this flow's span and both its log
    /// lines for callers arriving through <c>InvalidateOrderCache</c>. The "not found" answer
    /// leaves by RETURN, never by throwing: it is what the route maps to 404, and a throw
    /// would mark the span ERROR for a normal outcome. See [[logging-context]]
    /// </remarks>
    public async Task<InvalidateOrderCacheResult> SweepAsync(
        string orderId, CancellationToken ct = default)
    {
        var owner = await OwnerOfAsync(orderId, ct);
        if (owner is null)
        {
            return InvalidateOrderCacheResult.NotFound();
        }

        // FAIL-OPEN, like every other invalidation site: a Redis fault leaves the entries to
        // expire by TTL and must not turn this into a 500 the caller retries forever.
        await _cache.InvalidateOrderTrackingAsync(owner.CognitoSub, owner.UserId, ct);

        return InvalidateOrderCacheResult.Swept(owner.CognitoSub, owner.UserId);
    }

    /// <summary>
    /// Sweeps the owner's cached order responses. Returns false when no order carries
    /// <paramref name="orderId"/>, which the API maps to 404.
    /// </summary>
    public Task<bool> InvalidateAsync(string orderId, CancellationToken ct = default) =>
        _tracer.TraceWorkflowAsync(
            "internal_invalidate_order_cache",
            new Dictionary<string, object?>
            {
                ["app_event"] = "internal_invalidate_order_cache_started",
                ["order_id"] = orderId,
            },
            async () =>
            {
                var owner = await OwnerOfAsync(orderId, ct);

                if (owner is null)
                {
                    // An order this service cannot resolve names no owner, so there is no key
                    // set to sweep. A 200 here would let the caller record a success for an
                    // invalidation that did not happen.
                    _logger.LogWarning(
                        "Order cache invalidation rejected {app_event} {reason} {order_id}",
                        "internal_invalidate_order_cache_failed", "order_not_found", orderId);
                    _tracer.SetReason("order_not_found");
                    return false;
                }

                // FAIL-OPEN, like every other invalidation site: a Redis fault leaves the
                // entries to expire by TTL and must not turn this into a 500 the caller
                // retries forever.
                await _cache.InvalidateOrderTrackingAsync(owner.CognitoSub, owner.UserId, ct);

                // WHY: Log the subjects explicitly — the enricher carries no end-user
                // identity on a route with no end-user caller.
                _logger.LogInformation(
                    "Invalidated order cache {app_event} {order_id} {cognito_sub} {user_id}",
                    "internal_invalidate_order_cache_succeeded",
                    orderId,
                    owner.CognitoSub,
                    owner.UserId);

                return true;
            });

    /// <summary>The order's owner, or null when no row carries that id.</summary>
    /// <remarks>
    /// CONTRACT: Resolve the owner from the ORDER ROW, never from the request. An owner the
    /// caller supplied could be wrong, sweeping a stranger's keys and leaving the stale entry
    /// in place.
    /// CONTRACT: Keep <c>IgnoreQueryFilters</c>. A soft-deleted order's cached entries outlive
    /// its row by their full TTL, so the global filter would 404 exactly the order someone just
    /// watched disappear. See [[soft-delete]]
    /// </remarks>
    private Task<OrderOwner?> OwnerOfAsync(string orderId, CancellationToken ct) =>
        _db.Orders
            .IgnoreQueryFilters()
            .AsNoTracking()
            .Where(o => o.Id == orderId)
            .Select(o => new OrderOwner(o.CognitoSub, o.UserId))
            .FirstOrDefaultAsync(ct);

    private sealed record OrderOwner(string CognitoSub, string UserId);
}
