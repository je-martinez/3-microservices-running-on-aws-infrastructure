using System.Text.Json.Serialization;
using Orders.Application.Tracking;

namespace Orders.Application.Orders;

/// <summary>
/// An order together with the tracking Tracking returned for it, used only when a
/// read is asked for <c>includeTracking=true</c>.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why a wrapper instead of a nullable property on <see cref="OrderDto"/>.</b>
/// Orders does not configure <c>JsonIgnoreCondition</c>, so a nullable member on
/// <c>OrderDto</c> would serialize as <c>"tracking": null</c> on <i>every</i> order
/// response — changing the payload of every existing caller to carry a field almost
/// none of them asked for. The whole point of defaulting <c>includeTracking</c> to
/// false is that the default response is untouched, so the tracking-bearing shape is
/// a separate type returned only on the opt-in path.
/// </para>
/// <para>
/// <see cref="Tracking"/> is a <see cref="TrackingDto"/> — a type Orders owns, mapped
/// from Tracking's response rather than forwarded as opaque JSON. That makes the shape
/// explicit in Orders' OpenAPI document and turns a contract divergence into a failing
/// test. See <see cref="TrackingDto"/> for the trade this accepts and how the drift is
/// detected.
/// </para>
/// </remarks>
/// <param name="Order">The order itself, in its usual shape.</param>
/// <param name="Tracking">
/// Tracking's raw payload for this order, or <c>null</c> when the order has no
/// tracking yet or Tracking could not be reached. A caller cannot distinguish those
/// two cases here, and does not need to: both mean "no tracking information to show".
/// </param>
public record OrderWithTrackingDto(
    [property: JsonPropertyName("order")] OrderDto Order,
    [property: JsonPropertyName("tracking")] TrackingDto? Tracking);
