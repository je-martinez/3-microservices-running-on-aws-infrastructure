namespace Orders.Infrastructure.Caching;

/// <summary>
/// The service's only door to Redis: serialization, timeout, key-prefix-safe telemetry.
/// </summary>
/// <remarks>
/// <para>
/// <b>Every method is fail-open.</b> It swallows Redis errors and timeouts rather than
/// propagating them. The cache may never break or degrade a read: a response that was
/// correct without the cache stays correct with it, and a Redis outage costs latency and a
/// <c>BYPASS</c> header, never a 500.
/// </para>
/// <para>
/// Implementations MUST NOT throw, in the same way <c>IMetricsPublisher</c> and
/// <c>IEventPublisher</c> must not — a backend being unreachable may never fail the
/// operation that used it.
/// </para>
/// </remarks>
public interface ICacheGateway
{
    Task<CacheOutcome<T>> GetAsync<T>(string key, CancellationToken ct);

    Task SetAsync<T>(string key, T value, TimeSpan ttl, CancellationToken ct);

    Task InvalidateAsync(IReadOnlyCollection<string> keys, CancellationToken ct);

    /// <summary>
    /// Records <paramref name="key"/> in the caller's key index so
    /// <see cref="InvalidateUserKeysAsync"/> can find it later.
    /// </summary>
    /// <remarks>
    /// Needed because per-user keys carry variable suffixes (the <c>t0</c>/<c>t1</c>
    /// tracking flag, an order id) that cannot be reconstructed at invalidation time —
    /// and because <c>KEYS</c>/<c>SCAN</c> is O(N) over the whole keyspace and
    /// unacceptable in production.
    /// </remarks>
    Task TrackKeyAsync(string cognitoSub, string key, CancellationToken ct);

    Task InvalidateUserKeysAsync(string cognitoSub, CancellationToken ct);
}
