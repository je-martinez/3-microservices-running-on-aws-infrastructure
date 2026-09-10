using System.Text.Json;
using Microsoft.Extensions.Options;
using Orders.Api.Identity;
using Orders.Infrastructure.Caching;

namespace Orders.Api.Caching;

/// <summary>
/// Builds the cache key for THIS request. Returns null to skip caching — an unresolved
/// <c>user_id</c>, say — yielding an uncached response rather than a cross-user one.
/// </summary>
public delegate Task<string?> CacheKeyBuilder(
    EndpointFilterInvocationContext ctx,
    ICurrentCaller caller);

/// <summary>
/// Decides whether THIS response is worth storing, given the value the handler produced.
/// </summary>
/// <remarks>
/// CONTRACT: Keep the rule per-route, not inside the filter. The filter matches the
/// non-generic <c>IValueHttpResult</c> so one instance serves a route returning two types;
/// teaching it to recognise <c>OrderWithTrackingDto</c> spends that generality and puts an
/// Application DTO into the caching primitive. Returning false serves the response and
/// stores nothing — still a <c>MISS</c>. See [[x-cache-response-header]]
/// </remarks>
public delegate bool CacheStorePredicate(object value);

/// <summary>
/// Serves a cacheable GET from Redis, reporting the outcome on <c>X-Cache</c>.
/// CONTRACT: Do NOT make this generic. One route returns two result types, and a
/// <c>CachedReadFilter&lt;T&gt;</c> matches only one — the other becomes a silent permanent
/// MISS while every single-variant test still passes. Storing pre-serialized JSON also makes
/// a HIT replay the exact bytes of the MISS.
/// CONTRACT: Keep it a filter, not middleware — it must wrap only the handler and must NOT
/// stamp a header on the 401 raised before routing. See [[x-cache-response-header]]
/// </summary>
public sealed class CachedReadFilter : IEndpointFilter
{
    private readonly CacheKeyBuilder _keyBuilder;
    private readonly TimeSpan _ttl;
    private readonly CacheStorePredicate? _shouldStore;

    public CachedReadFilter(
        CacheKeyBuilder keyBuilder,
        TimeSpan ttl,
        CacheStorePredicate? shouldStore = null)
    {
        _keyBuilder = keyBuilder;
        _ttl = ttl;
        _shouldStore = shouldStore;
    }

    public async ValueTask<object?> InvokeAsync(
        EndpointFilterInvocationContext ctx,
        EndpointFilterDelegate next)
    {
        var http = ctx.HttpContext;
        var cache = http.RequestServices.GetService<ICacheGateway>();
        var caller = http.RequestServices.GetRequiredService<ICurrentCaller>();
        var ct = http.RequestAborted;

        // No gateway registered => CACHE_ENABLED=false. Skip entirely and emit no header
        // at all, per the kill-switch contract: a disabled cache is invisible, not a
        // permanent BYPASS.
        if (cache is null)
        {
            return await next(ctx);
        }

        var key = await _keyBuilder(ctx, caller);
        if (key is null)
        {
            return await next(ctx);
        }

        // Cached as raw JSON, never as a typed value — see the class remarks.
        var cached = await cache.GetAsync<string>(key, ct);
        if (cached.Result == CacheResult.Hit && cached.Value is not null)
        {
            http.Response.Headers["X-Cache"] = "HIT";
            http.Response.Headers["X-Cache-TTL"] = cached.TtlRemainingSeconds.ToString();
            // Replay the stored bytes verbatim: the handler never runs, and the body is
            // byte-identical to the MISS that produced it.
            return Results.Content(cached.Value, "application/json");
        }

        http.Response.Headers["X-Cache"] = cached.Result == CacheResult.Bypass ? "BYPASS" : "MISS";

        var result = await next(ctx);

        // Only a 200 is cacheable. IValueHttpResult (NON-generic) is the shared interface
        // every Results.Ok<T> implements regardless of its T, which is what lets one
        // filter serve a route returning two different shapes.
        if (cached.Result != CacheResult.Bypass
            && result is IStatusCodeHttpResult { StatusCode: StatusCodes.Status200OK }
            && result is IValueHttpResult { Value: { } value }
            // A 200 the route declines to store: served normally, written nowhere. The
            // response still reported MISS above, so the next read re-runs the handler
            // rather than replaying a fact that was only true for an instant.
            && (_shouldStore is null || _shouldStore(value)))
        {
            // MUST use the app's own serializer options, not JsonSerializer's defaults.
            // Minimal APIs serialize Results.Ok<T> with the web defaults (camelCase);
            // JsonSerializer.Serialize(value) with no options is PascalCase. Mixing them
            // makes a HIT replay `{"UnitPrice":...}` where the MISS produced
            // `{"unitPrice":...}` — a body every client silently misreads as nulls/zeros,
            // on hits only. See the note in this file's sibling test.
            var json = JsonSerializer.Serialize(value, ResolveJsonOptions(http));
            await cache.SetAsync(key, json, _ttl, ct);

            if (caller.CognitoSub is { Length: > 0 } sub && !key.StartsWith(CacheKeys.ProductsPrefix))
            {
                // Per-user keys join the caller's index so a later write can invalidate
                // them without KEYS/SCAN. The catalogue is excluded: it belongs to no user.
                await cache.TrackKeyAsync(sub, key, ct);
            }
        }

        return result;
    }

    /// <summary>
    /// The exact <see cref="JsonSerializerOptions"/> Minimal APIs will use for this
    /// response, so a cached body is byte-identical to a freshly serialized one.
    /// </summary>
    /// <remarks>
    /// CONTRACT: Fall back to <see cref="JsonSerializerOptions.Web"/>, the framework's own
    /// default — <c>JsonSerializerOptions.Default</c> would change the casing when the
    /// options service is unavailable. See [[x-cache-response-header]]
    /// </remarks>
    private static JsonSerializerOptions ResolveJsonOptions(HttpContext http) =>
        http.RequestServices
            .GetService<IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions>>()
            ?.Value.SerializerOptions
        ?? JsonSerializerOptions.Web;
}

public static class CachedReadFilterExtensions
{
    /// <summary>
    /// Serves this route from the response cache, keyed by <paramref name="keyBuilder"/>.
    /// </summary>
    /// <remarks>
    /// CONTRACT: Add NO OpenAPI metadata — caching does not change the documented shape and
    /// <c>X-Cache</c> is operational, so a rebuild must leave <c>openapi.yaml</c> with no
    /// diff. See [[x-cache-response-header]]
    /// </remarks>
    /// <param name="shouldStore">
    /// Optional veto on storing a particular 200, for routes whose response can legitimately
    /// carry a value that is only momentarily true. Omitted, every 200 is stored.
    /// </param>
    public static RouteHandlerBuilder WithCache(
        this RouteHandlerBuilder builder,
        CacheKeyBuilder keyBuilder,
        TimeSpan ttl,
        CacheStorePredicate? shouldStore = null) =>
        builder.AddEndpointFilter(new CachedReadFilter(keyBuilder, ttl, shouldStore));
}
