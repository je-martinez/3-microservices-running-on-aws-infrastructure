namespace Orders.Infrastructure.Caching;

/// <summary>
/// No-op binding used when <c>CACHE_ENABLED=false</c>.
/// </summary>
/// <remarks>
/// With the kill switch off NO <see cref="ICacheGateway"/> is registered at all, but the
/// write services take an <see cref="ICacheInvalidator"/> as a constructor dependency —
/// so something must satisfy it or the container throws at the first cart write and the
/// kill switch takes the service down instead of merely disabling the cache.
///
/// <para>
/// A separate no-op rather than a <see cref="CacheInvalidator"/> over
/// <see cref="NoopCacheGateway"/>: with nothing cached there is nothing to invalidate, so
/// the honest implementation is to do nothing rather than to route calls into a gateway
/// that discards them.
/// </para>
/// </remarks>
public class NoopCacheInvalidator : ICacheInvalidator
{
    public Task InvalidateCartAsync(string cognitoSub, CancellationToken ct) => Task.CompletedTask;

    public Task InvalidateOrderCreationAsync(string cognitoSub, CancellationToken ct) =>
        Task.CompletedTask;

    public Task InvalidateProductsAsync(CancellationToken ct) => Task.CompletedTask;

    public Task InvalidateDeletedUserAsync(string cognitoSub, CancellationToken ct) =>
        Task.CompletedTask;
}
