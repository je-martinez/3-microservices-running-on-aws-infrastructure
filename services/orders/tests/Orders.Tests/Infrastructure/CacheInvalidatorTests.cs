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
    public async Task Deleting_a_user_sweeps_both_identities_and_both_identity_entries()
    {
        var spy = new SpyGateway();

        await Invalidator(spy).InvalidateDeletedUserAsync("sub-gone", "usr_gone", default);

        // The response entries, by index, under BOTH identifiers: keys are built from
        // whatever the client sent in x-user-id, and Users' GetUserById accepts either
        // spelling, so a user's live keys may be filed under either. Sweeping only the
        // sub — what this did before — left the usr_-keyed entries serving a deleted
        // account's orders for the rest of their TTL. Their exact names carry order ids
        // and a t0/t1 suffix this layer has never seen, so the index is the only reach.
        Assert.Equal(["sub-gone", "usr_gone"], spy.SweptSubs);
        // The identity entries, by name: the one per-user key family that never enters
        // the index, and the longest-lived in the service at 1h.
        Assert.Equal(
            [CacheKeys.Identity("sub-gone"), CacheKeys.Identity("usr_gone")],
            spy.DeletedKeys);
    }

    [Fact]
    public async Task Identical_identities_are_swept_once_not_twice()
    {
        // The degenerate case is the COMMON one on the direct path: the E2E harness
        // authenticates with the usr_ id, so the cascade receives it in BOTH fields.
        // Correctness is unaffected either way — the duplicate is pure noise on a hot
        // route, and this pins that it is not emitted.
        var spy = new SpyGateway();

        await Invalidator(spy).InvalidateDeletedUserAsync("usr_same", "usr_same", default);

        Assert.Equal(["usr_same"], spy.SweptSubs);
        Assert.Equal([CacheKeys.Identity("usr_same")], spy.DeletedKeys);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public async Task A_missing_user_id_never_becomes_a_key(string? userId)
    {
        // The route rejects an empty user_id with a 400 today, so this is defence against
        // that guard changing rather than against a call shape reachable now. An empty
        // segment would build `orders:index:v1:` / `identity:sub-to-user:v1:` — keys
        // belonging to nobody, and a delete this layer has no business issuing.
        var spy = new SpyGateway();

        await Invalidator(spy).InvalidateDeletedUserAsync("sub-gone", userId, default);

        Assert.Equal(["sub-gone"], spy.SweptSubs);
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

        await Invalidator(spy).InvalidateDeletedUserAsync("sub-gone", "usr_gone", default);

        Assert.DoesNotContain(CacheKeys.Products, spy.DeletedKeys);
    }

    [Fact]
    public async Task A_redis_failure_never_propagates_to_the_cascade()
    {
        // The rows are ALREADY deleted when this runs. Throwing here would tell Users the
        // cascade did not happen when it did, and Users would then fail the whole account
        // deletion for the person. No exception may escape, whichever call faults.
        await Invalidator(new ThrowingGateway())
            .InvalidateDeletedUserAsync("sub-gone", "usr_gone", default);
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
