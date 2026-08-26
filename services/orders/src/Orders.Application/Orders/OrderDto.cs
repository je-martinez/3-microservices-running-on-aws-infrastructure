using Orders.Domain;

namespace Orders.Application.Orders;

public record OrderLineDto(string ProductId, uint Quantity, Money Subtotal, Money Tax, Money Total);

public record OrderDto(
    string Id,
    string UserId,
    string CognitoSub,
    Money Subtotal,
    Money Tax,
    // Order-level, not per-line: charged once per shipment, which is why
    // OrderLineDto has no counterpart. Exposed so a client can show the same
    // breakdown the confirmation email prints — without it, Total is
    // unexplainable from the other figures a caller can see.
    Money Shipping,
    Money Total,
    DateTime CreatedAt,
    IReadOnlyList<OrderLineDto> Lines);
