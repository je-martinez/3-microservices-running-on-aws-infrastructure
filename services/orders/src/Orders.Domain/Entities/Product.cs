namespace Orders.Domain.Entities;

public class Product : AuditableEntity
{
    public string Name { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public long UnitPriceCents { get; set; }
    public uint UnitsInStock { get; set; }

    // Computed, not persisted: dollars for display only.
    public decimal UnitPrice => UnitPriceCents / 100m;
}
