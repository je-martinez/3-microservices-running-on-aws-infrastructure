namespace Orders.Application.Abstractions;

public interface IEventPublisher
{
    Task PublishOrderCreatedAsync(string orderId, string userId, long totalCents, DateTime createdAt, CancellationToken ct = default);
}
