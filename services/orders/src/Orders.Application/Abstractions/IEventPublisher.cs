namespace Orders.Application.Abstractions;

public interface IEventPublisher
{
    /// <summary>
    /// Emits <c>ORDER_CREATED</c> for a freshly persisted order.
    /// CONTRACT: <paramref name="email"/> is required by ORDER_CREATED — absence is PermanentError.
    /// WARNING: <paramref name="email"/> and <paramref name="fullName"/> are PII; never log plaintext.
    /// CONTRACT: Nullable <paramref name="cognitoSub"/> and <paramref name="shippingAddress"/> are OMITTED, not null.
    /// WHY: <paramref name="items"/> carries product names — OrderDetail stores ids; the pipeline has no Orders DB.
    /// CONTRACT: Do NOT add eventId — the publisher mints the idempotency key.
    /// CONTRACT: <paramref name="orderNumber"/> is the CANONICAL form; the consumer formats
    /// nothing and the publisher sends both forms. Null only for an order predating the
    /// backfill, and OMITTED rather than sent as null. See [[friendly-order-number]]
    /// See [[events-pipeline-design]]
    /// </summary>
    Task PublishOrderCreatedAsync(
        string orderId,
        string? orderNumber,
        string userId,
        string email,
        string fullName,
        long subtotalCents,
        long taxCents,
        long shippingCents,
        long totalCents,
        string? shippingAddress,
        IReadOnlyList<OrderCreatedItem> items,
        DateTime createdAt,
        string? cognitoSub = null,
        CancellationToken ct = default);
}
