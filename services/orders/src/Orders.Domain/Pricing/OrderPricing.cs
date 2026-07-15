namespace Orders.Domain.Pricing;

// All money math is integer-cents. Tax is computed from the integer subtotal and
// rounded to the nearest cent (away from zero) exactly once per line.
public static class OrderPricing
{
    public static (long SubtotalCents, long TaxCents, long TotalCents) PriceLine(
        long unitPriceCents,
        uint quantity,
        decimal taxRate)
    {
        long subtotalCents = unitPriceCents * quantity;
        long taxCents = (long)Math.Round(subtotalCents * taxRate, MidpointRounding.AwayFromZero);
        return (subtotalCents, taxCents, subtotalCents + taxCents);
    }
}
