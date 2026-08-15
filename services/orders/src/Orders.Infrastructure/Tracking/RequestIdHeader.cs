using Orders.Infrastructure.Id;
using RestSharp;

namespace Orders.Infrastructure.Tracking;

/// <summary>
/// Attaches the correlation header to an outbound Tracking request.
/// </summary>
/// <remarks>
/// An extension rather than a line copied into each call site: both operations on
/// <see cref="TrackingHttpClient"/> — creation and the batch read — must send the same
/// header spelled the same way, and the failure mode of forgetting it on one of them is a
/// silent gap in exactly one hop of the flow, which nothing else would catch.
/// </remarks>
internal static class RequestIdHeader
{
    /// <summary>
    /// Adds <c>x-request-id</c> when a request id is in scope; adds nothing when there is
    /// none.
    /// </summary>
    /// <remarks>
    /// OMITTED rather than sent empty when absent (background work, a test that seeded no
    /// context). Tracking validates what it receives and would discard an empty value
    /// anyway, so sending one buys nothing and makes a traffic capture read as though a
    /// correlation id existed and was blank.
    /// </remarks>
    internal static RestRequest WithRequestId(this RestRequest request)
    {
        var requestId = AmbientRequestId.Current;

        return string.IsNullOrEmpty(requestId)
            ? request
            : request.AddHeader(RequestId.HeaderName, requestId);
    }
}
