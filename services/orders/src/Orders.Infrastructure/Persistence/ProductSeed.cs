using Microsoft.EntityFrameworkCore;
using Orders.Application.Abstractions;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;

namespace Orders.Infrastructure.Persistence;

// Seeds a fixed catalog when empty. Prices are in integer cents.
public static class ProductSeed
{
    public static Task ApplyAsync(OrdersWriteDbContext db) =>
        // Stamp CreatedBy/UpdatedBy = orders_api:product_seed via the audit
        // interceptor (replaces the old bare "system" literal).
        AmbientActor.RunAsync(AuditActor.ProductSeed, () => RunAsync(db));

    private static async Task RunAsync(OrdersWriteDbContext db)
    {
        if (await db.Products.AnyAsync()) return;

        var now = DateTime.UtcNow;
        db.Products.AddRange(
            new Product { Id = NanoId.NewId(NanoId.ProductPrefix), Name = "Widget", Description = "A basic widget", UnitPriceCents = 1999, UnitsInStock = 100, CreatedAt = now, UpdatedAt = now },
            new Product { Id = NanoId.NewId(NanoId.ProductPrefix), Name = "Gadget", Description = "A fancy gadget", UnitPriceCents = 4950, UnitsInStock = 50, CreatedAt = now, UpdatedAt = now },
            new Product { Id = NanoId.NewId(NanoId.ProductPrefix), Name = "Gizmo", Description = "A premium gizmo", UnitPriceCents = 12500, UnitsInStock = 25, CreatedAt = now, UpdatedAt = now }
        );
        await db.SaveChangesAsync();
    }
}
