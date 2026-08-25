using Orders.Application.Carts;
using Orders.Domain;
using Orders.Domain.Pricing;

namespace Orders.Infrastructure.Carts;

/// <summary>
/// Cart-level arithmetic over already-priced lines. Pure: no database, no catalogue,
/// no clock — which is why it can be unit-tested exhaustively, exactly like
/// <see cref="OrderPricing"/>.
/// </summary>
public static class CartPricing
{
    /// <summary>
    /// Sums the AVAILABLE lines, applies tax to that subtotal, and adds the flat
    /// delivery charge once.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Unavailable lines are excluded deliberately: charging for what cannot be shipped
    /// is worse than showing a smaller total. They still block <c>CanCheckout</c>, so the
    /// user is told rather than silently short-changed.
    /// </para>
    /// <para>
    /// Shipping is reported UNCONDITIONALLY — including for an empty cart, and for one
    /// whose lines are all unavailable. <c>total = subtotal + tax + shipping</c> holds
    /// with no exceptions, which is the rule as specified. The consequence is that an
    /// empty cart reports a non-zero total, so a client must not render
    /// <c>total</c> as "amount due" beside an empty basket. Do not "fix" this by zeroing
    /// shipping when nothing is shippable: that was considered and rejected, because it
    /// makes the total formula conditional.
    /// </para>
    /// </remarks>
    public static (Money Subtotal, Money Tax, Money Shipping, Money Total, bool CanCheckout) Totalize(
        IReadOnlyList<CartLineDto> lines,
        decimal taxRate,
        long shippingCents)
    {
        var shippable = lines.Where(l => l.Available).ToList();

        var subtotalCents = shippable.Sum(l => l.Subtotal?.Cents ?? 0L);

        // Tax is rounded PER LINE and then summed — deliberately, and not the more
        // obvious "round once over the cart subtotal".
        //
        // The cart exists to show what checkout will charge, and checkout charges what
        // CreateOrderService computes: it calls OrderPricing.PriceLine per line and
        // accumulates `tax += lineTax`, so each line's tax is rounded before it is added.
        // Rounding once over the subtotal instead produces a DIFFERENT figure whenever the
        // per-line remainders would each have rounded up: three lines of 333 cents at 0.08
        // give round(333*0.08)*3 = 81, while round(999*0.08) = 80. The user would then be
        // shown $10.79 and charged $10.80.
        //
        // So this must mirror OrderPricing's application point, not merely its rounding
        // mode. If order pricing ever changes how it applies rounding, this changes with it.
        var taxCents = shippable.Sum(l =>
            (long)Math.Round((l.Subtotal?.Cents ?? 0L) * taxRate, MidpointRounding.AwayFromZero));

        var canCheckout = lines.Count > 0 && lines.All(l => l.Available);

        return (
            Money.FromCents(subtotalCents),
            Money.FromCents(taxCents),
            Money.FromCents(shippingCents),
            Money.FromCents(subtotalCents + taxCents + shippingCents),
            canCheckout);
    }
}
