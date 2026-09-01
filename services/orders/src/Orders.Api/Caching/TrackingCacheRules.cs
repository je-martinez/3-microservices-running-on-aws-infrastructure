using Orders.Application.Orders;

namespace Orders.Api.Caching;

/// <summary>
/// The <see cref="CacheStorePredicate"/>s for the two order reads, which decline to store a
/// response whose tracking is missing.
/// </summary>
/// <remarks>
/// <para>
/// <b>The defect these exist for.</b> A tracking record is created ASYNCHRONOUSLY:
/// <c>CreateOrderService</c> calls <c>InitTrackingAsync</c> deliberately AFTER its own
/// transaction commits, so there is a real window in which the order exists and its tracking
/// does not. A <c>?includeTracking=true</c> read landing in that window legitimately answers
/// <c>tracking: null</c> — and storing that answer freezes a momentary absence into a fact for
/// the whole 2-minute TTL, long after Tracking has the record. Every read in that window then
/// serves a HIT with a null tracking that has been wrong for minutes.
/// </para>
/// <para>
/// <b>The principle is already applied elsewhere in this service.</b>
/// <c>CachedUserDirectory</c> caches only a POSITIVE identity resolution, for exactly this
/// reason: a null there means "not found right now", which a 1h TTL would turn into "not found
/// for an hour". A transient absence is not a cacheable fact. Same shape, different family.
/// </para>
/// <para>
/// <b>Scope: the <c>t1</c> variants only.</b> These predicates are attached to the routes but
/// fire on the response VALUE, and the <c>t0</c> shapes (<c>OrderDto</c> and
/// <c>IReadOnlyList&lt;OrderDto&gt;</c>) carry no tracking at all — they are not
/// <c>OrderWithTrackingDto</c>, so they fall through to the default <c>true</c> and keep
/// caching exactly as before. Matching on the TYPE rather than on the query string is what
/// makes that automatic: there is no second place to keep in step with the key builder's
/// <c>includeTracking</c> parsing.
/// </para>
/// </remarks>
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
    /// <para>
    /// <b>Why "every", not "any".</b> The entry is one blob covering the whole list: it is
    /// stored or not stored as a unit, and a HIT replays all of it. So the question is not
    /// "is this list mostly good?" but "is any element of it a momentary absence I would be
    /// freezing?". The case to reason about is a user with one brand-new order and nine old
    /// ones. Under an "any tracking present" rule that list stores — nine trackings are
    /// there — and the ONE order the user is actually watching, the one just placed, is
    /// pinned at <c>tracking: null</c> for two minutes. That is precisely the bug, and it is
    /// the worst instance of it, because the freshly-created order is the only one anybody
    /// is refreshing the page for.
    /// </para>
    /// <para>
    /// <b>What "every" costs.</b> A list containing an order that will NEVER have a tracking
    /// (Tracking dropped the event, or is down) becomes permanently uncacheable for that
    /// user. That is a performance cost with no correctness cost, and it is bounded: it
    /// affects one user's <c>t1</c> key, while their <c>t0</c> list, their cart, the
    /// catalogue and their per-order reads all still cache. The alternative trade — freezing
    /// a wrong answer onto the order the user is watching — is a correctness cost, and this
    /// service resolves that trade the same way in <c>CachedUserDirectory</c>: decline to
    /// cache, pay the miss.
    /// </para>
    /// <para>
    /// An EMPTY list stores. There is no absent tracking in it to be wrong about, and it is
    /// the shape a brand-new user reads repeatedly.
    /// </para>
    /// </remarks>
    public static bool AllOrdersHaveTracking(object value) =>
        value is not IEnumerable<OrderWithTrackingDto> list
        || list.All(o => o.Tracking is not null);
}
