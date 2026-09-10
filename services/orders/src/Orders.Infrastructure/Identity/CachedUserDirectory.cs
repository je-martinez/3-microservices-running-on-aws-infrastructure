using Orders.Application.Identity;
using Orders.Infrastructure.Caching;

namespace Orders.Infrastructure.Identity;

/// <summary>
/// Wraps the gRPC directory with the identity-mapping cache. It sits in FRONT of the response
/// cache — every per-user key carries <c>user_id</c>, so this resolution runs before a key
/// can be built, and caching it is what stops a response-cache hit paying a gRPC round trip.
/// </summary>
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
    /// WARNING: The full profile carries email, name and address (PII). It is read only on
    /// the write path, so caching would save little and leave PII in Redis for an hour.
    /// See [[logging-context]]
    /// </summary>
    public Task<CallerProfile?> ResolveCallerAsync(
        string cognitoSub,
        CancellationToken ct = default) =>
        _inner.ResolveCallerAsync(cognitoSub, ct);
}
