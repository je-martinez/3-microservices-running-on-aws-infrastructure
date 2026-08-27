using Microsoft.Extensions.Logging.Abstractions;
using Orders.Infrastructure.Caching;

namespace Orders.Tests.Infrastructure;

/// <summary>
/// <see cref="CacheInvalidator.InvalidateDeletedUserAsync"/> — the account-deletion leg.
/// </summary>
/// <remarks>
/// The endpoint test proves the entries are gone through the HTTP surface. This proves
/// the two properties that surface cannot show: exactly WHICH keys are named (the
/// catalogue must not be among them, and no route would reveal an extra delete of a
/// shared key), and that a Redis fault is swallowed rather than propagated — the
/// difference between a cascade Users records as done and an account deletion that fails
/// for a person whose orders are already erased.
/// </remarks>
public class CacheInvalidatorTests
{
    private static CacheInvalidator Invalidator(ICacheGateway gateway) =>
        new(gateway, NullLogger<CacheInvalidator>.Instance);

    [Fact]
    public async Task Deleting_a_user_sweeps_their_index_and_their_identity_entry()
    {
        var spy = new SpyGateway();

        await Invalidator(spy).InvalidateDeletedUserAsync("sub-gone", default);

        // The response entries, by index: their exact names carry order ids and a t0/t1
        // suffix this layer has never seen, so they are unreachable any other way.
        Assert.Equal(["sub-gone"], spy.SweptSubs);
        // The identity entry, by name: the one per-user key that never enters the index.
        Assert.Equal([CacheKeys.Identity("sub-gone")], spy.DeletedKeys);
    }

    [Fact]
    public async Task Deleting_a_user_does_not_touch_the_product_catalogue()
    {
        // The cascade restores no stock, so the catalogue is not stale. It is a SHARED
        // key: dropping it would cold-start the catalogue for every other user to reflect
        // a change that did not happen. This is the assertion that fails if someone later
        // copies InvalidateOrderCreationAsync — which does invalidate it, correctly, since
        // an order DOES decrement stock.
        var spy = new SpyGateway();

        await Invalidator(spy).InvalidateDeletedUserAsync("sub-gone", default);

        Assert.DoesNotContain(CacheKeys.Products, spy.DeletedKeys);
    }

    [Fact]
    public async Task A_redis_failure_never_propagates_to_the_cascade()
    {
        // The rows are ALREADY deleted when this runs. Throwing here would tell Users the
        // cascade did not happen when it did, and Users would then fail the whole account
        // deletion for the person. No exception may escape, whichever call faults.
        await Invalidator(new ThrowingGateway()).InvalidateDeletedUserAsync("sub-gone", default);
    }

    /// <summary>Records what was asked of the cache, without a Redis.</summary>
    private sealed class SpyGateway : ICacheGateway
    {
        public List<string> SweptSubs { get; } = [];
        public List<string> DeletedKeys { get; } = [];

        public Task<CacheOutcome<T>> GetAsync<T>(string key, CancellationToken ct) =>
            Task.FromResult(CacheOutcome<T>.Miss());

        public Task SetAsync<T>(string key, T value, TimeSpan ttl, CancellationToken ct) =>
            Task.CompletedTask;

        public Task InvalidateAsync(IReadOnlyCollection<string> keys, CancellationToken ct)
        {
            DeletedKeys.AddRange(keys);
            return Task.CompletedTask;
        }

        public Task TrackKeyAsync(string cognitoSub, string key, CancellationToken ct) =>
            Task.CompletedTask;

        public Task InvalidateUserKeysAsync(string cognitoSub, CancellationToken ct)
        {
            SweptSubs.Add(cognitoSub);
            return Task.CompletedTask;
        }
    }

    /// <summary>
    /// Fails on BOTH invalidation paths.
    /// </summary>
    /// <remarks>
    /// The real <see cref="CacheGateway"/> is itself fail-open and would swallow these,
    /// so a gateway that throws is the only way to exercise the invalidator's OWN
    /// guarantee — which is what the endpoint depends on, not the gateway's.
    /// </remarks>
    private sealed class ThrowingGateway : ICacheGateway
    {
        public Task<CacheOutcome<T>> GetAsync<T>(string key, CancellationToken ct) =>
            throw new InvalidOperationException("redis down");

        public Task SetAsync<T>(string key, T value, TimeSpan ttl, CancellationToken ct) =>
            throw new InvalidOperationException("redis down");

        public Task InvalidateAsync(IReadOnlyCollection<string> keys, CancellationToken ct) =>
            throw new InvalidOperationException("redis down");

        public Task TrackKeyAsync(string cognitoSub, string key, CancellationToken ct) =>
            throw new InvalidOperationException("redis down");

        public Task InvalidateUserKeysAsync(string cognitoSub, CancellationToken ct) =>
            throw new InvalidOperationException("redis down");
    }
}
