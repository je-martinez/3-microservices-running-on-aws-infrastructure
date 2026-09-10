namespace Orders.Application.Tracking;

/// <summary>
/// The classified outcome of a <c>POST /v1/trackings/init-tracking</c> call.
/// </summary>
/// <remarks>
/// CONTRACT: A tracking failure must NOT fail the order. By the time this call runs the
/// order is committed and stock decremented, so erroring invites the customer to retry and
/// buy the same goods twice; an order missing a tracking row is a visible, backfillable gap,
/// a phantom double order is not.
/// CONTRACT: Keep this an enum, not an exception hierarchy — a returned value cannot escape
/// by accident, whereas an uncaught exception propagating out of order creation silently
/// turns a tracking hiccup into a failed order. See [[orders-service-design]]
/// </remarks>
public enum TrackingInitOutcome
{
    /// <summary>Tracking created the record (any 2xx).</summary>
    Created,

    /// <summary>
    /// HTTP 409 — Tracking's idempotency guard; the order is already tracked.
    /// CONTRACT: A success. Never treat it as an error, never retry it.
    /// </summary>
    AlreadyTracked,

    /// <summary>HTTP 404 — Tracking could not resolve the forwarded <c>x-user-id</c>.</summary>
    UnknownUser,

    /// <summary>HTTP 401 — no <c>x-user-id</c> was forwarded; a bug on this side.</summary>
    Unauthorized,

    /// <summary>Any other non-success status Tracking returned (5xx, 400, …).</summary>
    Failed,

    /// <summary>No HTTP response at all: refused, DNS failure, or a client timeout.</summary>
    Unreachable,
}

/// <summary>
/// Outcome of an <c>init-tracking</c> call, plus the raw status code when there was one.
/// <c>StatusCode</c> is <c>null</c> for <see cref="TrackingInitOutcome.Unreachable"/>,
/// where no response was ever received.
/// </summary>
public readonly record struct TrackingInitResult(TrackingInitOutcome Outcome, int? StatusCode)
{
    /// <summary>
    /// True when the order ends up tracked. The one predicate a caller needs, so nobody
    /// re-derives the "409 counts as success" rule.
    /// </summary>
    public bool IsTracked =>
        Outcome is TrackingInitOutcome.Created or TrackingInitOutcome.AlreadyTracked;
}
