using Microsoft.EntityFrameworkCore;
using Orders.Application.Orders;
using Orders.Infrastructure.Persistence;

namespace Orders.Infrastructure.Orders;

// Read-only product catalog. Lives in Infrastructure because it depends on
// OrdersReadDbContext (Application must not reference EF Core). Soft-deleted rows
// are excluded by the product global query filter (ProductConfiguration) — no
// manual filter here. No gRPC / caller on reads (products have no owner).
public class ProductReadService
{
    private readonly OrdersReadDbContext _db;
    public ProductReadService(OrdersReadDbContext db) => _db = db;

    public async Task<IReadOnlyList<ProductDto>> GetProductsAsync()
    {
        var products = await _db.Products.AsNoTracking().ToListAsync();
        return products.Select(Map).ToList();
    }

    private static ProductDto Map(Domain.Entities.Product p) =>
        new(p.Id, p.Name, p.Description, p.UnitPriceCents, p.UnitsInStock);
}
