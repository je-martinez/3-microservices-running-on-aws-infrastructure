using System.Text.RegularExpressions;

namespace Orders.Infrastructure.Id;

/// <summary>
/// The cross-service correlation id — <c>req_</c> + a nano-id of
/// <see cref="NanoIdConfig.Length"/> characters — carried on every log line of a request and
/// forwarded to every downstream hop. See [[nano-id]]
/// </summary>
public static class RequestId
{
    /// <summary>
    /// The header the id travels in, inbound and outbound. Lowercase, matching every other
    /// service here; ASP.NET Core's lookup is case-insensitive.
    /// </summary>
    public const string HeaderName = "x-request-id";

    /// <summary>The <c>prefix_nanoid</c> prefix for a request id — see [[nano-id]].</summary>
    public const string Prefix = NanoIdConfig.RequestPrefix;

    /// <summary>
    /// <c>req_</c> plus <see cref="NanoIdConfig.Length"/> characters of the alphabet.
    /// CONTRACT: Derive the pattern from <see cref="NanoIdConfig"/>, never write it out — a
    /// copy drifts the day the format changes and then rejects every id the generator
    /// produces. See [[nano-id]]
    /// </summary>
    private static readonly Regex Pattern = new(
        NanoIdConfig.PatternFor(Prefix),
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    /// <summary>A new correlation id.</summary>
    public static string New() => NanoId.NewId(Prefix);

    /// <summary>
    /// The caller's request id if it is one of ours, otherwise a freshly minted one.
    /// CONTRACT: Validate the header — untrusted, yet stamped onto every log line and
    /// forwarded to Tracking and SQS. An unbounded string bloats every record and an
    /// <c>ord_</c>-shaped value makes log queries correlate the wrong things.
    /// CONTRACT: Do NOT answer 400 on a bad one — a mangling proxy would turn an
    /// observability nicety into an outage. See [[logging-context]]
    /// </summary>
    public static string Resolve(string? headerValue) =>
        headerValue is not null && Pattern.IsMatch(headerValue) ? headerValue : New();
}
