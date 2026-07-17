namespace Orders.Application.Orders;

public record CreateOrderLine(string ProductId, uint Quantity);
public record CreateOrderCommand(IReadOnlyList<CreateOrderLine> Lines);
