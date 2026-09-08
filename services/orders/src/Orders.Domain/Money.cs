using System.Globalization;

namespace Orders.Domain;

/// <summary>
/// A monetary amount on the wire, reported in BOTH integer cents and display dollars.
/// </summary>
/// <remarks>
/// CONTRACT: PRESENTATION ONLY. Storage stays <c>bigint</c> cents, so this type must not
/// reach a DbContext, a migration, or the ORDER_CREATED envelope. <see cref="Cents"/> is
/// authoritative; the strings are derived views.
/// CONTRACT: Build both strings with <see cref="CultureInfo.InvariantCulture"/>. Under the
/// ambient culture a de-DE container emits "39,98", breaking every client that parses
/// <see cref="Amount"/> as a decimal — in that deployment only, with no error.
/// See [[money-representation]]
/// </remarks>
public sealed record Money(long Cents, string Amount, string Formatted, string Currency)
{
    /// <summary>The only currency this service deals in.</summary>
    public const string Usd = "USD";

    /// <summary>Builds every representation from the authoritative cents value.</summary>
    public static Money FromCents(long cents)
    {
        var dollars = cents / 100m;

        return new Money(
            cents,
            // "F2" not "C2": a plain decimal string a client can parse.
            dollars.ToString("F2", CultureInfo.InvariantCulture),
            // "C2" against en-US, so the symbol and the thousands separator are stable
            // regardless of the host's locale.
            dollars.ToString("C2", CultureInfo.GetCultureInfo("en-US")),
            Usd);
    }
}
