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
/// The load-bearing details: every public method wraps its Redis call in a try/catch plus a
/// <see cref="CancellationTokenSource"/> timeout; a GET reads value and TTL together; and
/// metrics and spans are emitted but never allowed to throw. Nothing here may propagate a
/// failure to the caller — see <see cref="ICacheGateway"/>.
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
    private readonly TimeSpan _timeout;

    public CacheGateway(
        IDatabase db,
        IMetricsPublisher metrics,
        ILogger<CacheGateway> logger,
        TimeSpan timeout)
    {
        _db = db;
        _metrics = metrics;
        _logger = logger;
        _timeout = timeout;
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
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(_timeout);

            var value = await _db.StringGetAsync(key).WaitAsync(cts.Token);
            if (!value.HasValue)
            {
                await RecordAsync(prefix, CacheResult.Miss, "get", sw, activity, ct);
                return CacheOutcome<T>.Miss();
            }

            var ttl = await _db.KeyTimeToLiveAsync(key).WaitAsync(cts.Token);
            // The (string) cast is REQUIRED, not stylistic: RedisValue defines implicit
            // conversions to both string? and ReadOnlySpan<byte>, so an unqualified
            // Deserialize<T>(value) is a CS0121 ambiguity between two overloads.
            var deserialized = JsonSerializer.Deserialize<T>((string)value!);
            if (deserialized is null)
            {
                // A stored `null` is indistinguishable from an absent entry as far as the
                // caller is concerned, and re-deriving it is cheap. Treated as a miss
                // rather than a hit-with-null so no consumer has to handle a nullable hit.
                await RecordAsync(prefix, CacheResult.Miss, "get", sw, activity, ct);
                return CacheOutcome<T>.Miss();
            }

            var remaining = (int)Math.Max(0, ttl?.TotalSeconds ?? 0);
            activity?.SetTag("cache.ttl_remaining", remaining);
            await RecordAsync(prefix, CacheResult.Hit, "get", sw, activity, ct);
            return CacheOutcome<T>.Hit(deserialized, remaining);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            // Includes the timeout (an OperationCanceledException from OUR cts, not the
            // caller's) and every Redis/deserialization failure. The `when` clause lets a
            // genuine client disconnect (the caller's own token) propagate normally — that
            // is not a cache failure and the request is already over.
            LogUnavailable(ex, prefix, ReasonFor(ex));
            await RecordAsync(prefix, CacheResult.Bypass, "get", sw, activity, ct);
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
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(_timeout);
            await _db.StringSetAsync(key, JsonSerializer.Serialize(value), ttl).WaitAsync(cts.Token);
            await PublishDurationAsync(sw, "set", ct);
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
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(_timeout);
            await _db.KeyDeleteAsync(keys.Select(k => (RedisKey)k).ToArray()).WaitAsync(cts.Token);
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
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(_timeout);
            var index = CacheKeys.UserIndex(cognitoSub);
            await _db.SetAddAsync(index, key).WaitAsync(cts.Token);
            // The index must outlive every entry it points at, or invalidation silently
            // misses keys. One hour > the longest response TTL in this service.
            await _db.KeyExpireAsync(index, TimeSpan.FromHours(1)).WaitAsync(cts.Token);
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
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(_timeout);
            var index = CacheKeys.UserIndex(cognitoSub);
            var members = await _db.SetMembersAsync(index).WaitAsync(cts.Token);
            if (members.Length > 0)
            {
                await _db.KeyDeleteAsync(members.Select(m => (RedisKey)m.ToString()).ToArray())
                    .WaitAsync(cts.Token);
            }

            await _db.KeyDeleteAsync(index).WaitAsync(cts.Token);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            LogUnavailable(ex, "index", "invalidate_user_keys_failed");
        }
    }

    private static string ReasonFor(Exception ex) =>
        ex is OperationCanceledException ? "cache_timeout" : "redis_error";

    private void LogUnavailable(Exception ex, string prefix, string reason) =>
        _logger.LogWarning(
            ex,
            "Cache unavailable {app_event} {key_prefix} {reason}",
            "cache_unavailable",
            prefix,
            reason);

    private async Task RecordAsync(
        string prefix,
        CacheResult result,
        string operation,
        Stopwatch sw,
        Activity? activity,
        CancellationToken ct)
    {
        var label = result.ToString().ToLowerInvariant();
        activity?.SetTag("cache.result", label);
        await _metrics.PublishAsync(
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
            ct);
        await PublishDurationAsync(sw, operation, ct);
    }

    private Task PublishDurationAsync(Stopwatch sw, string operation, CancellationToken ct) =>
        _metrics.PublishAsync(
            "cache_operation_duration_ms",
            sw.Elapsed.TotalMilliseconds,
            new Dictionary<string, string> { ["Service"] = "orders", ["Operation"] = operation },
            ct);
}
