using Orders.Application.Abstractions;

namespace Orders.Infrastructure.Messaging;

// ORDER_CREATED emission seam. SQS wiring is deferred (mirrors Users' NoopEventPublisher).
public class NoopEventPublisher : IEventPublisher
{
    public Task PublishOrderCreatedAsync(string orderId, string userId, long totalCents, DateTime createdAt, CancellationToken ct = default)
        => Task.CompletedTask;
}
