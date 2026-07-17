using Orders.Domain.Pricing;
using Xunit;

namespace Orders.Tests.Domain;

public class OrderPricingTests
{
    [Fact]
    public void PriceLine_multiplies_and_applies_tax()
    {
        // 3 units at $19.99 = $59.97 subtotal; 8% tax = $4.7976 -> 480 cents.
        var (subtotal, tax, total) = OrderPricing.PriceLine(1999, 3, 0.08m);
        Assert.Equal(5997, subtotal);
        Assert.Equal(480, tax);
        Assert.Equal(6477, total);
    }

    [Fact]
    public void PriceLine_zero_tax()
    {
        var (subtotal, tax, total) = OrderPricing.PriceLine(1000, 2, 0m);
        Assert.Equal(2000, subtotal);
        Assert.Equal(0, tax);
        Assert.Equal(2000, total);
    }
}
