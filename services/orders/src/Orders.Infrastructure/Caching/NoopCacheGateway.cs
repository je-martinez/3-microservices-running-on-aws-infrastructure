namespace Orders.Infrastructure.Caching;

/// <summary>
/// No-op binding for suites that must not reach Redis.
/// CONTRACT: Every lookup answers <see cref="CacheOutcome{T}.Bypass"/> — the answer a real
/// gateway gives when Redis is unreachable — so a consumer wired to this behaves as it does
/// during an outage. See [[x-cache-response-header]]
/// </summary>
public class NoopCacheGateway : ICacheGateway
{
    public Task<CacheOutcome<T>> GetAsync<T>(string key, CancellationToken ct) =>
        Task.FromResult(CacheOutcome<T>.Bypass());

    public Task SetAsync<T>(string key, T value, TimeSpan ttl, CancellationToken ct) =>
        Task.CompletedTask;

    public Task InvalidateAsync(IReadOnlyCollection<string> keys, CancellationToken ct) =>
        Task.CompletedTask;

    public Task TrackKeyAsync(string cognitoSub, string key, CancellationToken ct) =>
        Task.CompletedTask;

    public Task InvalidateUserKeysAsync(string cognitoSub, CancellationToken ct) =>
        Task.CompletedTask;
}
