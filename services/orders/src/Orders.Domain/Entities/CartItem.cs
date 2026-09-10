namespace Orders.Domain.Entities;

/// <summary>One product and its quantity within a <see cref="Cart"/>.</summary>
/// <remarks>
/// CONTRACT: Carries NO price. The catalogue price is resolved live on every read, so no
/// frozen figure can disagree with what checkout charges. An Order is the opposite: it
/// freezes its prices, because a past order must keep reporting what it cost.
/// See [[money-representation]]
/// </remarks>
public class CartItem : AuditableEntity
{
    public string CartId { get; set; } = string.Empty;
    public string ProductId { get; set; } = string.Empty;
    public uint Quantity { get; set; }
}
