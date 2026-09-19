using Orders.Application.Orders;

namespace Orders.Application.Messaging;

/// <summary>Query behind <c>GET /v1/orders/my-orders</c>: the caller's orders.</summary>
public record GetMyOrders(string CallerSub) : IFlowMessage
{
    public string Flow => "list_my_orders";

    /// <summary>
    /// A read: one <c>_succeeded</c> line, no <c>_started</c> twin.
    /// See [[logging-context]]
    /// </summary>
    public bool EmitsStarted => false;
}

/// <summary>The caller's orders.</summary>
/// <remarks>
/// CONTRACT: No <see cref="IRoutineFailure"/> — this read has no failure branch of its own, and
/// a DB fault throws, which the pipeline records as an ERROR span. Inventing a reason for a
/// branch the code does not have is what the convention forbids. See [[logging-context]]
/// </remarks>
public record GetMyOrdersResult(IReadOnlyList<OrderDto> Orders);
