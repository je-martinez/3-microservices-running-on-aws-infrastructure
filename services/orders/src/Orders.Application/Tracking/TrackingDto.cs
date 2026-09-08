using System.Text.Json.Serialization;

namespace Orders.Application.Tracking;

/// <summary>
/// One tracking as Tracking returns it, mapped into a type Orders owns.
/// CONTRACT: A deliberate copy of <c>services/tracking-go/openapi.yaml</c> — change them
/// together; a divergence must fail a contract test, not turn up empty in a UI. Keep
/// deserialization tolerant so a Tracking deploy adding a field cannot break a read in
/// production. See [[ADR-0003-grpc-inter-service]]
/// </summary>
public record TrackingDto(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("user_id")] string UserId,
    [property: JsonPropertyName("order_id")] string OrderId,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("datetime")] string Datetime,
    [property: JsonPropertyName("history")] IReadOnlyList<TrackingHistoryEntryDto> History);

/// <summary>
/// One status transition in a tracking's history.
/// CONTRACT: The tracking's identifier is <c>tracking_id</c> here, not <c>id</c>.
/// </summary>
public record TrackingHistoryEntryDto(
    [property: JsonPropertyName("tracking_id")] string TrackingId,
    [property: JsonPropertyName("user_id")] string UserId,
    [property: JsonPropertyName("order_id")] string OrderId,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("datetime")] string Datetime);

/// <summary>
/// The batch read's envelope: <c>{ "trackings": [...] }</c>. An object rather than a bare
/// array, mirroring Tracking — a top-level array leaves no room to add anything beside it.
/// </summary>
public record TrackingBatchDto(
    [property: JsonPropertyName("trackings")] IReadOnlyList<TrackingDto> Trackings);
