using Orders.Application.Identity;
using Orders.Infrastructure.Caching;
using Orders.Infrastructure.Identity;

namespace Orders.Tests.Identity;

/// <summary>
/// The identity cache, which is what keeps "every per-user key carries user_id" affordable:
/// without it, a response-cache HIT would still pay a gRPC round trip to build its key.
/// </summary>
public class CachedUserDirectoryTests
{
    private sealed class CountingDirectory : IUserDirectory
    {
        public int Calls;

        public Task<string?> ResolveInternalUserIdAsync(
            string cognitoSub, CancellationToken ct = default)
        {
            Calls++;
            return Task.FromResult<string?>("usr_known");
        }

        public Task<CallerProfile?> ResolveCallerAsync(
            string cognitoSub, CancellationToken ct = default)
            => Task.FromResult<CallerProfile?>(null);
    }

    private sealed class NullReturningDirectory : IUserDirectory
    {
        public Task<string?> ResolveInternalUserIdAsync(
            string cognitoSub, CancellationToken ct = default)
            => Task.FromResult<string?>(null);

        public Task<CallerProfile?> ResolveCallerAsync(
            string cognitoSub, CancellationToken ct = default)
            => Task.FromResult<CallerProfile?>(null);
    }

    /// <summary>A dictionary-backed gateway whose stored entries are inspectable.</summary>
    private sealed class FakeCacheGateway : ICacheGateway
    {
        public Dictionary<string, string> Stored { get; } = new();

        public Task<CacheOutcome<T>> GetAsync<T>(string key, CancellationToken ct) =>
            Task.FromResult(Stored.TryGetValue(key, out var value)
                ? CacheOutcome<T>.Hit((T)(object)value, 3600)
                : CacheOutcome<T>.Miss());

        public Task SetAsync<T>(string key, T value, TimeSpan ttl, CancellationToken ct)
        {
            Stored[key] = (string)(object)value!;
            return Task.CompletedTask;
        }

        public Task InvalidateAsync(IReadOnlyCollection<string> keys, CancellationToken ct)
        {
            foreach (var key in keys)
            {
                Stored.Remove(key);
            }

            return Task.CompletedTask;
        }

        public Task TrackKeyAsync(string cognitoSub, string key, CancellationToken ct) =>
            Task.CompletedTask;

        public Task InvalidateUserKeysAsync(string cognitoSub, CancellationToken ct) =>
            Task.CompletedTask;
    }

    /// <summary>A gateway standing in for an unreachable Redis: every read BYPASSes.</summary>
    private sealed class BypassingCacheGateway : ICacheGateway
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

    [Fact]
    public async Task Resolves_through_the_inner_directory_on_a_miss_then_serves_from_cache()
    {
        var inner = new CountingDirectory();
        var cache = new FakeCacheGateway();
        var sut = new CachedUserDirectory(inner, cache);

        var first = await sut.ResolveInternalUserIdAsync("sub-known", default);
        var second = await sut.ResolveInternalUserIdAsync("sub-known", default);

        Assert.Equal("usr_known", first);
        Assert.Equal("usr_known", second);
        Assert.Equal(1, inner.Calls); // the second call never reached gRPC
    }

    [Fact]
    public async Task Falls_back_to_the_inner_directory_when_the_cache_bypasses()
    {
        var inner = new CountingDirectory();
        var sut = new CachedUserDirectory(inner, new BypassingCacheGateway());

        var resolved = await sut.ResolveInternalUserIdAsync("sub-known", default);

        Assert.Equal("usr_known", resolved);
        Assert.Equal(1, inner.Calls);
    }

    [Fact]
    public async Task Does_not_cache_an_unresolved_user()
    {
        // A null resolution is not a fact about the user, it is the absence of one.
        // Caching it for an hour would keep a newly-created user unknown to this service
        // long after Users knows about them.
        var cache = new FakeCacheGateway();
        var sut = new CachedUserDirectory(new NullReturningDirectory(), cache);

        await sut.ResolveInternalUserIdAsync("sub-unknown", default);

        Assert.Empty(cache.Stored);
    }

    [Fact]
    public async Task Keys_the_entry_by_cognito_sub_so_two_callers_never_share_one()
    {
        var cache = new FakeCacheGateway();
        var sut = new CachedUserDirectory(new CountingDirectory(), cache);

        await sut.ResolveInternalUserIdAsync("sub-a", default);

        Assert.True(cache.Stored.ContainsKey(CacheKeys.Identity("sub-a")));
        Assert.False(cache.Stored.ContainsKey(CacheKeys.Identity("sub-b")));
    }

    [Fact]
    public async Task Never_caches_the_full_profile()
    {
        // ResolveCallerAsync carries the caller's email, name and delivery address, and it
        // is only read on the order-creation WRITE path. Passing it straight through keeps
        // that PII out of Redis entirely.
        var cache = new FakeCacheGateway();
        var sut = new CachedUserDirectory(new CountingDirectory(), cache);

        await sut.ResolveCallerAsync("sub-known", default);

        Assert.Empty(cache.Stored);
    }
}
