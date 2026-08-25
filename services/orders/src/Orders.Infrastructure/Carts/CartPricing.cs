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
        var subtotalCents = lines.Where(l => l.Available).Sum(l => l.Subtotal?.Cents ?? 0L);

        // Tax on the CART subtotal, rounded once — not per line then summed, which can
        // drift by a cent. Same rounding mode as OrderPricing so a cart and the order it
        // becomes agree to the cent.
        var taxCents = (long)Math.Round(subtotalCents * taxRate, MidpointRounding.AwayFromZero);

        var canCheckout = lines.Count > 0 && lines.All(l => l.Available);

        return (
            Money.FromCents(subtotalCents),
            Money.FromCents(taxCents),
            Money.FromCents(shippingCents),
            Money.FromCents(subtotalCents + taxCents + shippingCents),
            canCheckout);
    }
}
