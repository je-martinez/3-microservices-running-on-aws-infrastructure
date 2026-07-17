namespace Orders.Application.Orders;

public record OrderLineDto(string ProductId, uint Quantity, long SubtotalCents, long TaxCents, long TotalCents);

public record OrderDto(
    string Id,
    string UserId,
    string CognitoSub,
    long SubtotalCents,
    long TaxCents,
    long TotalCents,
    DateTime CreatedAt,
    IReadOnlyList<OrderLineDto> Lines);
