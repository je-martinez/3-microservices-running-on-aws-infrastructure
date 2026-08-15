using System.Text.RegularExpressions;

namespace Orders.Infrastructure.Id;

/// <summary>
/// The cross-service correlation id — <c>req_</c> + a 21-character nano-id —
/// carried on every log line of a request and forwarded to every downstream hop.
/// </summary>
/// <remarks>
/// <para>
/// Lives in Infrastructure, next to <see cref="NanoId"/>, for two reasons. The generator
/// IS <see cref="NanoId"/>, whose NanoidDotNet package is referenced here and nowhere else;
/// and both consumers can reach it from here — Api (the ingress middleware and the log
/// enricher) references Infrastructure, and the outbound hops (TrackingHttpClient,
/// SqsEventPublisher) already live in it. Putting it in Application instead would either
/// drag the nano-id dependency inward or force a hand-rolled second generator, and
/// Application must not reference Infrastructure to reach back for the real one
/// (services/orders/CLAUDE.md §3).
/// </para>
/// </remarks>
public static partial class RequestId
{
    /// <summary>
    /// The header the id travels in, inbound and outbound.
    /// </summary>
    /// <remarks>
    /// Lowercase to match what every other service in this repo sends and reads; ASP.NET
    /// Core's header lookup is case-insensitive, so an inbound <c>X-Request-Id</c> still
    /// matches.
    /// </remarks>
    public const string HeaderName = "x-request-id";

    /// <summary>The <c>prefix_nanoid</c> prefix for a request id — see [[nano-id]].</summary>
    public const string Prefix = "req_";

    /// <summary>A new correlation id.</summary>
    public static string New() => NanoId.NewId(Prefix);

    /// <summary>
    /// The request id for an inbound request: the caller's own if it is one of ours,
    /// otherwise a freshly minted one.
    /// </summary>
    /// <remarks>
    /// <para>
    /// WHY THIS IS VALIDATED. The header is untrusted input — it reaches us from the
    /// gateway, from a sibling service, or straight from whoever is holding curl — and
    /// whatever it says gets stamped onto EVERY log line the request produces and
    /// forwarded to Tracking and onto the SQS envelope. That makes it the single most
    /// widely-copied attacker-controlled value in the log stream: an unbounded string
    /// would bloat every record of the flow, a control character would break the JSON a
    /// dashboard parses, and a value shaped like an <c>ord_</c> or <c>usr_</c> id would
    /// make a log query correlate the wrong things entirely. Accepting only our own shape
    /// is what keeps the field trustworthy for the one job it has.
    /// </para>
    /// <para>
    /// WHY A BAD ONE IS NOT A 400. A correlation header is a convenience, not part of any
    /// route's contract, so it must never be able to fail a request that was otherwise
    /// going to succeed — a mangling proxy or a mistyped curl flag turning into an error
    /// response would trade an observability nicety for an outage. Discarding it silently
    /// and generating a fresh id degrades exactly as far as needed: the flow is still
    /// correlated end to end from here on, just not under the caller's chosen id.
    /// </para>
    /// </remarks>
    public static string Resolve(string? headerValue) =>
        headerValue is not null && Pattern().IsMatch(headerValue) ? headerValue : New();

    /// <summary>
    /// <c>req_</c> followed by 21 characters of nanoid's default URL-safe alphabet.
    /// </summary>
    /// <remarks>
    /// Anchored at both ends and an EXACT length rather than a range: this expression is
    /// the only thing standing between an untrusted header and every log line of the
    /// request, so there is no room in it for "close enough".
    /// </remarks>
    [GeneratedRegex(@"^req_[A-Za-z0-9_-]{21}$")]
    private static partial Regex Pattern();
}
