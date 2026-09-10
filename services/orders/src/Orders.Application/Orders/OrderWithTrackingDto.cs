using System.Text.Json.Serialization;
using Orders.Application.Tracking;

namespace Orders.Application.Orders;

/// <summary>
/// An order plus its tracking, returned only for <c>includeTracking=true</c>.
/// CONTRACT: A separate wrapper type, NOT a nullable member on <see cref="OrderDto"/> — with
/// no <c>JsonIgnoreCondition</c> configured, that would serialize <c>"tracking": null</c> on
/// EVERY order response and change the payload for every existing caller.
/// See [[x-cache-response-header]]
/// </summary>
public record OrderWithTrackingDto(
    [property: JsonPropertyName("order")] OrderDto Order,
    [property: JsonPropertyName("tracking")] TrackingDto? Tracking);
