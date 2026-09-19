using Orders.Application.Messaging;
using Orders.Infrastructure.Bus;
using Wolverine.Attributes;

namespace Orders.Infrastructure.Orders.Handlers;

/// <summary>Handler for <see cref="GetMyOrders"/>.</summary>
/// <remarks>
/// CONTRACT: <c>[NonTransactional]</c> — a read owns no unit of work, and this keeps the handler
/// off the automatic transactional policy, whose eager mode would open a transaction and call
/// <c>SaveChangesAsync</c> around a query with nothing to save. See [[cqrs]]
/// WHY: One <c>DbContext</c>-shaped dependency, the READ one, reached through
/// <see cref="OrderReadService"/>. A handler exposing both contexts fails at STARTUP.
/// </remarks>
[NonTransactional]
public class GetMyOrdersHandler
{
    private readonly OrderReadService _reads;

    public GetMyOrdersHandler(OrderReadService reads) => _reads = reads;

    /// <summary>
    /// CONTRACT: <paramref name="scope"/> comes from the pipeline's own <c>Before</c>, not from
    /// DI. Report the outcome on it — the count the flow log and span publish is read from here
    /// and nowhere else. See [[logging-context]]
    /// </summary>
    public async Task<GetMyOrdersResult> Handle(
        GetMyOrders query, FlowScope scope, CancellationToken ct)
    {
        var orders = await _reads.ListForCallerAsync(query.CallerSub, ct);

        scope.Succeeded("order_count", orders.Count);

        return new GetMyOrdersResult(orders);
    }
}
