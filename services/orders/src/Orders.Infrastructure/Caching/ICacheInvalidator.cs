namespace Orders.Infrastructure.Caching;

/// <summary>
/// The write path's view of the cache: what to forget, named by the business event that
/// makes it stale rather than by key.
/// </summary>
/// <remarks>
/// <para>
/// Deliberately NOT <see cref="ICacheGateway"/> with a key list at each call site. The
/// write services would then each have to know which key families a given write
/// invalidates — and the day a fourth key is added under my-orders, three call sites need
/// editing and one of them is missed. Naming the EVENT keeps that knowledge in one
/// implementation.
/// </para>
/// <para>
/// Implementations MUST NOT throw. Every call site is AFTER the commit, so a throw could
/// only turn a persisted write into an error response. The cache may never break a write,
/// exactly as it may never break a read.
/// </para>
/// <para>
/// Lives in Infrastructure rather than <c>Orders.Application.Abstractions</c> because
/// <see cref="ICacheGateway"/> and <see cref="CacheKeys"/> do: an Application-side
/// interface implemented here would be fine, but its ONLY consumers are the two write
/// services and one endpoint, all of which already reference Infrastructure. Putting the
/// port where its siblings live keeps one caching namespace rather than two.
/// </para>
/// </remarks>
public interface ICacheInvalidator
{
    /// <summary>Forgets the caller's cart entry. For PUT and DELETE /v1/cart.</summary>
    Task InvalidateCartAsync(string cognitoSub, CancellationToken ct);

    /// <summary>
    /// Forgets everything a completed order makes stale: the caller's cart (consumed by
    /// the order), all their my-orders entries (t0 and t1 both), and the shared product
    /// catalogue (stock changed).
    /// </summary>
    Task InvalidateOrderCreationAsync(string cognitoSub, CancellationToken ct);

    /// <summary>Forgets the shared product catalogue entry. For the E2E restock.</summary>
    Task InvalidateProductsAsync(CancellationToken ct);

    /// <summary>
    /// Forgets everything belonging to a user whose account was deleted: every response
    /// entry of theirs (cart, all my-orders variants, all order-by-id variants) plus their
    /// identity mapping. For the <c>DELETE /v1/orders/by-user</c> cascade.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Takes the <c>cognito_sub</c> twice over, in effect: the sub keys BOTH the per-user
    /// response index and the identity entry. The <c>user_id</c> is deliberately absent
    /// from the signature — no key is reachable by it alone, and the index already spans
    /// every response key that carries it.
    /// </para>
    /// <para>
    /// The identity entry needs naming explicitly because it is the one per-user key NOT
    /// in the index: <c>CachedUserDirectory</c> writes it with a bare <c>SetAsync</c>,
    /// while only <c>CachedReadFilter</c> calls <c>TrackKeyAsync</c>. Sweeping the index
    /// alone would drop every response of a deleted user and then keep resolving their sub
    /// to a <c>usr_</c> id for up to an hour.
    /// </para>
    /// <para>
    /// The shared product catalogue is deliberately NOT invalidated. The cascade
    /// soft-deletes orders, lines and carts and never touches <c>product.units_in_stock</c>
    /// — unlike the E2E cleanup, which restocks and therefore must. Dropping a key every
    /// other user reads, to reflect a change that did not happen, would cold-start the
    /// catalogue for everybody for nothing.
    /// </para>
    /// </remarks>
    Task InvalidateDeletedUserAsync(string cognitoSub, CancellationToken ct);
}
