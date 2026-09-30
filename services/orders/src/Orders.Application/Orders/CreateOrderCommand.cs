namespace Orders.Application.Orders;

public record CreateOrderLine(string ProductId, uint Quantity);

/// <param name="Lines">The requested lines, possibly repeating a product.</param>
/// <param name="PaymentMethodId">The saved <c>pm_</c> to charge; read only when Stripe is enabled.</param>
/// <param name="IdempotencyKey">The client's Idempotency-Key; read only when Stripe is enabled.</param>
public record CreateOrderCommand(
    IReadOnlyList<CreateOrderLine> Lines,
    string? PaymentMethodId = null,
    string? IdempotencyKey = null);
