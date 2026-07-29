namespace Orders.Application.Tracking;

/// <summary>
/// The classified outcome of a <c>POST /v1/trackings/init-tracking</c> call.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why this is an enum and not an exception hierarchy.</b> The caller (order
/// creation) needs to branch on the outcome, and the most likely branch — "it did not
/// work, carry on anyway" — is not exceptional at all. Modelling failures as exceptions
/// would force the one call site to wrap the call in try/catch purely for control flow,
/// and would make the non-fatal decision easy to lose in a later refactor: an uncaught
/// exception propagating out of order creation would silently turn a tracking hiccup
/// into a failed order. A returned value cannot escape by accident.
/// </para>
/// <para>
/// <b>Why a tracking failure must not fail the order.</b> By the time this call is made
/// the order is already committed: stock has been decremented and the customer's intent
/// is recorded. Failing the request at that point would report an error for an order that
/// genuinely exists, inviting the customer to retry and buy the same goods twice, while
/// leaving the decremented stock behind. The opposite risk is real but smaller and
/// recoverable: an order with no tracking record is a visible, backfillable gap, whereas
/// a phantom double order is not. This is the same reasoning that makes
/// <c>IEventPublisher</c> a non-blocking seam. The trade-off is explicit: we accept
/// orders that may temporarily lack a tracking row, and we make that observable through
/// the returned outcome and a logged failure rather than through a failed HTTP response.
/// </para>
/// </remarks>
public enum TrackingInitOutcome
{
    /// <summary>Tracking created the record (any 2xx).</summary>
    Created,

    /// <summary>
    /// HTTP 409 — the order already has a tracking record. This is Tracking's idempotency
    /// guard, and from Orders' perspective it is a <b>success</b>: the desired end state
    /// (this order is tracked) holds. Never treat it as an error, never retry it.
    /// </summary>
    AlreadyTracked,

    /// <summary>
    /// HTTP 404 — Tracking could not resolve the forwarded <c>x-user-id</c> to a known user.
    /// </summary>
    UnknownUser,

    /// <summary>
    /// HTTP 401 — Tracking received no <c>x-user-id</c>. Indicates a bug on this side
    /// (the header was not forwarded), not a caller problem.
    /// </summary>
    Unauthorized,

    /// <summary>
    /// Any other non-success status Tracking returned (5xx, 400, …).
    /// </summary>
    Failed,

    /// <summary>
    /// The call never produced an HTTP response: connection refused, DNS failure, or the
    /// client-side timeout elapsed.
    /// </summary>
    Unreachable,
}

/// <summary>
/// Outcome of an <c>init-tracking</c> call, plus the raw status code when there was one.
/// </summary>
/// <param name="Outcome">The classified outcome.</param>
/// <param name="StatusCode">
/// The HTTP status Tracking returned, or <c>null</c> for
/// <see cref="TrackingInitOutcome.Unreachable"/> (no response was ever received).
/// </param>
public readonly record struct TrackingInitResult(TrackingInitOutcome Outcome, int? StatusCode)
{
    /// <summary>
    /// True when the order ends up tracked — <see cref="TrackingInitOutcome.Created"/> or
    /// <see cref="TrackingInitOutcome.AlreadyTracked"/>. The single predicate a caller
    /// needs in order to avoid re-deriving the "409 counts as success" rule.
    /// </summary>
    public bool IsTracked =>
        Outcome is TrackingInitOutcome.Created or TrackingInitOutcome.AlreadyTracked;
}
