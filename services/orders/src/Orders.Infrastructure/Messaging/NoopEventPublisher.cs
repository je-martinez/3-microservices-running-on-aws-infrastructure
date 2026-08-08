using Orders.Application.Abstractions;

namespace Orders.Infrastructure.Messaging;

// Kept deliberately (it is NOT dead code, and NOT superseded by SqsEventPublisher):
// tests and any environment that must not emit register this instead of the real
// publisher, mirroring Users' NoopEventPublisher.
public class NoopEventPublisher : IEventPublisher
{
    public Task PublishOrderCreatedAsync(
        string orderId,
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
        CancellationToken ct = default)
        => Task.CompletedTask;
}
