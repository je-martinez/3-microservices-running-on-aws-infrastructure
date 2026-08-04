using Microsoft.EntityFrameworkCore;
using Orders.Application.Abstractions;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;

namespace Orders.Infrastructure.Persistence;

// Seeds a fixed catalog when empty. Prices are in integer cents.
public static class ProductSeed
{
    /// <summary>
    /// The catalogue's starting stock, by product name — the single source of truth for
    /// "how many units should exist in a fresh database".
    /// </summary>
    /// <remarks>
    /// Exposed because the E2E cleanup restores stock to these values after a run
    /// (orders decrement stock permanently, and <see cref="RunAsync"/> below only plants
    /// rows when the table is empty, so nothing else ever replenishes them). Keeping the
    /// quantities here means the seed and the restore cannot drift apart.
    /// </remarks>
    public static readonly IReadOnlyList<(string Name, uint Units)> SeedStock =
    [
        ("Widget", 100u),
        ("Gadget", 50u),
        ("Gizmo", 25u),
    ];


    public static Task ApplyAsync(OrdersWriteDbContext db) =>
        // Stamp CreatedBy/UpdatedBy = orders_api:product_seed via the audit
        // interceptor (replaces the old bare "system" literal).
        AmbientActor.RunAsync(AuditActor.ProductSeed, () => RunAsync(db));

    private static async Task RunAsync(OrdersWriteDbContext db)
    {
        if (await db.Products.AnyAsync()) return;

        var now = DateTime.UtcNow;
        // Quantities come from SeedStock so the seed and the E2E restock cannot drift.
        db.Products.AddRange(
            new Product { Id = NanoId.NewId(NanoId.ProductPrefix), Name = "Widget", Description = "A basic widget", UnitPriceCents = 1999, UnitsInStock = StockFor("Widget"), CreatedAt = now, UpdatedAt = now },
            new Product { Id = NanoId.NewId(NanoId.ProductPrefix), Name = "Gadget", Description = "A fancy gadget", UnitPriceCents = 4950, UnitsInStock = StockFor("Gadget"), CreatedAt = now, UpdatedAt = now },
            new Product { Id = NanoId.NewId(NanoId.ProductPrefix), Name = "Gizmo", Description = "A premium gizmo", UnitPriceCents = 12500, UnitsInStock = StockFor("Gizmo"), CreatedAt = now, UpdatedAt = now }
        );
        await db.SaveChangesAsync();
    }

    private static uint StockFor(string name) =>
        SeedStock.First(s => s.Name == name).Units;
}
