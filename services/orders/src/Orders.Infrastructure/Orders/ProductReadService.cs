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
    private readonly string _assetsBaseUrl;

    /// <param name="assetsBaseUrl">
    /// Public base URL of the assets bucket (ASSETS_BASE_URL). Rows store a bucket key
    /// relative to this, so the absolute URL is composed here rather than persisted —
    /// the bucket name is re-minted on every local apply, and in production this becomes
    /// the CloudFront domain with no data migration. A trailing slash is tolerated.
    /// </param>
    public ProductReadService(OrdersReadDbContext db, string assetsBaseUrl)
    {
        _db = db;
        _assetsBaseUrl = assetsBaseUrl.TrimEnd('/');
    }

    public async Task<IReadOnlyList<ProductDto>> GetProductsAsync()
    {
        var products = await _db.Products.AsNoTracking().ToListAsync();
        return products.Select(Map).ToList();
    }

    private ProductDto Map(Domain.Entities.Product p) =>
        new(p.Id, p.Name, p.Description, p.UnitPriceCents, p.UnitsInStock,
            p.Categories,
            p.Image is null
                ? null
                : new ProductImageDto(
                    $"{_assetsBaseUrl}/{p.Image.Uri}",
                    p.Image.Width,
                    p.Image.Height,
                    p.Image.Blurhash));
}
