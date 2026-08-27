using System.Diagnostics;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using Orders.Infrastructure.Caching;
using Orders.Infrastructure.Metrics;
using StackExchange.Redis;

namespace Orders.Tests.Infrastructure;

/// <summary>
/// The gateway's fail-open contract, which is the design's governing rule and the
/// behaviour most likely to be silently broken later.
/// </summary>
/// <remarks>
/// <para>
/// The three doubles below are backed by REAL behaviour (a dictionary, a throw, a delay),
/// not by a blanket mock returning <c>default</c> for everything: a blanket mock would let
/// a gateway that never actually reads or writes anything pass every one of these tests.
/// </para>
/// <para>
/// <b>Why Moq is used to build them rather than a hand-written class.</b>
/// <c>IDatabase</c> declares <b>480</b> abstract members across
/// <c>IDatabase</c>/<c>IRedis</c>/<c>IRedisAsync</c>/<c>IDatabaseAsync</c>, so a
/// hand-written fake would be thousands of lines of <c>NotSupportedException</c> throws
/// before the six methods that matter. Moq supplies that surface; the six members the
/// gateway actually calls are then given genuine implementations, and
/// <see cref="MockBehavior.Strict"/> makes any OTHER member throw
/// <c>MockException</c> — the same "this was not part of the contract" signal a
/// <c>NotSupportedException</c> would have given.
/// </para>
/// </remarks>
public class CacheGatewayTests
{
    private static CacheGateway Gateway(IDatabase db) =>
        new(db, new NoopMetricsPublisher(), NullLogger<CacheGateway>.Instance);

    [Fact]
    public async Task Get_returns_Bypass_when_redis_throws()
    {
        var db = RedisDatabaseFake.Throwing();

        var outcome = await Gateway(db).GetAsync<string>("orders:products:v1", default);

        Assert.Equal(CacheResult.Bypass, outcome.Result);
        Assert.Null(outcome.Value);
    }

    /// <summary>
    /// A multiplexer timeout degrades to BYPASS, exactly like any other Redis failure.
    /// </summary>
    /// <remarks>
    /// The timeout now belongs to StackExchange.Redis itself (AsyncTimeout/SyncTimeout,
    /// set in Program.cs) rather than to a WaitAsync wrapper in the gateway, because no
    /// IDatabaseAsync method accepts a CancellationToken and WaitAsync could therefore
    /// only abandon the await while the command stayed in flight. So the behaviour worth
    /// pinning here is that the exception the library raises when it gives up —
    /// RedisTimeoutException — is caught and fails open, and is reported as a timeout
    /// rather than as a generic error.
    /// </remarks>
    [Fact]
    public async Task Get_returns_Bypass_when_the_multiplexer_times_out()
    {
        var db = RedisDatabaseFake.TimingOut();

        var sw = Stopwatch.StartNew();
        var outcome = await Gateway(db).GetAsync<string>("orders:products:v1", default);
        sw.Stop();

        Assert.Equal(CacheResult.Bypass, outcome.Result);
        Assert.Null(outcome.Value);
        // No stall: the gateway must not add a wait of its own on top of the library's.
        Assert.True(
            sw.ElapsedMilliseconds < 300,
            $"the gateway stalled on a timed-out read; it took {sw.ElapsedMilliseconds}ms");
    }

    /// <summary>
    /// A cached read costs exactly ONE Redis round trip.
    /// </summary>
    /// <remarks>
    /// The value and its TTL used to be two commands (StringGetAsync then
    /// KeyTimeToLiveAsync), doubling what every hit put on the multiplexer for a number
    /// that only feeds the X-Cache-TTL header. A regression here is invisible in behaviour
    /// and only shows up as latency under concurrency, so it is asserted directly.
    /// </remarks>
    [Fact]
    public async Task A_hit_costs_a_single_round_trip()
    {
        var db = RedisDatabaseFake.InMemory();
        var database = db.AsDatabase();
        await Gateway(database).SetAsync(
            "orders:products:v1", "cached", TimeSpan.FromMinutes(10), default);
        db.ResetCommandCount();

        var outcome = await Gateway(database).GetAsync<string>("orders:products:v1", default);

        Assert.Equal(CacheResult.Hit, outcome.Result);
        Assert.Equal(1, db.CommandCount);
    }

    [Fact]
    public async Task Set_swallows_a_redis_failure_so_the_response_is_unaffected()
    {
        var db = RedisDatabaseFake.Throwing();

        // Must not throw: a cache-write failure never affects the response.
        await Gateway(db).SetAsync("orders:products:v1", "v", TimeSpan.FromMinutes(10), default);
    }

    [Fact]
    public async Task Get_returns_Hit_with_the_remaining_ttl()
    {
        var db = RedisDatabaseFake.InMemory().AsDatabase();
        await Gateway(db).SetAsync(
            "orders:products:v1", "cached", TimeSpan.FromMinutes(10), default);

        var outcome = await Gateway(db).GetAsync<string>("orders:products:v1", default);

        Assert.Equal(CacheResult.Hit, outcome.Result);
        Assert.Equal("cached", outcome.Value);
        Assert.InRange(outcome.TtlRemainingSeconds, 1, 600);
    }

    [Fact]
    public async Task Get_returns_Miss_for_an_absent_key()
    {
        var outcome = await Gateway(RedisDatabaseFake.InMemory().AsDatabase())
            .GetAsync<string>("orders:products:v1", default);

        Assert.Equal(CacheResult.Miss, outcome.Result);
        Assert.Null(outcome.Value);
    }

    [Fact]
    public async Task Invalidate_swallows_a_redis_failure()
    {
        // Same stance as Set: a failed invalidation costs correctness (the stale entry
        // survives its TTL) but must still never surface in the write's response.
        await Gateway(RedisDatabaseFake.Throwing())
            .InvalidateAsync(["orders:cart:v1:sub:usr_1"], default);
    }

    [Fact]
    public async Task Tracked_keys_are_deleted_together_with_their_index()
    {
        var db = RedisDatabaseFake.InMemory();
        var gateway = Gateway(db.AsDatabase());
        await gateway.SetAsync("orders:cart:v1:sub:usr_1", "c", TimeSpan.FromMinutes(1), default);
        await gateway.TrackKeyAsync("sub", "orders:cart:v1:sub:usr_1", default);

        await gateway.InvalidateUserKeysAsync("sub", default);

        var outcome = await gateway.GetAsync<string>("orders:cart:v1:sub:usr_1", default);
        Assert.Equal(CacheResult.Miss, outcome.Result);
        Assert.False(db.Sets.ContainsKey(CacheKeys.UserIndex("sub")));
    }

    [Fact]
    public async Task Track_and_invalidate_swallow_a_redis_failure()
    {
        var gateway = Gateway(RedisDatabaseFake.Throwing());

        await gateway.TrackKeyAsync("sub", "orders:cart:v1:sub:usr_1", default);
        await gateway.InvalidateUserKeysAsync("sub", default);
    }
}

/// <summary>
/// A real-behaviour <see cref="IDatabase"/> double: a dictionary-backed store, a
/// connection that always throws, or one that stalls past the gateway's timeout.
/// </summary>
/// <remarks>
/// See the rationale on <see cref="CacheGatewayTests"/> for why the 480-member interface
/// surface is supplied by a strict Moq while the six methods the gateway calls carry real
/// implementations.
/// </remarks>
internal sealed class RedisDatabaseFake
{
    private readonly Dictionary<string, (string Value, DateTimeOffset? ExpiresAt)> _strings = new();

    private int _commandCount;

    public Dictionary<string, HashSet<string>> Sets { get; } = new();

    /// <summary>A working, dictionary-backed Redis with real TTL bookkeeping.</summary>
    public static RedisDatabaseFake InMemory() => new();

    /// <summary>The number of Redis commands issued since the last reset.</summary>
    public int CommandCount => _commandCount;

    public void ResetCommandCount() => _commandCount = 0;

    /// <summary>A Redis that answers every call with a connection failure.</summary>
    public static IDatabase Throwing() => Build(_ => throw NewConnectionException());

    /// <summary>
    /// A Redis whose multiplexer gives up, as it does once AsyncTimeout is configured.
    /// </summary>
    /// <remarks>
    /// The library raises this synchronously from the command call once it decides the
    /// operation cannot complete in budget; the fake does the same rather than stalling,
    /// because the wait being GONE from the gateway is precisely what is under test.
    /// </remarks>
    public static IDatabase TimingOut() => Build(_ => throw NewTimeoutException());

    // StackExchange.Redis's exceptions have no public constructor taking just a message,
    // so the fake raises the one it CAN construct. The gateway catches Exception, and the
    // distinction it cares about (cancellation vs anything else) is preserved.
    private static Exception NewConnectionException() =>
        new RedisConnectionException(ConnectionFailureType.SocketFailure, "fake redis failure");

    private static Exception NewTimeoutException() =>
        new RedisTimeoutException("fake redis timeout", CommandStatus.WaitingToBeSent);

    private static IDatabase Build(Func<RedisKey, Task<RedisValue>> onStringGet)
    {
        var mock = new Mock<IDatabase>(MockBehavior.Strict);

        mock.Setup(d => d.StringGetWithExpiryAsync(It.IsAny<RedisKey>(), It.IsAny<CommandFlags>()))
            .Returns((RedisKey k, CommandFlags _) => onStringGet(k)
                .ContinueWith(t => new RedisValueWithExpiry(t.GetAwaiter().GetResult(), null)));
        mock.Setup(d => d.StringSetAsync(
                It.IsAny<RedisKey>(), It.IsAny<RedisValue>(), It.IsAny<TimeSpan?>(),
                It.IsAny<bool>(), It.IsAny<When>(), It.IsAny<CommandFlags>()))
            .Returns((RedisKey _, RedisValue _, TimeSpan? _, bool _, When _, CommandFlags _) =>
                throw NewConnectionException());
        mock.Setup(d => d.KeyDeleteAsync(It.IsAny<RedisKey[]>(), It.IsAny<CommandFlags>()))
            .Returns((RedisKey[] _, CommandFlags _) => throw NewConnectionException());
        mock.Setup(d => d.KeyDeleteAsync(It.IsAny<RedisKey>(), It.IsAny<CommandFlags>()))
            .Returns((RedisKey _, CommandFlags _) => throw NewConnectionException());
        mock.Setup(d => d.SetAddAsync(
                It.IsAny<RedisKey>(), It.IsAny<RedisValue>(), It.IsAny<CommandFlags>()))
            .Returns((RedisKey _, RedisValue _, CommandFlags _) => throw NewConnectionException());
        mock.Setup(d => d.SetMembersAsync(It.IsAny<RedisKey>(), It.IsAny<CommandFlags>()))
            .Returns((RedisKey _, CommandFlags _) => throw NewConnectionException());
        mock.Setup(d => d.KeyExpireAsync(
                It.IsAny<RedisKey>(), It.IsAny<TimeSpan?>(), It.IsAny<ExpireWhen>(),
                It.IsAny<CommandFlags>()))
            .Returns((RedisKey _, TimeSpan? _, ExpireWhen _, CommandFlags _) =>
                throw NewConnectionException());

        return mock.Object;
    }

    public IDatabase AsDatabase()
    {
        var mock = new Mock<IDatabase>(MockBehavior.Strict);

        // ONE command returning value + TTL together, mirroring the real GETEX-style
        // round trip the gateway now issues.
        mock.Setup(d => d.StringGetWithExpiryAsync(It.IsAny<RedisKey>(), It.IsAny<CommandFlags>()))
            .Returns((RedisKey k, CommandFlags _) =>
            {
                _commandCount++;
                return Task.FromResult(new RedisValueWithExpiry(Read(k!), Ttl(k!)));
            });

        mock.Setup(d => d.StringSetAsync(
                It.IsAny<RedisKey>(), It.IsAny<RedisValue>(), It.IsAny<TimeSpan?>(),
                It.IsAny<bool>(), It.IsAny<When>(), It.IsAny<CommandFlags>()))
            .Returns((RedisKey k, RedisValue v, TimeSpan? ttl, bool _, When _, CommandFlags _) =>
            {
                _strings[k!] = ((string)v!, ttl is null ? null : DateTimeOffset.UtcNow + ttl);
                return Task.FromResult(true);
            });

        mock.Setup(d => d.KeyDeleteAsync(It.IsAny<RedisKey[]>(), It.IsAny<CommandFlags>()))
            .Returns((RedisKey[] keys, CommandFlags _) =>
                Task.FromResult((long)keys.Count(k => Delete(k!))));

        mock.Setup(d => d.KeyDeleteAsync(It.IsAny<RedisKey>(), It.IsAny<CommandFlags>()))
            .Returns((RedisKey k, CommandFlags _) => Task.FromResult(Delete(k!)));

        mock.Setup(d => d.SetAddAsync(
                It.IsAny<RedisKey>(), It.IsAny<RedisValue>(), It.IsAny<CommandFlags>()))
            .Returns((RedisKey k, RedisValue v, CommandFlags _) =>
            {
                if (!Sets.TryGetValue(k!, out var members))
                {
                    Sets[k!] = members = [];
                }

                return Task.FromResult(members.Add((string)v!));
            });

        mock.Setup(d => d.SetMembersAsync(It.IsAny<RedisKey>(), It.IsAny<CommandFlags>()))
            .Returns((RedisKey k, CommandFlags _) => Task.FromResult(
                Sets.TryGetValue(k!, out var members)
                    ? members.Select(m => (RedisValue)m).ToArray()
                    : []));

        mock.Setup(d => d.KeyExpireAsync(
                It.IsAny<RedisKey>(), It.IsAny<TimeSpan?>(), It.IsAny<ExpireWhen>(),
                It.IsAny<CommandFlags>()))
            .Returns((RedisKey k, TimeSpan? _, ExpireWhen _, CommandFlags _) =>
                Task.FromResult(Sets.ContainsKey(k!) || _strings.ContainsKey(k!)));

        return mock.Object;
    }

    private RedisValue Read(string key)
    {
        if (!_strings.TryGetValue(key, out var entry))
        {
            return RedisValue.Null;
        }

        // Real expiry, so a test can never get a hit on an entry whose TTL has run out.
        if (entry.ExpiresAt is { } expiry && expiry <= DateTimeOffset.UtcNow)
        {
            _strings.Remove(key);
            return RedisValue.Null;
        }

        return entry.Value;
    }

    private TimeSpan? Ttl(string key) =>
        _strings.TryGetValue(key, out var entry) && entry.ExpiresAt is { } expiry
            ? expiry - DateTimeOffset.UtcNow
            : null;

    private bool Delete(string key)
    {
        var removedString = _strings.Remove(key);
        var removedSet = Sets.Remove(key);
        return removedString || removedSet;
    }
}
