using System.Globalization;

namespace Orders.Domain;

/// <summary>
/// A monetary amount on the wire, reported in BOTH integer cents and display dollars.
/// </summary>
/// <remarks>
/// <para>
/// Exists so no client ever divides by 100 or formats a currency itself. Every money
/// field in this service's HTTP DTOs is a <see cref="Money"/>, never a bare number.
/// </para>
/// <para>
/// PRESENTATION ONLY. Storage stays <c>bigint</c> cents and entities keep <c>long</c>;
/// this type must not reach a DbContext, a migration, or the ORDER_CREATED SQS envelope
/// (a contract with events-pipeline). <see cref="Cents"/> remains the authoritative value —
/// <see cref="Amount"/> and <see cref="Formatted"/> are derived views of it.
/// </para>
/// <para>
/// Both strings are built with <see cref="CultureInfo.InvariantCulture"/> deliberately.
/// Under the ambient culture a container whose default is, say, de-DE would emit
/// "39,98" — breaking every client that parses <see cref="Amount"/> as a decimal, in that
/// deployment only, with no error anywhere. Currency is a constant: this repo has no
/// multi-currency support, and inventing one here would be speculative.
/// </para>
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
