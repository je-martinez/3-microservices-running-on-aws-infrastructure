using System.Text.Json;

namespace Orders.Application.Tracking;

/// <summary>
/// Port for reading delivery trackings, so an order read is answered with its tracking.
/// CONTRACT: Never throw for a downstream failure — order reads must keep working when
/// Tracking is down, so every such outcome is reported as <c>null</c>.
/// CONTRACT: Map into <see cref="TrackingDto"/>, never forward opaque JSON, so a contract
/// divergence fails a test instead of arriving empty. See [[ADR-0003-grpc-inter-service]]
/// </summary>
public interface ITrackingReader
{
    /// <summary>Reads the caller's trackings for the given order ids, in one batch.</summary>
    /// <param name="orderIds">The <c>ord_</c> ids; empty short-circuits the call.</param>
    /// <param name="cognitoSub">
    /// The caller's sub as received in <c>x-user-id</c>, forwarded as a header.
    /// CONTRACT: Ownership is enforced by TRACKING, which filters by <c>cognito_sub</c>.
    /// Orders adds no check of its own and must not try to.
    /// See [[ADR-0003-grpc-inter-service]]
    /// </param>
    /// <returns>
    /// The trackings, keyed by <c>order_id</c>. Empty when Tracking is unreachable, timed
    /// out, or returned an unreadable body — an absent entry is never an error.
    /// </returns>
    Task<IReadOnlyDictionary<string, TrackingDto>> GetTrackingsAsync(
        IReadOnlyCollection<string> orderIds,
        string cognitoSub,
        CancellationToken ct = default);
}
