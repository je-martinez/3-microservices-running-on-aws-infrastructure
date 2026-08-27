using System.Diagnostics;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Orders.Application.Abstractions;
using StackExchange.Redis;

namespace Orders.Infrastructure.Caching;

/// <summary>
/// The fail-open Redis transport behind every cached read in this service.
/// </summary>
/// <remarks>
/// <para>
/// The load-bearing details: every public method wraps its Redis call in a try/catch; a GET
/// reads value and TTL in ONE round trip; and metrics and spans are emitted but never
/// allowed to throw or to block the caller. Nothing here may propagate a failure to the
/// caller — see <see cref="ICacheGateway"/>.
/// </para>
/// <para>
/// <b>The timeout is the multiplexer's, not a <c>WaitAsync</c> wrapper's.</b> No method on
/// <c>IDatabaseAsync</c> accepts a <see cref="CancellationToken"/> (verified by reflection
/// against 2.8.24: zero of them do), so a <c>CancellationTokenSource</c> could only ever
/// abandon the AWAIT — the command stayed in flight against the multiplexer until its own
/// <c>AsyncTimeout</c>, which was left at the 5000ms default while the gateway gave up
/// after 50. Under concurrency those abandoned commands piled up and each new one queued
/// behind them. The timeout now belongs to the library (<c>AsyncTimeout</c>/<c>SyncTimeout</c>
/// in <c>Program.cs</c>), which is the only layer that can actually abort the operation, and
/// it surfaces as <see cref="RedisTimeoutException"/> — caught below like any other failure.
/// </para>
/// </remarks>
public class CacheGateway : ICacheGateway
{
    /// <summary>
    /// Registered on the tracer provider in <c>Program.cs</c>.
    /// </summary>
    /// <remarks>
    /// An ActivitySource that is NOT added there produces spans that are created, cost
    /// work, and are silently never exported — no error, no span in OpenObserve. Register
    /// the source in the SAME change that creates one.
    /// </remarks>
    public const string ActivitySourceName = "orders-cache";

    private static readonly ActivitySource Source = new(ActivitySourceName);

    private readonly IDatabase _db;
    private readonly IMetricsPublisher _metrics;
    private readonly ILogger<CacheGateway> _logger;

    public CacheGateway(
        IDatabase db,
        IMetricsPublisher metrics,
        ILogger<CacheGateway> logger)
    {
        _db = db;
        _metrics = metrics;
        _logger = logger;
    }

    public async Task<CacheOutcome<T>> GetAsync<T>(string key, CancellationToken ct)
    {
        var prefix = CacheKeys.PrefixOf(key);
        using var activity = Source.StartActivity("cache.get", ActivityKind.Client);
        // NEVER the full key: it carries cognito_sub and user_id.
        activity?.SetTag("cache.key_prefix", prefix);
        var sw = Stopwatch.StartNew();

        try
        {
            // ONE round trip for value AND TTL. The previous StringGetAsync +
            // KeyTimeToLiveAsync pair doubled the commands every cached read put on the
            // multiplexer for a number that only feeds the X-Cache-TTL header.
            var entry = await _db.StringGetWithExpiryAsync(key);
            if (!entry.Value.HasValue)
            {
                Record(prefix, CacheResult.Miss, "get", sw, activity, ct);
                return CacheOutcome<T>.Miss();
            }

            // The (string) cast is REQUIRED, not stylistic: RedisValue defines implicit
            // conversions to both string? and ReadOnlySpan<byte>, so an unqualified
            // Deserialize<T>(value) is a CS0121 ambiguity between two overloads.
            var deserialized = JsonSerializer.Deserialize<T>((string)entry.Value!);
            if (deserialized is null)
            {
                // A stored `null` is indistinguishable from an absent entry as far as the
                // caller is concerned, and re-deriving it is cheap. Treated as a miss
                // rather than a hit-with-null so no consumer has to handle a nullable hit.
                Record(prefix, CacheResult.Miss, "get", sw, activity, ct);
                return CacheOutcome<T>.Miss();
            }

            var remaining = (int)Math.Max(0, entry.Expiry?.TotalSeconds ?? 0);
            activity?.SetTag("cache.ttl_remaining", remaining);
            Record(prefix, CacheResult.Hit, "get", sw, activity, ct);
            return CacheOutcome<T>.Hit(deserialized, remaining);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            // Includes the multiplexer's own timeout (RedisTimeoutException) and every
            // other Redis/deserialization failure. The `when` clause lets a genuine client
            // disconnect (the caller's own token) propagate normally — that is not a cache
            // failure and the request is already over.
            LogUnavailable(ex, prefix, ReasonFor(ex));
            Record(prefix, CacheResult.Bypass, "get", sw, activity, ct);
            return CacheOutcome<T>.Bypass();
        }
    }

    public async Task SetAsync<T>(string key, T value, TimeSpan ttl, CancellationToken ct)
    {
        var prefix = CacheKeys.PrefixOf(key);
        using var activity = Source.StartActivity("cache.set", ActivityKind.Client);
        activity?.SetTag("cache.key_prefix", prefix);
        var sw = Stopwatch.StartNew();

        try
        {
            await _db.StringSetAsync(key, JsonSerializer.Serialize(value), ttl);
            PublishDuration(sw, "set", ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            // Deliberately swallowed and NOT rethrown: the response is already correct, it
            // just will not be cached. A cache-WRITE failure never affects the response.
            LogUnavailable(ex, prefix, ReasonFor(ex));
        }
    }

    public async Task InvalidateAsync(IReadOnlyCollection<string> keys, CancellationToken ct)
    {
        if (keys.Count == 0)
        {
            return;
        }

        try
        {
            await _db.KeyDeleteAsync(keys.Select(k => (RedisKey)k).ToArray());
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            // A failed invalidation is the one failure with a correctness cost: the stale
            // entry survives until its TTL. Logged at WARN so it is visible, but still
            // never propagated into the write's response — the write itself committed.
            LogUnavailable(ex, "invalidate", "invalidate_failed");
        }
    }

    public async Task TrackKeyAsync(string cognitoSub, string key, CancellationToken ct)
    {
        try
        {
            var index = CacheKeys.UserIndex(cognitoSub);
            await _db.SetAddAsync(index, key);
            // The index must outlive every entry it points at, or invalidation silently
            // misses keys. One hour > the longest response TTL in this service.
            await _db.KeyExpireAsync(index, TimeSpan.FromHours(1));
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            LogUnavailable(ex, "index", "track_key_failed");
        }
    }

    public async Task InvalidateUserKeysAsync(string cognitoSub, CancellationToken ct)
    {
        try
        {
            var index = CacheKeys.UserIndex(cognitoSub);
            var members = await _db.SetMembersAsync(index);
            if (members.Length > 0)
            {
                await _db.KeyDeleteAsync(members.Select(m => (RedisKey)m.ToString()).ToArray());
            }

            await _db.KeyDeleteAsync(index);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            LogUnavailable(ex, "index", "invalidate_user_keys_failed");
        }
    }

    private static string ReasonFor(Exception ex) =>
        ex is RedisTimeoutException or OperationCanceledException ? "cache_timeout" : "redis_error";

    private void LogUnavailable(Exception ex, string prefix, string reason) =>
        _logger.LogWarning(
            ex,
            "Cache unavailable {app_event} {key_prefix} {reason}",
            "cache_unavailable",
            prefix,
            reason);

    /// <summary>
    /// Emits this operation's metrics WITHOUT awaiting them.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Fire-and-forget on purpose, and this is the fix's centre of gravity.</b> The
    /// CloudWatch publisher performs a real HTTP PutMetricData; awaiting it put that call
    /// on the request's critical path, so a cached read paid TWO of them (a counter and a
    /// duration) — and a cached endpoint pays for the identity lookup too, for four in
    /// total. Measured against the local emulator: ~74ms each when idle, but ~1.9s at p50
    /// under 50 concurrent calls, which is what turned a 2ms cache hit into a 14s response.
    /// </para>
    /// <para>
    /// Telemetry may never be the slowest part of the thing it measures.
    /// <c>IMetricsPublisher</c> already contracts never to throw, and its CloudWatch
    /// implementation swallows and logs internally; the continuation below is a second belt
    /// so that a future implementation which DOES throw cannot surface as an unobserved
    /// task exception. The caller's <see cref="CancellationToken"/> is deliberately NOT
    /// forwarded: the publish outlives the request it describes, and cancelling it on
    /// client disconnect would drop exactly the metrics of the slowest requests.
    /// </para>
    /// </remarks>
    private void Record(
        string prefix,
        CacheResult result,
        string operation,
        Stopwatch sw,
        Activity? activity,
        CancellationToken ct)
    {
        var label = result.ToString().ToLowerInvariant();
        activity?.SetTag("cache.result", label);
        FireAndForget(_metrics.PublishAsync(
            "cache_requests_total",
            1,
            new Dictionary<string, string>
            {
                ["Service"] = "orders",
                // The PREFIX only — a full key would carry identity into a CloudWatch
                // dimension and give the metric unbounded cardinality.
                ["KeyPrefix"] = prefix,
                ["Result"] = label,
            },
            CancellationToken.None));
        PublishDuration(sw, operation, ct);
    }

    private void PublishDuration(Stopwatch sw, string operation, CancellationToken ct) =>
        FireAndForget(_metrics.PublishAsync(
            "cache_operation_duration_ms",
            sw.Elapsed.TotalMilliseconds,
            new Dictionary<string, string> { ["Service"] = "orders", ["Operation"] = operation },
            CancellationToken.None));

    private void FireAndForget(Task publish)
    {
        if (publish.IsCompletedSuccessfully)
        {
            return;
        }

        _ = publish.ContinueWith(
            t => _logger.LogWarning(
                t.Exception,
                "Cache metric publish failed {app_event} {reason}",
                "metric_publish_failed",
                "cache_metric"),
            CancellationToken.None,
            TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
    }
}
