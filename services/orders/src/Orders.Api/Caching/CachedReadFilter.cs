using System.Text.Json;
using Microsoft.Extensions.Options;
using Orders.Api.Identity;
using Orders.Infrastructure.Caching;

namespace Orders.Api.Caching;

/// <summary>
/// Builds the cache key for THIS request.
/// </summary>
/// <remarks>
/// Returns null to skip caching (e.g. the caller's <c>user_id</c> could not be resolved),
/// which yields a normal uncached response rather than a wrong or cross-user one.
/// </remarks>
public delegate Task<string?> CacheKeyBuilder(
    EndpointFilterInvocationContext ctx,
    ICurrentCaller caller);

/// <summary>
/// Serves a cacheable GET from Redis, reporting the outcome on <c>X-Cache</c>.
/// </summary>
/// <remarks>
/// <para>
/// <b>A filter, not middleware, and on purpose.</b> <c>HttpErrorMetricsMiddleware</c>
/// documents that middleware was chosen there BECAUSE a filter misses short-circuited
/// responses. That reasoning does not apply here — it argues FOR a filter: this cache must
/// only ever wrap the handler, and must NOT stamp a header on the 401
/// <c>CallerContextMiddleware</c> produces before routing. A filter runs inside the
/// endpoint, which is exactly the scope wanted.
/// </para>
/// <para>
/// <b>NOT generic, and it stores raw JSON.</b> <c>GET /v1/orders/my-orders</c> returns an
/// <c>Ok&lt;IReadOnlyList&lt;OrderDto&gt;&gt;</c> when <c>includeTracking=false</c> and an
/// <c>Ok&lt;OrderWithTrackingDto[]&gt;</c> when it is true — two different generic result
/// types from ONE route. A <c>CachedReadFilter&lt;T&gt;</c> matching on
/// <c>IValueHttpResult&lt;T&gt;</c> would match only one of them, so the other would never
/// be cached: a silent permanent MISS, with every test that only checks one variant still
/// passing. <c>IValueHttpResult&lt;T&gt;</c> is not covariant in <c>T</c>, so
/// <c>T = object</c> does not rescue it either. Matching the NON-generic
/// <c>IValueHttpResult</c> and storing pre-serialized JSON avoids the problem entirely,
/// and has a second benefit: a HIT replays the exact bytes of the MISS, so the two
/// responses cannot drift through a serializer difference.
/// </para>
/// </remarks>
public sealed class CachedReadFilter : IEndpointFilter
{
    private readonly CacheKeyBuilder _keyBuilder;
    private readonly TimeSpan _ttl;

    public CachedReadFilter(CacheKeyBuilder keyBuilder, TimeSpan ttl)
    {
        _keyBuilder = keyBuilder;
        _ttl = ttl;
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
            && result is IValueHttpResult { Value: { } value })
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
    /// Falls back to <see cref="JsonSerializerOptions.Web"/> — the framework's own default
    /// — rather than <c>JsonSerializerOptions.Default</c>, so the casing still matches
    /// even if the options service is somehow unavailable.
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
    /// Adds NO OpenAPI metadata: the route's documented request/response shape is
    /// unchanged by caching, and <c>X-Cache</c> is an operational header rather than part
    /// of the contract. <c>openapi.yaml</c> must come out of a rebuild with no diff.
    /// </remarks>
    public static RouteHandlerBuilder WithCache(
        this RouteHandlerBuilder builder,
        CacheKeyBuilder keyBuilder,
        TimeSpan ttl) =>
        builder.AddEndpointFilter(new CachedReadFilter(keyBuilder, ttl));
}
