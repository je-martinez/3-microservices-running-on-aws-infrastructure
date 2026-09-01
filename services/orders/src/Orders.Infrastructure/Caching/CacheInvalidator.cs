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

    public Task InvalidateDeletedUserAsync(
        string cognitoSub, string? userId, CancellationToken ct) =>
        // BOTH identities are swept, because a cache key here is built from whichever
        // identifier the CLIENT put in x-user-id — not from a canonical one.
        // CallerContextMiddleware stores that header verbatim, and Users' GetUserById
        // accepts either a usr_ id or a sub, so both spellings genuinely occur. Sweeping
        // only the sub deleted a key that had never existed while the deleted user's real
        // usr_-keyed entries kept serving their orders for the rest of their TTL.
        //
        // The index sweep covers every RESPONSE entry under an identity — cart, both
        // my-orders variants, and each order-by-id key, whose ids this layer has never
        // seen and could not name. That is what the index is for; KEYS/SCAN is O(N) over
        // the whole keyspace and is not an option.
        //
        // The identity entry is deleted BY NAME because it is the one per-user key that
        // never enters the index: CachedUserDirectory stores it with a plain SetAsync,
        // and only CachedReadFilter calls TrackKeyAsync. Left behind, it would keep
        // resolving a deleted user's identifier to a usr_ id for the rest of its 1h TTL —
        // the longest-lived entry in the service, and the one whose staleness outlasts
        // every response key the sweep above removes.
        //
        // Deliberately no catalogue invalidation: see the remarks on ICacheInvalidator.
        // The cascade restores no stock, so the catalogue is not stale.
        //
        // KNOWN TRADE-OFF (see ICacheInvalidator): sweeping both is correct but not
        // frugal — the same person occupies two key sets rather than one. Normalizing
        // keys onto a canonical identity was considered and not chosen.
        Guarded("deleted_user", async () =>
        {
            // Deduplicated, and the degenerate case is the COMMON one on the direct
            // path: the E2E harness sends the usr_ id as both fields, so both segments
            // are identical and a naive pass would issue every DELETE twice on a hot
            // route. An empty/whitespace user_id is dropped for a different reason —
            // the route 400s on it today, but a key built from an empty segment belongs
            // to nobody and this layer must not depend on that guard staying put.
            var identities = Identities(cognitoSub, userId);

            foreach (var identity in identities)
            {
                await _cache.InvalidateUserKeysAsync(identity, ct);
            }

            await _cache.InvalidateAsync(
                identities.Select(CacheKeys.Identity).ToArray(), ct);
        });

    /// <summary>
    /// The distinct, non-empty identifiers a deleted user's keys may be filed under,
    /// in a stable order (sub first).
    /// </summary>
    private static IReadOnlyList<string> Identities(string cognitoSub, string? userId)
    {
        var identities = new List<string>(2);

        if (!string.IsNullOrWhiteSpace(cognitoSub))
        {
            identities.Add(cognitoSub);
        }

        // Ordinal, not the current culture: these are opaque identifiers, and a
        // culture-sensitive comparison could call two distinct ids equal and skip a sweep.
        if (!string.IsNullOrWhiteSpace(userId)
            && !string.Equals(userId, cognitoSub, StringComparison.Ordinal))
        {
            identities.Add(userId);
        }

        return identities;
    }

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
