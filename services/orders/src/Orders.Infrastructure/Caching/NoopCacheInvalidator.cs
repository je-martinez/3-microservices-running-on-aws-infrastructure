namespace Orders.Infrastructure.Caching;

/// <summary>
/// No-op binding used when <c>CACHE_ENABLED=false</c>.
/// CONTRACT: Keep this registered under the kill switch. No <see cref="ICacheGateway"/> is
/// registered then, but the write services depend on <see cref="ICacheInvalidator"/>, so
/// without it the container throws at the first cart write and the kill switch takes the
/// service down instead of disabling the cache. See [[x-cache-response-header]]
/// </summary>
public class NoopCacheInvalidator : ICacheInvalidator
{
    public Task InvalidateCartAsync(string cognitoSub, CancellationToken ct) => Task.CompletedTask;

    public Task InvalidateOrderCreationAsync(string cognitoSub, CancellationToken ct) =>
        Task.CompletedTask;

    public Task InvalidateProductsAsync(CancellationToken ct) => Task.CompletedTask;

    public Task InvalidateDeletedUserAsync(
        string cognitoSub, string? userId, CancellationToken ct) => Task.CompletedTask;
}
