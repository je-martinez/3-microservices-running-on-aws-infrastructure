namespace Orders.Domain.Entities;

public class Product : AuditableEntity
{
    public string Name { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public long UnitPriceCents { get; set; }
    public uint UnitsInStock { get; set; }

    /// <summary>Display image; null for a product with no artwork yet.</summary>
    public ProductImage? Image { get; set; }

    /// <summary>
    /// Catalogue facets, e.g. ["FOOTWEAR"]. Stored as a JSON array because MySQL 8
    /// has no native array type — the same treatment as Order.Tags.
    /// </summary>
    public List<string> Categories { get; set; } = [];

    // Computed, not persisted: dollars for display only.
    public decimal UnitPrice => UnitPriceCents / 100m;
}
