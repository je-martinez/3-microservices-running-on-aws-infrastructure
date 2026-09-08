using Orders.Application.Orders;

namespace Orders.Api.Caching;

/// <summary>
/// The <see cref="CacheStorePredicate"/>s for the two order reads, which decline to store a
/// response whose tracking is missing.
/// CONTRACT: A transient absence is not a cacheable fact. Tracking is created AFTER order
/// creation commits, so a read in that window legitimately answers <c>tracking: null</c> —
/// storing it freezes that into a HIT wrong for the whole 2-minute TTL.
/// CONTRACT: Match on the response TYPE, not the query string. The <c>t0</c> shapes carry no
/// tracking and fall through to the default, so there is no second place to keep in step with
/// the key builder's <c>includeTracking</c> parsing. See [[x-cache-response-header]]
/// </summary>
public static class TrackingCacheRules
{
    /// <summary>
    /// <c>GET /v1/orders/{orderId}?includeTracking=true</c> — store only when the tracking
    /// arrived.
    /// </summary>
    public static bool SingleOrderHasTracking(object value) =>
        value is not OrderWithTrackingDto single || single.Tracking is not null;

    /// <summary>
    /// <c>GET /v1/orders/my-orders?includeTracking=true</c> — store only when EVERY order in
    /// the list has its tracking.
    /// </summary>
    /// <remarks>
    /// CONTRACT: EVERY, not any. The entry is one blob stored as a unit, so a user with one
    /// brand-new order and nine old ones would store under an "any" rule — pinning the order
    /// they are actually refreshing the page for at <c>tracking: null</c> for two minutes.
    /// The cost is that an order which never gets a tracking makes that user's <c>t1</c> key
    /// permanently uncacheable: a bounded performance cost, not a correctness one. An empty
    /// list stores — nothing in it to be wrong about. See [[x-cache-response-header]]
    /// </remarks>
    public static bool AllOrdersHaveTracking(object value) =>
        value is not IEnumerable<OrderWithTrackingDto> list
        || list.All(o => o.Tracking is not null);
}
