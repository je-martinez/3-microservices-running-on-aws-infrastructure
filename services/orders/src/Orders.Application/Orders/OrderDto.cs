namespace Orders.Application.Orders;

public record OrderLineDto(string ProductId, uint Quantity, long SubtotalCents, long TaxCents, long TotalCents);

public record OrderDto(
    string Id,
    string UserId,
    string CognitoSub,
    long SubtotalCents,
    long TaxCents,
    // Order-level, not per-line: charged once per shipment, which is why
    // OrderLineDto has no counterpart. Exposed so a client can show the same
    // breakdown the confirmation email prints — without it, TotalCents is
    // unexplainable from the other figures a caller can see.
    long ShippingCents,
    long TotalCents,
    DateTime CreatedAt,
    IReadOnlyList<OrderLineDto> Lines);
