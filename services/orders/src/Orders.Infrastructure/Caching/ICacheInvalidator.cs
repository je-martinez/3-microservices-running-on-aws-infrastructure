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
}
