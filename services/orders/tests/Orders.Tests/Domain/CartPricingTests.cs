using Orders.Application.Carts;
using Orders.Domain;
using Orders.Infrastructure.Carts;
using Xunit;

namespace Orders.Tests.Domain;

public class CartPricingTests
{
    private const decimal TaxRate = 0.08m;
    private const long ShippingCents = 599;

    private static CartLineDto Available(long unitPriceCents, uint quantity) =>
        new(
            ProductId: "prd_x",
            Name: "Widget",
            Quantity: quantity,
            UnitsInStock: 50,
            Available: true,
            UnitPrice: Money.FromCents(unitPriceCents),
            Subtotal: Money.FromCents(unitPriceCents * quantity),
            Image: null,
            UnavailableReason: null);

    private static CartLineDto Unavailable(long unitPriceCents, uint quantity) =>
        new(
            ProductId: "prd_y",
            Name: "Keyboard",
            Quantity: quantity,
            UnitsInStock: 0,
            Available: false,
            UnitPrice: Money.FromCents(unitPriceCents),
            Subtotal: Money.FromCents(unitPriceCents * quantity),
            Image: null,
            UnavailableReason: UnavailableReason.OutOfStock);

    [Fact]
    public void Totals_sum_available_lines_and_add_tax_and_shipping_once()
    {
        var totals = CartPricing.Totalize(
            [Available(1999, 2)], TaxRate, ShippingCents);

        Assert.Equal(3998, totals.Subtotal.Cents);
        Assert.Equal(320, totals.Tax.Cents);              // round(3998 * 0.08) = 320
        Assert.Equal(599, totals.Shipping.Cents);
        Assert.Equal(4917, totals.Total.Cents);           // 3998 + 320 + 599
        Assert.True(totals.CanCheckout);
    }

    // Shipping is an ORDER/CART-level charge. Two lines must not be charged twice.
    [Fact]
    public void Shipping_is_charged_once_regardless_of_line_count()
    {
        var totals = CartPricing.Totalize(
            [Available(1000, 1), Available(2000, 1)], TaxRate, ShippingCents);

        Assert.Equal(3000, totals.Subtotal.Cents);
        Assert.Equal(599, totals.Shipping.Cents);
    }

    // The rule that keeps the user from being charged for what cannot ship.
    [Fact]
    public void Unavailable_lines_are_excluded_from_the_totals()
    {
        var totals = CartPricing.Totalize(
            [Available(1999, 2), Unavailable(8999, 1)], TaxRate, ShippingCents);

        Assert.Equal(3998, totals.Subtotal.Cents);        // the 8999 line is not counted
        Assert.Equal(4917, totals.Total.Cents);
        Assert.False(totals.CanCheckout);                 // ...but it does block checkout
    }

    // Shipping is ALWAYS reported, including on an empty cart: `total = subtotal + tax
    // + shipping` holds with no exceptions, which is the rule the spec states. A
    // consequence worth knowing: an empty cart reports a non-zero total. The frontend
    // must therefore not paint `total` as "what you owe" next to an empty basket.
    [Fact]
    public void An_empty_cart_still_reports_the_delivery_charge()
    {
        var totals = CartPricing.Totalize([], TaxRate, ShippingCents);

        Assert.Equal(0, totals.Subtotal.Cents);
        Assert.Equal(0, totals.Tax.Cents);
        Assert.Equal(599, totals.Shipping.Cents);
        Assert.Equal(599, totals.Total.Cents);
        Assert.False(totals.CanCheckout);
    }

    // Same rule where every line is unavailable: nothing is charged for the goods,
    // but the delivery figure is still reported unconditionally.
    [Fact]
    public void A_cart_with_only_unavailable_lines_still_reports_the_delivery_charge()
    {
        var totals = CartPricing.Totalize([Unavailable(8999, 1)], TaxRate, ShippingCents);

        Assert.Equal(0, totals.Subtotal.Cents);
        Assert.Equal(599, totals.Shipping.Cents);
        Assert.Equal(599, totals.Total.Cents);
        Assert.False(totals.CanCheckout);
    }
}
