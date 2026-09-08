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
        // CONTRACT: Sweep the per-user key index, never resolve user_id with a gRPC call —
        // the write already committed, and a resolution failure would leave the entry stale
        // for its full TTL. The sweep also takes my-orders and order-by-id, whose ids this
        // layer has never seen; re-deriving one costs a single read.
        // See [[x-cache-response-header]]
        Guarded("cart", () => _cache.InvalidateUserKeysAsync(cognitoSub, ct));

    public Task InvalidateOrderCreationAsync(string cognitoSub, CancellationToken ct) =>
        // CONTRACT: One index sweep covers the cart and every my-orders variant; the
        // t0/t1 suffix is why keys cannot be named and KEYS/SCAN is not an option. The
        // catalogue key is separate — stock changed for everyone, so it belongs to no user.
        Guarded("order_creation", async () =>
        {
            await _cache.InvalidateUserKeysAsync(cognitoSub, ct);
            await _cache.InvalidateAsync(new[] { CacheKeys.Products }, ct);
        });

    public Task InvalidateProductsAsync(CancellationToken ct) =>
        Guarded("products", () => _cache.InvalidateAsync(new[] { CacheKeys.Products }, ct));

    public Task InvalidateDeletedUserAsync(
        string cognitoSub, string? userId, CancellationToken ct) =>
        // CONTRACT: Sweep BOTH identities. Keys are built from whatever the client put in
        // x-user-id, which the middleware stores verbatim and GetUserById accepts either
        // way, so sweeping only the sub leaves a deleted user's usr_-keyed entries serving
        // their orders for the rest of their TTL.
        // CONTRACT: Delete the identity entry BY NAME — it is the one per-user key that
        // never enters the index (CachedUserDirectory writes it with a plain SetAsync), and
        // left behind it resolves a deleted user's identifier for a further hour, outlasting
        // every response key the sweep removes. No catalogue invalidation: the cascade
        // restores no stock. See [[x-cache-response-header]]
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
    /// CONTRACT: Never throw from here. Every call site is AFTER the commit, so a throw
    /// turns a persisted write into an error response. A swallowed failure is bounded by the
    /// entry's own TTL. Keep the catch even though <see cref="CacheGateway"/> is fail-open —
    /// the guarantee belongs to this interface, not to whichever gateway is wired.
    /// See [[x-cache-response-header]]
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
