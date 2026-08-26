using Orders.Domain;

namespace Orders.Application.Orders;

// Pure read DTO for the product catalog. Money is reported in cents AND dollars
// via Money, so no client divides by 100. No audit/soft-delete fields.
public record ProductDto(
    string Id,
    string Name,
    string Description,
    Money UnitPrice,
    uint UnitsInStock,
    IReadOnlyList<string> Categories,
    ProductImageDto? Image);
