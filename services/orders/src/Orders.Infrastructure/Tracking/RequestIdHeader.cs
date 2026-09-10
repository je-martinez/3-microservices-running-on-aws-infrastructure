using Orders.Infrastructure.Id;
using RestSharp;

namespace Orders.Infrastructure.Tracking;

/// <summary>
/// Attaches the correlation header to an outbound Tracking request.
/// </summary>
/// <remarks>
/// CONTRACT: An extension, not a line copied per call site. Both operations must send the
/// same header spelled the same way, and forgetting it on one leaves a silent gap in exactly
/// one hop that nothing else catches. See [[logging-context]]
/// </remarks>
internal static class RequestIdHeader
{
    /// <summary>
    /// Adds <c>x-request-id</c> when a request id is in scope, and nothing when there is none.
    /// CONTRACT: Omit the header rather than sending it empty — Tracking discards an empty
    /// value anyway, and a traffic capture then reads as though a correlation id existed and
    /// was blank. See [[logging-context]]
    /// </summary>
    internal static RestRequest WithRequestId(this RestRequest request)
    {
        var requestId = AmbientRequestId.Current;

        return string.IsNullOrEmpty(requestId)
            ? request
            : request.AddHeader(RequestId.HeaderName, requestId);
    }
}
