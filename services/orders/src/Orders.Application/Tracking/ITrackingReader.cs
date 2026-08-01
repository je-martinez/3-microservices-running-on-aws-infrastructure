using System.Text.Json;

namespace Orders.Application.Tracking;

/// <summary>
/// Port for reading delivery trackings from the Tracking service, so an order read can
/// be answered together with its tracking.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why a sibling port instead of extending <see cref="ITrackingInitiator"/>.</b>
/// Initiation and reading are consumed by different callers: order creation needs only
/// the write, the order reads need only the read. Keeping them apart means the creation
/// path's dependency does not widen every time the read side grows, and a test double
/// for one capability does not have to stub the other. The single HTTP implementation
/// in Infrastructure implements both — one typed client, one base address, two ports.
/// </para>
/// <para>
/// <b>The payload is mapped into a type Orders owns</b> (<see cref="TrackingDto"/>),
/// rather than forwarded as opaque JSON. Orders therefore declares the shape it expects,
/// and a divergence from Tracking's actual contract surfaces as a failing test instead
/// of a field that quietly arrives empty. The cost — a field added in Tracking must be
/// added here too — is accepted in exchange for that detection.
/// </para>
/// <para>
/// Deserialization stays <b>tolerant at runtime</b>: unknown members are ignored, so a
/// Tracking deploy that adds a field cannot break an Orders read in production. Catching
/// the drift is the contract tests' job, not the deserializer's.
/// </para>
/// <para>
/// <b>This port never throws for a downstream failure.</b> Order reads must keep working
/// when Tracking is down, slow, or erroring — the tracking section of the response is
/// simply absent. Every such outcome is reported as <c>null</c>, mirroring the reasoning
/// in <see cref="TrackingInitOutcome"/>: a returned value cannot escape a caller by
/// accident the way an exception can.
/// </para>
/// </remarks>
public interface ITrackingReader
{
    /// <summary>
    /// Reads the caller's trackings for the given order ids, in one batch call.
    /// </summary>
    /// <param name="orderIds">
    /// The <c>ord_</c> ids to look up. An empty sequence short-circuits without a
    /// network call.
    /// </param>
    /// <param name="cognitoSub">
    /// The caller's Cognito sub, exactly as Orders received it from the gateway in
    /// <c>x-user-id</c>. Forwarded as a header — the same mechanism initiation uses.
    /// <b>Ownership is enforced by Tracking</b>, which filters by <c>cognito_sub</c> and
    /// silently omits ids belonging to anyone else; Orders adds no ownership check of
    /// its own here and must not try to.
    /// </param>
    /// <returns>
    /// The trackings Tracking returned, keyed by <c>order_id</c> for the caller to look
    /// up per order. Empty when there is nothing to report — no ids requested, Tracking
    /// unreachable, timed out, a non-success status, or an unreadable body. The caller
    /// treats an absent entry as "no tracking information available", never as an error,
    /// and cannot distinguish "no tracking yet" from "Tracking is down" — by design,
    /// since neither changes what it can show.
    /// </returns>
    Task<IReadOnlyDictionary<string, TrackingDto>> GetTrackingsAsync(
        IReadOnlyCollection<string> orderIds,
        string cognitoSub,
        CancellationToken ct = default);
}
