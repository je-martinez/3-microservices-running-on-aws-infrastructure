using Orders.Application.Identity;
using Orders.Infrastructure.Caching;

namespace Orders.Infrastructure.Identity;

/// <summary>
/// Wraps the gRPC directory with the identity-mapping cache.
/// </summary>
/// <remarks>
/// Sits in FRONT of the response cache: every per-user key carries <c>user_id</c>, so this
/// resolution runs before a response key can be built — on hits too. Caching it is what
/// keeps a response-cache hit from still paying a gRPC round trip, and it is why
/// <c>CallerContextMiddleware</c>'s once-per-request resolution (which every read now pays
/// so its log lines carry <c>user_id</c>) stops being a network call on the hot path.
/// A decorator, so nothing that consumes <see cref="IUserDirectory"/> changes.
/// </remarks>
public class CachedUserDirectory : IUserDirectory
{
    private readonly IUserDirectory _inner;
    private readonly ICacheGateway _cache;

    public CachedUserDirectory(IUserDirectory inner, ICacheGateway cache)
    {
        _inner = inner;
        _cache = cache;
    }

    public async Task<string?> ResolveInternalUserIdAsync(
        string cognitoSub,
        CancellationToken ct = default)
    {
        var key = CacheKeys.Identity(cognitoSub);
        var cached = await _cache.GetAsync<string>(key, ct);
        if (cached.Result == CacheResult.Hit)
        {
            return cached.Value;
        }

        var resolved = await _inner.ResolveInternalUserIdAsync(cognitoSub, ct);

        // ONLY a positive resolution is cached. A null means "not found right now", which
        // a 1h TTL would freeze into "not found for an hour" — long enough to keep a
        // just-created user unknown to this service well after Users knows about them.
        if (resolved is not null)
        {
            await _cache.SetAsync(key, resolved, CacheKeys.IdentityTtl, ct);
        }

        return resolved;
    }

    /// <summary>
    /// Deliberately NOT cached.
    /// </summary>
    /// <remarks>
    /// The full profile carries the caller's email, name and delivery address, and it is
    /// only read on the order-creation write path — where the saving would be negligible
    /// and the PII sitting in Redis for an hour would not.
    /// </remarks>
    public Task<CallerProfile?> ResolveCallerAsync(
        string cognitoSub,
        CancellationToken ct = default) =>
        _inner.ResolveCallerAsync(cognitoSub, ct);
}
