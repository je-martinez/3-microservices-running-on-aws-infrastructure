using Microsoft.Extensions.Logging;

namespace Orders.Infrastructure.Caching;

/// <summary>
/// Turns a committed write into the set of cache entries it invalidated.
/// </summary>
public class CacheInvalidator : ICacheInvalidator
{
    private readonly ICacheGateway _cache;
    private readonly ILogger<CacheInvalidator> _logger;

    public CacheInvalidator(ICacheGateway cache, ILogger<CacheInvalidator> logger)
    {
        _cache = cache;
        _logger = logger;
    }

    public Task InvalidateCartAsync(string cognitoSub, CancellationToken ct) =>
        // The cart key carries user_id, which this layer does not have and must not make a
        // gRPC call to obtain — the write already committed, and a resolution failure here
        // would leave the entry stale for its full TTL for no gain. The per-user key INDEX
        // (a Redis SET of that user's live keys, keyed by sub alone) exists for precisely
        // this: it turns "forget this user's cart" into a lookup needing only the sub.
        //
        // The sweep also removes that user's my-orders and order-by-id entries. Broader
        // than the name suggests, and harmless: those entries are the caller's own, and
        // re-deriving one costs a single read. The alternative — reconstructing exact
        // key names — cannot work, because the order-by-id keys carry ids this layer
        // has never seen.
        Guarded("cart", () => _cache.InvalidateUserKeysAsync(cognitoSub, ct));

    public Task InvalidateOrderCreationAsync(string cognitoSub, CancellationToken ct) =>
        // One sweep of the user index removes BOTH the cart entry and every my-orders
        // entry (t0 and t1) in a single operation — the t0/t1 suffix is exactly why an
        // index is required here instead of naming keys, and why KEYS/SCAN is not an
        // option.
        //
        // The catalogue key is separate because it belongs to no user: stock changed for
        // everyone, so it cannot live in one user's index.
        Guarded("order_creation", async () =>
        {
            await _cache.InvalidateUserKeysAsync(cognitoSub, ct);
            await _cache.InvalidateAsync(new[] { CacheKeys.Products }, ct);
        });

    public Task InvalidateProductsAsync(CancellationToken ct) =>
        Guarded("products", () => _cache.InvalidateAsync(new[] { CacheKeys.Products }, ct));

    public Task InvalidateDeletedUserAsync(string cognitoSub, CancellationToken ct) =>
        // The index sweep covers every RESPONSE entry of this user — cart, both my-orders
        // variants, and each order-by-id key, whose ids this layer has never seen and
        // could not name. That is what the index is for; KEYS/SCAN is O(N) over the whole
        // keyspace and is not an option.
        //
        // The identity entry is deleted BY NAME because it is the one per-user key that
        // never enters the index: CachedUserDirectory stores it with a plain SetAsync,
        // and only CachedReadFilter calls TrackKeyAsync. Left behind, it would keep
        // resolving a deleted user's sub to a usr_ id for the rest of its 1h TTL — the
        // longest-lived entry in the service, and the one whose staleness outlasts every
        // response key the sweep above removes.
        //
        // Deliberately no catalogue invalidation: see the remarks on ICacheInvalidator.
        // The cascade restores no stock, so the catalogue is not stale.
        Guarded("deleted_user", async () =>
        {
            await _cache.InvalidateUserKeysAsync(cognitoSub, ct);
            await _cache.InvalidateAsync(new[] { CacheKeys.Identity(cognitoSub) }, ct);
        });

    /// <summary>
    /// Runs an invalidation and swallows any failure, logging it.
    /// </summary>
    /// <remarks>
    /// Every call site is AFTER the commit, so throwing here could only turn a persisted
    /// write into an error response — the write happened; the caller must be told so. The
    /// consequence of a swallowed failure is bounded by the entry's own TTL (60s for the
    /// cart, 2min for orders, 10min for the catalogue), which is what those TTLs are the
    /// safety net for.
    ///
    /// <para>
    /// <see cref="CacheGateway"/> is itself fail-open, so in practice nothing reaches this
    /// catch today. It stays because the guarantee belongs to THIS interface's contract,
    /// not to whichever gateway happens to be wired: a future implementation that throws
    /// must not be able to fail a paid-for order.
    /// </para>
    /// </remarks>
    private async Task Guarded(string scope, Func<Task> operation)
    {
        try
        {
            await operation();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(
                ex,
                "Cache invalidation failed; entries will expire by TTL {app_event} {reason} {cache_scope}",
                "cache_unavailable",
                "invalidate_failed",
                scope);
        }
    }
}
