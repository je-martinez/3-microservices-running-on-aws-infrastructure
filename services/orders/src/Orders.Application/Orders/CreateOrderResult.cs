namespace Orders.Application.Orders;

/// <param name="Order">The order the request resolved to.</param>
/// <param name="Created">
/// False when the client's Idempotency-Key already had an order and this one was returned
/// instead — the endpoint answers 200 rather than 201.
/// </param>
public sealed record CreateOrderResult(OrderDto Order, bool Created);
