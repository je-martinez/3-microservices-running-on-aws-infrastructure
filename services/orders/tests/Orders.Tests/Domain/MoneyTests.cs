using Orders.Domain;
using Xunit;

namespace Orders.Tests.Domain;

public class MoneyTests
{
    [Theory]
    [InlineData(0L, "0.00", "$0.00")]
    [InlineData(5L, "0.05", "$0.05")]
    [InlineData(320L, "3.20", "$3.20")]
    [InlineData(3998L, "39.98", "$39.98")]
    [InlineData(100000L, "1000.00", "$1,000.00")]
    public void FromCents_formats_amount_and_display(long cents, string amount, string formatted)
    {
        var money = Money.FromCents(cents);

        Assert.Equal(cents, money.Cents);
        Assert.Equal(amount, money.Amount);
        Assert.Equal(formatted, money.Formatted);
        Assert.Equal("USD", money.Currency);
    }

    // The whole point of pinning the culture. Under a de-DE container default,
    // an implementation using the ambient culture emits "39,98" and every client
    // parsing `amount` as a decimal breaks — silently, and only in that deployment.
    [Fact]
    public void FromCents_is_independent_of_the_ambient_culture()
    {
        var original = System.Globalization.CultureInfo.CurrentCulture;
        try
        {
            System.Globalization.CultureInfo.CurrentCulture =
                new System.Globalization.CultureInfo("de-DE");

            var money = Money.FromCents(3998);

            Assert.Equal("39.98", money.Amount);
            Assert.Equal("$39.98", money.Formatted);
        }
        finally
        {
            System.Globalization.CultureInfo.CurrentCulture = original;
        }
    }

    // Negative amounts are not a cart concern, but Money is now the ONLY money
    // type on the wire, so it must not produce nonsense if a refund-shaped value
    // ever reaches it.
    [Fact]
    public void FromCents_handles_a_negative_amount()
    {
        var money = Money.FromCents(-1999);

        Assert.Equal(-1999, money.Cents);
        Assert.Equal("-19.99", money.Amount);
        Assert.Equal("-$19.99", money.Formatted);
    }
}
