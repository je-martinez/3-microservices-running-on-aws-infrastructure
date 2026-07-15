using Microsoft.EntityFrameworkCore;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;

namespace Orders.Infrastructure.Persistence;

// Seeds a fixed catalog when empty. Prices are in integer cents.
public static class ProductSeed
{
    public static async Task ApplyAsync(OrdersWriteDbContext db)
    {
        if (await db.Products.AnyAsync()) return;

        var now = DateTime.UtcNow;
        db.Products.AddRange(
            new Product { Id = NanoId.NewId(NanoId.ProductPrefix), Name = "Widget", Description = "A basic widget", UnitPriceCents = 1999, UnitsInStock = 100, CreatedBy = "system", CreatedAt = now, UpdatedAt = now },
            new Product { Id = NanoId.NewId(NanoId.ProductPrefix), Name = "Gadget", Description = "A fancy gadget", UnitPriceCents = 4950, UnitsInStock = 50, CreatedBy = "system", CreatedAt = now, UpdatedAt = now },
            new Product { Id = NanoId.NewId(NanoId.ProductPrefix), Name = "Gizmo", Description = "A premium gizmo", UnitPriceCents = 12500, UnitsInStock = 25, CreatedBy = "system", CreatedAt = now, UpdatedAt = now }
        );
        await db.SaveChangesAsync();
    }
}
