namespace Orders.Infrastructure.Caching;

/// <summary>
/// The service's only door to Redis: serialization, timeout, key-prefix-safe telemetry.
/// </summary>
/// <remarks>
/// CONTRACT: Every method is fail-open and implementations MUST NOT throw. A response that
/// was correct without the cache stays correct with it, so a Redis outage costs latency and
/// a <c>BYPASS</c> header, never a 500. See [[x-cache-response-header]]
/// </remarks>
public interface ICacheGateway
{
    Task<CacheOutcome<T>> GetAsync<T>(string key, CancellationToken ct);

    Task SetAsync<T>(string key, T value, TimeSpan ttl, CancellationToken ct);

    Task InvalidateAsync(IReadOnlyCollection<string> keys, CancellationToken ct);

    /// <summary>
    /// Records <paramref name="key"/> in the caller's key index so
    /// <see cref="InvalidateUserKeysAsync"/> can find it later.
    /// CONTRACT: The index is required — per-user keys carry variable suffixes that cannot
    /// be reconstructed at invalidation time, and <c>KEYS</c>/<c>SCAN</c> is O(N) over the
    /// whole keyspace. See [[x-cache-response-header]]
    /// </summary>
    Task TrackKeyAsync(string cognitoSub, string key, CancellationToken ct);

    Task InvalidateUserKeysAsync(string cognitoSub, CancellationToken ct);
}
