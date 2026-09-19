namespace Orders.Application.Messaging;

/// <summary>
/// Command behind <c>POST /v1/orders/{orderId}/cache-invalidation</c>: forget the cached order
/// responses for one order.
/// </summary>
public record InvalidateOrderCache(string OrderId) : IFlowMessage
{
    public string Flow => "internal_invalidate_order_cache";

    /// <summary>
    /// A write: the full triad. The sweep is an intermediate step at which <c>_started</c>
    /// can be the last line seen. See [[logging-context]]
    /// </summary>
    public bool EmitsStarted => true;
}

/// <summary>
/// Whether the sweep ran, and the owner it ran for.
/// </summary>
/// <remarks>
/// CONTRACT: <c>order_not_found</c> arrives HERE, as a returned reason, not as a thrown
/// exception — an order id naming no owner is a normal answer the route maps to 404, and the
/// span must stay OK for it. See [[logging-context]]
/// </remarks>
public record InvalidateOrderCacheResult(
    bool Invalidated,
    string? CognitoSub,
    string? UserId,
    string? FailureReason) : IRoutineFailure
{
    public static InvalidateOrderCacheResult NotFound() =>
        new(false, null, null, "order_not_found");

    public static InvalidateOrderCacheResult Swept(string cognitoSub, string userId) =>
        new(true, cognitoSub, userId, null);
}
