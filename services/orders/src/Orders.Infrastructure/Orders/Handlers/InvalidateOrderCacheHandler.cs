using Orders.Application.Messaging;
using Orders.Infrastructure.Bus;
using Wolverine.Attributes;

namespace Orders.Infrastructure.Orders.Handlers;

/// <summary>Handler for <see cref="InvalidateOrderCache"/>.</summary>
/// <remarks>
/// CONTRACT: <c>[NonTransactional]</c>, even though the route is a POST — this flow only READS
/// the owner and then sweeps Redis. Letting the automatic policy own a transaction here would
/// open one around a cache sweep no database write is part of. See [[cqrs]]
/// </remarks>
[NonTransactional]
public class InvalidateOrderCacheHandler
{
    private readonly InvalidateOrderCacheService _invalidations;

    public InvalidateOrderCacheHandler(InvalidateOrderCacheService invalidations) =>
        _invalidations = invalidations;

    /// <summary>
    /// CONTRACT: "No such order" is reported as a ROUTINE failure, never thrown. That is what
    /// logs <c>internal_invalidate_order_cache_failed</c> + <c>order_not_found</c> while
    /// leaving the span OK — an id naming no owner is a normal answer the route maps to 404.
    /// See [[logging-context]]
    /// </summary>
    public async Task<InvalidateOrderCacheResult> Handle(
        InvalidateOrderCache command, FlowScope scope, CancellationToken ct)
    {
        var result = await _invalidations.SweepAsync(command.OrderId, ct);

        if (result.FailureReason is not null)
        {
            scope.RoutineFailure(result.FailureReason);
        }
        else
        {
            scope.Succeeded();
        }

        return result;
    }
}
