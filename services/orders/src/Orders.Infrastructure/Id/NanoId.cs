using System.Text.RegularExpressions;

namespace Orders.Infrastructure.Id;

/// <summary>
/// The one place the id format is defined for this service — see [[nano-id]].
/// </summary>
/// <remarks>
/// <para>
/// <see cref="Alphabet"/> is letters and digits only. Nanoid's default adds <c>_</c> and
/// <c>-</c>, and those two characters are why this exists: an id is pasted into a shell,
/// a URL, a log grep and a CSV, and a leading <c>-</c> reads as a flag while <c>_</c>
/// disappears against an underscored column name. Restricting the alphabet costs nothing —
/// 62^24 is MORE entropy than the 64^21 it replaces, so collision risk goes down, not up.
/// </para>
/// <para>
/// <see cref="Length"/> is the nanoid portion only. A stored id is
/// <see cref="PrefixLength"/> + <see cref="Length"/> = <see cref="TotalLength"/> = 28
/// characters, which is what every id-bearing database column must be sized for. Getting
/// that wrong truncates silently in MySQL rather than erroring.
/// </para>
/// <para>
/// The same three values are defined in Users (<c>src/shared/id/nano-id.ts</c>) and
/// Tracking (<c>shared/db/nano_id.py</c>). They are a CROSS-SERVICE CONTRACT: ids cross
/// service boundaries in headers, envelopes and foreign keys, so a service that disagrees
/// about the alphabet or the length produces ids the others reject. Changing any of them
/// means changing all three together.
/// </para>
/// </remarks>
public static class NanoIdConfig
{
    /// <summary>Letters and digits only — no <c>_</c>, no <c>-</c>.</summary>
    public const string Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

    /// <summary>Characters in the random portion, excluding the prefix.</summary>
    public const int Length = 24;

    /// <summary>Every prefix is <c>xxx_</c> — three characters and an underscore.</summary>
    public const int PrefixLength = 4;

    /// <summary>Total stored width: what an id column must hold.</summary>
    public const int TotalLength = PrefixLength + Length;

    /// <summary>Prefix per entity, plus the non-persisted ids this service mints.</summary>
    public const string ProductPrefix = "prd_";

    /// <inheritdoc cref="ProductPrefix"/>
    public const string OrderPrefix = "ord_";

    /// <inheritdoc cref="ProductPrefix"/>
    public const string OrderDetailPrefix = "odd_";

    /// <inheritdoc cref="ProductPrefix"/>
    public const string CartPrefix = "crt_";

    /// <inheritdoc cref="ProductPrefix"/>
    public const string CartItemPrefix = "cti_";

    /// <summary>The correlation id carried on every request — see <see cref="RequestId"/>.</summary>
    public const string RequestPrefix = "req_";

    /// <summary>The SQS envelope's idempotency key — see <c>SqsEventPublisher</c>.</summary>
    public const string EventPrefix = "evt_";

    /// <summary>
    /// Every prefix this service mints, so a test can assert the set is well-formed and
    /// unique in one place instead of per-constant.
    /// </summary>
    public static readonly IReadOnlyList<string> Prefixes =
    [
        ProductPrefix,
        OrderPrefix,
        OrderDetailPrefix,
        CartPrefix,
        CartItemPrefix,
        RequestPrefix,
        EventPrefix,
    ];

    /// <summary>
    /// A regex source matching a full prefixed id. Built from the values above rather than
    /// written out, so it cannot drift from what the generator actually produces.
    /// </summary>
    /// <remarks>
    /// Anchored at both ends and an EXACT length rather than a range — the callers of this
    /// (notably <see cref="RequestId.Resolve"/>) validate untrusted input, where there is
    /// no room for "close enough".
    /// </remarks>
    public static string PatternFor(string prefix) =>
        $"^{Regex.Escape(prefix)}[A-Za-z0-9]{{{Length}}}$";
}

/// <summary>
/// Prefixed nano-id generator. The format itself lives in <see cref="NanoIdConfig"/>.
/// </summary>
public static class NanoId
{
    /// <inheritdoc cref="NanoIdConfig.ProductPrefix"/>
    public const string ProductPrefix = NanoIdConfig.ProductPrefix;

    /// <inheritdoc cref="NanoIdConfig.OrderPrefix"/>
    public const string OrderPrefix = NanoIdConfig.OrderPrefix;

    /// <inheritdoc cref="NanoIdConfig.OrderDetailPrefix"/>
    public const string OrderDetailPrefix = NanoIdConfig.OrderDetailPrefix;

    /// <inheritdoc cref="NanoIdConfig.CartPrefix"/>
    public const string CartPrefix = NanoIdConfig.CartPrefix;

    /// <inheritdoc cref="NanoIdConfig.CartItemPrefix"/>
    public const string CartItemPrefix = NanoIdConfig.CartItemPrefix;

    /// <summary>A fresh <c>prefix_nanoid</c>, e.g. <c>ord_7gK3mP1vXz9wLq2bN8rRt4Yc</c>.</summary>
    /// <remarks>
    /// Nanoid 3.x exposes a synchronous <c>Generate(alphabet, size)</c>; both arguments come
    /// from <see cref="NanoIdConfig"/> so the generator and the validation pattern are built
    /// from the same numbers.
    /// </remarks>
    public static string NewId(string prefix) =>
        prefix + NanoidDotNet.Nanoid.Generate(NanoIdConfig.Alphabet, NanoIdConfig.Length);
}
