namespace Orders.Domain.Payments;

/// <summary>
/// Server-side mirror of the plain checkout's card validation, on metadata only.
/// CONTRACT: Never accept the PAN or the CVC here — Orders sees brand, last4 and expiry, nothing
/// else, and a full number would pull the repo into PCI scope. UX correctness, not a security
/// control. See [[2026-09-19-stripe-payments-design]]
/// </summary>
public static class CardMetadataValidator
{
    private static readonly HashSet<string> KnownBrands = new(StringComparer.OrdinalIgnoreCase)
    {
        "visa", "mastercard", "amex", "discover", "diners", "jcb", "unknown",
    };

    /// <summary>
    /// Whether the brand is known, <paramref name="last4"/> is exactly four digits, and the card
    /// has not expired — a card is valid through the LAST day of its expiry month.
    /// </summary>
    public static bool IsValid(string? brand, string? last4, int? expMonth, int? expYear, DateOnly today)
    {
        if (brand is null || !KnownBrands.Contains(brand))
        {
            return false;
        }

        if (last4 is not { Length: 4 } || !last4.All(char.IsAsciiDigit))
        {
            return false;
        }

        if (expMonth is not (>= 1 and <= 12) || expYear is not (>= 1 and <= 9999))
        {
            return false;
        }

        var year = expYear.Value;
        var month = expMonth.Value;
        return new DateOnly(year, month, DateTime.DaysInMonth(year, month)) >= today;
    }
}
