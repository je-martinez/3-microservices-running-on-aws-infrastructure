using System.Text.Json.Serialization;

namespace Orders.Application.Tracking;

/// <summary>
/// One tracking as Tracking's read endpoints return it, mapped into a type Orders owns.
/// </summary>
/// <remarks>
/// <para>
/// <b>This is a copy of another service's contract, and that is the point.</b> Orders
/// declares the shape it expects so a divergence becomes a test failure rather than a
/// field that quietly turns up empty in a UI. The cost is that Tracking adding a field
/// means adding it here too — accepted deliberately, in exchange for the drift being
/// caught in CI.
/// </para>
/// <para>
/// <b>Runtime is tolerant; CI is strict.</b> System.Text.Json ignores members it does
/// not recognise by default, and that default is kept: a Tracking deploy that adds a
/// field must never break an Orders read in production. Detection is the tests' job,
/// not the deserializer's — see the contract tests, which compare this type against
/// both a committed fixture and Tracking's live response.
/// </para>
/// <para>
/// Mirrors <c>TrackingResponse</c> in
/// <c>services/tracking/src/features/tracking/api/schemas.py</c>. Change them together.
/// </para>
/// </remarks>
public record TrackingDto(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("user_id")] string UserId,
    [property: JsonPropertyName("order_id")] string OrderId,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("datetime")] string Datetime,
    [property: JsonPropertyName("history")] IReadOnlyList<TrackingHistoryEntryDto> History);

/// <summary>
/// One status transition in a tracking's history.
/// </summary>
/// <remarks>
/// Mirrors <c>TrackingHistoryEntryResponse</c> in Tracking's <c>schemas.py</c>. Note the
/// key difference from <see cref="TrackingDto"/>: the tracking's own identifier is
/// <c>tracking_id</c> here, not <c>id</c>.
/// </remarks>
public record TrackingHistoryEntryDto(
    [property: JsonPropertyName("tracking_id")] string TrackingId,
    [property: JsonPropertyName("user_id")] string UserId,
    [property: JsonPropertyName("order_id")] string OrderId,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("datetime")] string Datetime);

/// <summary>
/// The batch read's envelope: <c>{ "trackings": [...] }</c>.
/// </summary>
/// <remarks>
/// An object rather than a bare array, mirroring Tracking's own choice — its schema
/// documents that a bare top-level array leaves no room to add anything beside it later.
/// </remarks>
public record TrackingBatchDto(
    [property: JsonPropertyName("trackings")] IReadOnlyList<TrackingDto> Trackings);
