using Microsoft.EntityFrameworkCore;
using Orders.Application.Abstractions;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;

namespace Orders.Infrastructure.Persistence;

// Seeds a fixed catalogue when empty. Prices are in integer cents.
//
// The catalogue mirrors the web-app design (assets/web-app/web-app.pen): the same
// eight products, prices, categories and photographs the cards render.
//
// Image dimensions and blurhashes describe the OPTIMISED objects sync_assets.py
// uploads, NOT the masters under assets/products/ — the script caps the long edge at
// 1080px, so a 1080x1620 master is served as 720x1080. ProductSeedManifestTests
// cross-checks these values against assets/assets.manifest.json and fails if they
// drift, which is what makes hardcoding them here safe.
public static class ProductSeed
{
    /// <summary>One catalogue entry: the seed's single source of truth per product.</summary>
    /// <remarks>
    /// Name, price, stock, categories and artwork live on ONE row so a product cannot be
    /// half-defined. The previous shape kept names+quantities in SeedStock and repeated
    /// them in the insert, cross-referencing by string — where a typo threw at runtime
    /// instead of failing to compile.
    /// </remarks>
    private sealed record SeedProduct(
        string Name,
        string Description,
        long UnitPriceCents,
        uint Units,
        string[] Categories,
        ProductImage Image);

    // Stock is tiered 100/50/25, preserving the previous seed's intent: a test for a
    // 409 insufficient_stock can exhaust a 25-unit product without placing 100 orders.
    private static readonly IReadOnlyList<SeedProduct> Catalogue =
    [
        new("Runner Low Canvas", "Low-profile canvas sneaker with a rubber cupsole.",
            8900, 100u, ["FOOTWEAR"],
            new ProductImage("products/runner-low-canvas.jpg", 1080, 720, "LWMj?rRjD%of*0j[ofj@Mcfkf6ax")),

        new("Field Tote 18L", "Structured cotton-canvas tote with a reinforced base.",
            12800, 50u, ["BAGS"],
            new ProductImage("products/field-tote-18l.jpg", 720, 1080, "LUEy0r~CR49ENFM_xuxu9aE2o~R+")),

        new("Trail Shell Jacket", "Three-layer waterproof shell with taped seams.",
            21500, 25u, ["OUTERWEAR"],
            new ProductImage("products/trail-shell-jacket.jpg", 812, 1080, "LGC7W+U_57F0^jEzVrrr~pD%I9i^")),

        new("Everyday Backpack", "22L commuter pack with a padded laptop sleeve.",
            14900, 100u, ["BAGS"],
            new ProductImage("products/everyday-backpack.jpg", 1080, 720, "L86[5Oxu00M{azoft7ay8{WB?bt7")),

        new("Linen Cap", "Six-panel cap in washed linen with a curved brim.",
            3900, 50u, ["ACCESSORIES"],
            new ProductImage("products/linen-cap.jpg", 720, 1080, "LA7KSX55nig3NGxaWVn%0K-pozaK")),

        new("Wool Runner Mid", "Mid-cut runner in merino wool with a cork insole.",
            11900, 25u, ["FOOTWEAR"],
            new ProductImage("products/wool-runner-mid.jpg", 720, 1080, "LOHVPL_4Mxbcx^V@WBog.8E1RPtR")),

        new("Leather Card Holder", "Four-slot card holder in vegetable-tanned leather.",
            5900, 100u, ["ACCESSORIES"],
            new ProductImage("products/leather-card-holder.jpg", 1080, 721, "L88NLkngDh~B-on#Rjt80f$*%L9t")),

        new("Steel Bottle 750ml", "Vacuum-insulated stainless bottle, 750ml.",
            3400, 50u, ["ACCESSORIES"],
            new ProductImage("products/steel-bottle-750ml.jpg", 762, 1080, "LHD96e-UW-%M0Lt7RjIo%fI:Rkxa")),
    ];

    /// <summary>
    /// The catalogue's starting stock, by product name — the single source of truth for
    /// "how many units should exist in a fresh database".
    /// </summary>
    /// <remarks>
    /// Exposed because the E2E cleanup restores stock to these values after a run
    /// (orders decrement stock permanently, and <see cref="RunAsync"/> below only plants
    /// rows when the table is empty, so nothing else ever replenishes them). DERIVED from
    /// <c>Catalogue</c> rather than maintained separately, so the seed and the restore
    /// cannot drift apart. The tuple shape is load-bearing: E2eEndpoints destructures it.
    /// </remarks>
    public static readonly IReadOnlyList<(string Name, uint Units)> SeedStock =
        [.. Catalogue.Select(p => (p.Name, p.Units))];

    /// <summary>Image metadata by bucket key — read by ProductSeedManifestTests.</summary>
    /// <remarks>
    /// Exposed so the manifest cross-check asserts against the SAME values the seed
    /// plants, instead of re-listing them in the test and proving only that two copies of
    /// a literal match.
    /// </remarks>
    public static IReadOnlyList<ProductImage> SeedImages =>
        [.. Catalogue.Select(p => p.Image)];

    public static Task ApplyAsync(OrdersWriteDbContext db) =>
        // Stamp CreatedBy/UpdatedBy = orders_api:product_seed via the audit
        // interceptor (replaces the old bare "system" literal).
        AmbientActor.RunAsync(AuditActor.ProductSeed, () => RunAsync(db));

    private static async Task RunAsync(OrdersWriteDbContext db)
    {
        if (await db.Products.AnyAsync()) return;

        var now = DateTime.UtcNow;
        db.Products.AddRange(Catalogue.Select(p => new Product
        {
            Id = NanoId.NewId(NanoId.ProductPrefix),
            Name = p.Name,
            Description = p.Description,
            UnitPriceCents = p.UnitPriceCents,
            UnitsInStock = p.Units,
            // A FRESH list per entity, not the shared string[]: handing the same mutable
            // instance to several entities would let one row's change appear on another.
            Categories = [.. p.Categories],
            Image = p.Image,
            CreatedAt = now,
            UpdatedAt = now,
        }));
        await db.SaveChangesAsync();
    }
}
