using Microsoft.EntityFrameworkCore;
using Orders.Domain.Entities;
using Orders.Infrastructure.Orders;
using Orders.Infrastructure.Persistence;
using Testcontainers.MySql;
using Xunit;

namespace Orders.Tests.Infrastructure;

// Proves the product catalog read side: GetProductsAsync maps active products to
// ProductDto and relies on the global query filter (ProductConfiguration:
// HasQueryFilter(p => p.DeletedAt == null)) to hide soft-deleted rows — no manual
// filter in ProductReadService itself.
public class ProductReadServiceTests : IAsyncLifetime
{
    private readonly MySqlContainer _mysql =
        new MySqlBuilder("mysql:8.0").WithDatabase("orders").Build();

    public Task InitializeAsync() => _mysql.StartAsync();
    public Task DisposeAsync() => _mysql.DisposeAsync().AsTask();

    private OrdersReadDbContext ReadCtx()
    {
        var cs = _mysql.GetConnectionString();
        return new OrdersReadDbContext(new DbContextOptionsBuilder<OrdersReadDbContext>()
            .UseMySql(cs, ServerVersion.AutoDetect(cs)).Options);
    }

    private OrdersWriteDbContext WriteCtx()
    {
        var cs = _mysql.GetConnectionString();
        return new OrdersWriteDbContext(new DbContextOptionsBuilder<OrdersWriteDbContext>()
            .UseMySql(cs, ServerVersion.AutoDetect(cs)).Options);
    }

    [Fact]
    public async Task GetProductsAsync_returns_only_active_products_mapped_to_dto()
    {
        var now = DateTime.UtcNow;

        await using (var w = WriteCtx())
        {
            await w.Database.MigrateAsync();

            w.Products.Add(new Product
            {
                Id = "prd_active1",
                Name = "Widget",
                Description = "An active widget",
                UnitPriceCents = 1999,
                UnitsInStock = 42,
                CreatedAt = now,
                UpdatedAt = now,
            });

            // Soft-deleted product: DeletedAt set directly on the entity before
            // SaveChanges, so it is persisted as already-deleted (no interceptor
            // rewrite needed — this is a plain INSERT with deleted_at populated).
            w.Products.Add(new Product
            {
                Id = "prd_deleted1",
                Name = "Gadget",
                Description = "A soft-deleted gadget",
                UnitPriceCents = 999,
                UnitsInStock = 5,
                CreatedAt = now,
                UpdatedAt = now,
                DeletedAt = now,
            });

            await w.SaveChangesAsync();
        }

        await using var r = ReadCtx();
        var svc = new ProductReadService(r);

        var products = await svc.GetProductsAsync();

        var active = Assert.Single(products, p => p.Id == "prd_active1");
        Assert.Equal("Widget", active.Name);
        Assert.Equal("An active widget", active.Description);
        Assert.Equal(1999, active.UnitPriceCents);
        Assert.Equal(42u, active.UnitsInStock);

        // Global query filter (ProductConfiguration.HasQueryFilter) must hide the
        // soft-deleted product from the read service — no manual filter needed.
        Assert.DoesNotContain(products, p => p.Id == "prd_deleted1");
    }
}
