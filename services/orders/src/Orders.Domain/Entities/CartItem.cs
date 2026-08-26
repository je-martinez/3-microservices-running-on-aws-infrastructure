namespace Orders.Domain.Entities;

/// <summary>One product and its quantity within a <see cref="Cart"/>.</summary>
/// <remarks>
/// Carries NO price, deliberately. The catalogue price is resolved live on every
/// read, so the user always sees the current price and there is never a frozen
/// figure that disagrees with what checkout actually charges. An Order is the
/// opposite — it freezes its prices, because a past order must keep reporting
/// what it really cost.
/// </remarks>
public class CartItem : AuditableEntity
{
    public string CartId { get; set; } = string.Empty;
    public string ProductId { get; set; } = string.Empty;
    public uint Quantity { get; set; }
}
