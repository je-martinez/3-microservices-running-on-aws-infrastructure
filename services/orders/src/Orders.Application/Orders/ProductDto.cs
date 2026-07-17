namespace Orders.Application.Orders;

// Pure read DTO for the product catalog. Money in integer cents (service
// convention). No audit/soft-delete fields.
public record ProductDto(
    string Id,
    string Name,
    string Description,
    long UnitPriceCents,
    uint UnitsInStock);
