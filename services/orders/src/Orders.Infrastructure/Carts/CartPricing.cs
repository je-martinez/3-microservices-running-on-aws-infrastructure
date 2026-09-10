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
    /// CONTRACT: Report shipping UNCONDITIONALLY, empty cart included, so
    /// <c>total = subtotal + tax + shipping</c> holds with no exceptions. Do NOT "fix" the
    /// non-zero total on an empty cart by zeroing shipping — that makes the formula
    /// conditional; a client simply must not render <c>total</c> as "amount due" beside an
    /// empty basket. Unavailable lines are excluded but still block <c>CanCheckout</c>, so
    /// the user is told rather than silently short-changed. See [[money-representation]]
    /// </remarks>
    public static (Money Subtotal, Money Tax, Money Shipping, Money Total, bool CanCheckout) Totalize(
        IReadOnlyList<CartLineDto> lines,
        decimal taxRate,
        long shippingCents)
    {
        var shippable = lines.Where(l => l.Available).ToList();

        var subtotalCents = shippable.Sum(l => l.Subtotal?.Cents ?? 0L);

        // CONTRACT: Round tax PER LINE and then sum, mirroring where OrderPricing APPLIES
        // rounding — not merely its rounding mode. Rounding once over the subtotal differs
        // whenever the per-line remainders each round up (three lines of 333 at 0.08 give 81
        // per-line, 80 over the subtotal), so the user is shown $10.79 and charged $10.80.
        // If order pricing changes how it applies rounding, this changes with it.
        // See [[money-representation]]
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
