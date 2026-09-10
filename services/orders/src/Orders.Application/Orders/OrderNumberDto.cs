using Orders.Domain;

namespace Orders.Application.Orders;

/// <summary>
/// The customer-facing order number on the wire, in BOTH its canonical and displayed forms.
/// </summary>
/// <remarks>
/// CONTRACT: PRESENTATION ONLY, like <see cref="Orders.Domain.Money"/> — the column stores
/// <see cref="Raw"/> alone. Consumers render <see cref="Formatted"/> VERBATIM; copies of the
/// separator rule drift. See [[money-representation]]
/// CONTRACT: Null for an order with no number, never empty strings.
/// See [[friendly-order-number]]
/// </remarks>
public sealed record OrderNumberDto(string Raw, string Formatted)
{
    /// <summary>Builds both representations from the stored canonical value.</summary>
    /// <returns>Null when the order has no number — a row predating the backfill.</returns>
    public static OrderNumberDto? FromCanonical(string? canonical) =>
        string.IsNullOrWhiteSpace(canonical)
            ? null
            : new OrderNumberDto(canonical, OrderNumber.Format(canonical));
}
