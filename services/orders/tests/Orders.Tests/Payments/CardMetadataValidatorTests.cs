using Orders.Domain.Payments;

namespace Orders.Tests.Payments;

public class CardMetadataValidatorTests
{
    private static readonly DateOnly Today = new(2026, 9, 22);

    [Theory]
    [InlineData("visa", "4242", 9, 2026, true)]        // expires this month: still valid
    [InlineData("visa", "4242", 8, 2026, false)]       // last month
    [InlineData("VISA", "4242", 12, 2030, true)]       // brand is case-insensitive
    [InlineData("amex", "0005", 1, 2027, true)]
    [InlineData("unknown", "1234", 1, 2027, true)]     // the permissive fallback brand
    [InlineData("visa", "42a2", 12, 2030, false)]      // last4 not all digits
    [InlineData("visa", "42424", 12, 2030, false)]     // last4 too long
    [InlineData("visa", "4242", 0, 2030, false)]
    [InlineData("visa", "4242", 13, 2030, false)]
    [InlineData("visa", "4242", 12, 0, false)]         // out of DateOnly's range: rejected, not thrown
    [InlineData("visa", "4242", 12, 10000, false)]
    public void Validates_brand_last4_and_expiry(string brand, string last4, int expMonth, int expYear, bool expected)
    {
        Assert.Equal(expected, CardMetadataValidator.IsValid(brand, last4, expMonth, expYear, Today));
    }

    [Fact]
    public void A_missing_field_is_invalid()
    {
        Assert.False(CardMetadataValidator.IsValid(null, "4242", 12, 2030, Today));
        Assert.False(CardMetadataValidator.IsValid("visa", null, 12, 2030, Today));
        Assert.False(CardMetadataValidator.IsValid("visa", "4242", null, 2030, Today));
        Assert.False(CardMetadataValidator.IsValid("visa", "4242", 12, null, Today));
    }
}
