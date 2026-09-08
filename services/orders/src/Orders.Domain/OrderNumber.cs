using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Orders.Domain;

/// <summary>
/// The customer-facing order number: <c>260907-8KJ4M2</c> displayed,
/// <c>2609078KJ4M2</c> stored — see [[friendly-order-number]].
/// </summary>
/// <remarks>
/// CONTRACT: This is NOT an id. <c>Order.Id</c> stays the key every other contract
/// references; this value is a label read aloud on a support call. See [[nano-id]]
/// CONTRACT: The date prefix is UTC, never the host's local time, and backfill applies the
/// identical rule. See [[friendly-order-number]]
/// </remarks>
public static class OrderNumberConfig
{
    /// <summary>
    /// Crockford base32: no <c>I</c>, <c>L</c>, <c>O</c> or <c>U</c>.
    /// CONTRACT: Those four exclusions are what make the value transcribable, and uppercase
    /// is what makes it sayable. See [[friendly-order-number]]
    /// </summary>
    public const string Alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

    /// <summary>Characters in the random suffix, excluding the date prefix.</summary>
    /// <remarks>
    /// CONTRACT: NOT collision-free. The unique index guarantees uniqueness; six characters
    /// only set how often the retry fires (~0.005% at 333 orders/day, because the date
    /// prefix makes the collision domain one DAY). See [[friendly-order-number]]
    /// </remarks>
    public const int SuffixLength = 6;

    /// <summary><c>YYMMDD</c> — six digits.</summary>
    public const int PrefixLength = 6;

    /// <summary>
    /// Total stored width, no separator.
    /// CONTRACT: Size the column for exactly this — MySQL truncates silently. See [[nano-id]]
    /// </summary>
    public const int TotalLength = PrefixLength + SuffixLength;

    /// <summary>The single character between date and suffix, for DISPLAY only.</summary>
    /// <remarks>
    /// CONTRACT: The separator never reaches the column or the unique index. It is a
    /// rendering concern, and the canonical form has none.
    /// </remarks>
    public const char DisplaySeparator = '-';

    /// <summary>
    /// Matches a canonical (stored) order number, anchored at both ends with an exact length.
    /// CONTRACT: Validate untrusted lookup input against this AFTER normalizing, never
    /// against the displayed form — a caller may send either spelling.
    /// </summary>
    public static readonly string CanonicalPattern =
        $"^[0-9]{{{PrefixLength}}}[{Alphabet}]{{{SuffixLength}}}$";
}

/// <summary>
/// Mints and formats customer-facing order numbers. The format lives in
/// <see cref="OrderNumberConfig"/>.
/// </summary>
public static class OrderNumber
{
    private static readonly Regex Canonical =
        new(OrderNumberConfig.CanonicalPattern, RegexOptions.Compiled);

    /// <summary>
    /// A fresh canonical order number for an order created at <paramref name="createdAtUtc"/>,
    /// e.g. <c>2609078KJ4M2</c>.
    /// </summary>
    /// <remarks>
    /// CONTRACT: Pass the ORDER'S OWN creation instant, never "now" at render time, or the
    /// same order shows a different number depending on when it is viewed.
    /// CONTRACT: <see cref="RandomNumberGenerator"/>, not <see cref="Random"/> — a
    /// time-seeded generator hands two same-tick orders one suffix.
    /// See [[friendly-order-number]]
    /// </remarks>
    public static string New(DateTime createdAtUtc) =>
        DatePrefix(createdAtUtc) + RandomSuffix();

    /// <summary>The <c>YYMMDD</c> prefix for an instant, always read as UTC.</summary>
    /// <remarks>
    /// CONTRACT: An <c>Unspecified</c> instant is ALREADY UTC and must not be converted.
    /// MySQL returns every <c>created_at</c> that way, and <c>ToUniversalTime()</c> shifts
    /// such a value by the host's offset — moving a 23:30Z order onto the next day west of
    /// UTC. Do NOT simplify this to a bare <c>ToUniversalTime()</c>.
    /// See [[friendly-order-number]]
    /// </remarks>
    public static string DatePrefix(DateTime instant)
    {
        var utc = instant.Kind switch
        {
            DateTimeKind.Utc => instant,
            // Already UTC by convention — every persisted instant in this service is stored
            // as UTC and read back without a kind.
            DateTimeKind.Unspecified => instant,
            _ => instant.ToUniversalTime(),
        };

        return utc.ToString("yyMMdd", CultureInfo.InvariantCulture);
    }

    /// <summary>The random half, drawn uniformly from the Crockford alphabet.</summary>
    /// <remarks>
    /// WHY: <c>GetInt32</c> per character rather than masking random bytes. The alphabet is
    /// 32 characters, so a byte-masking approach happens to be unbiased here — but it stops
    /// being so the moment the alphabet changes length, and the bias would be invisible.
    /// </remarks>
    private static string RandomSuffix()
    {
        var suffix = new StringBuilder(OrderNumberConfig.SuffixLength);

        for (var i = 0; i < OrderNumberConfig.SuffixLength; i++)
        {
            suffix.Append(OrderNumberConfig.Alphabet[
                RandomNumberGenerator.GetInt32(OrderNumberConfig.Alphabet.Length)]);
        }

        return suffix.ToString();
    }

    /// <summary>
    /// The displayed form of a canonical number: <c>2609078KJ4M2</c> to <c>260907-8KJ4M2</c>.
    /// </summary>
    /// <remarks>
    /// CONTRACT: The server owns this rule; consumers render the result verbatim, the same
    /// reason <c>Money.Formatted</c> exists. Copies of the rule drift, and a customer then
    /// reads out a number support cannot find. See [[money-representation]]
    /// </remarks>
    public static string Format(string canonical) =>
        canonical.Length == OrderNumberConfig.TotalLength
            ? string.Concat(
                canonical.AsSpan(0, OrderNumberConfig.PrefixLength),
                stackalloc[] { OrderNumberConfig.DisplaySeparator },
                canonical.AsSpan(OrderNumberConfig.PrefixLength))
            // A stored value of the wrong width cannot be split meaningfully. Returning it
            // untouched keeps a support surface readable instead of throwing on display.
            : canonical;

    /// <summary>
    /// Turns whatever a customer typed into the canonical form for comparison: strips
    /// separators and whitespace, uppercases.
    /// </summary>
    /// <remarks>
    /// CONTRACT: Normalize BEFORE comparing against the column, or a customer who typed the
    /// hyphen (or lowercase) is told their order does not exist.
    /// CONTRACT: <see cref="CultureInfo.InvariantCulture"/> — a <c>tr-TR</c> container maps
    /// <c>i</c> to <c>İ</c> and fails lookups that work everywhere else.
    /// See [[friendly-order-number]]
    /// </remarks>
    public static string Normalize(string input)
    {
        var normalized = new StringBuilder(input.Length);

        foreach (var character in input)
        {
            if (character is OrderNumberConfig.DisplaySeparator or ' ' or '\t') continue;
            normalized.Append(char.ToUpper(character, CultureInfo.InvariantCulture));
        }

        return normalized.ToString();
    }

    /// <summary>Whether a value is a well-formed canonical order number.</summary>
    public static bool IsCanonical(string? value) =>
        !string.IsNullOrEmpty(value) && Canonical.IsMatch(value);
}
