using Orders.Api.Identity;
using Orders.Infrastructure.Caching;

namespace Orders.Api.Caching;

/// <summary>
/// The <see cref="CacheKeyBuilder"/> implementations for the three per-user reads.
/// </summary>
/// <remarks>
/// <para>
/// Every one of them returns <c>null</c> — "do not cache this request" — when either
/// identifier is missing. That is not defensive padding: <c>CallerContextMiddleware</c>
/// stamps the internal id on every authenticated request but deliberately SWALLOWS every
/// non-cancellation failure while doing so, so Users being down (or an unknown sub, which
/// makes <c>CurrentCaller.ResolveInternalUserIdAsync</c> throw <c>UnknownUserException</c>)
/// leaves a perfectly authenticated caller with a null <see cref="ICurrentCaller.ResolvedInternalUserId"/>.
/// Building a key anyway would put an empty segment where <c>user_id</c> belongs — and
/// every unresolvable caller would then share that ONE key. Declining costs a cache miss;
/// not declining serves one user's cart to another.
/// </para>
/// <para>
/// None of these calls <see cref="ICurrentCaller.ResolveInternalUserIdAsync"/>. They run on
/// the HIT path, where the entire point is to avoid the network; a resolving key builder
/// would reintroduce the gRPC call the cache exists to remove.
/// <see cref="ICurrentCaller.ResolvedInternalUserId"/> is the non-triggering view for
/// exactly this.
/// </para>
/// </remarks>
public static class UserCacheKeyBuilders
{
    public static Task<string?> Cart(EndpointFilterInvocationContext ctx, ICurrentCaller caller)
    {
        var (sub, userId) = Identity(caller);
        return Task.FromResult(sub is null || userId is null
            ? null
            : CacheKeys.Cart(sub, userId));
    }

    public static Task<string?> MyOrders(EndpointFilterInvocationContext ctx, ICurrentCaller caller)
    {
        var (sub, userId) = Identity(caller);
        return Task.FromResult(sub is null || userId is null
            ? null
            : CacheKeys.MyOrders(sub, userId, IncludeTracking(ctx)));
    }

    public static Task<string?> OrderById(EndpointFilterInvocationContext ctx, ICurrentCaller caller)
    {
        var (sub, userId) = Identity(caller);
        if (sub is null || userId is null)
        {
            return Task.FromResult<string?>(null);
        }

        // Read from the ROUTE VALUES, not from ctx.GetArgument<string>(0): the filter runs
        // ahead of the handler, and relying on an argument's positional index would break
        // silently the next time a parameter is inserted before it.
        //
        // An absent id declines rather than producing a key with an empty segment, which
        // every order would then share.
        var orderId = ctx.HttpContext.Request.RouteValues["orderId"] as string;
        return Task.FromResult(string.IsNullOrEmpty(orderId)
            ? null
            : CacheKeys.Order(sub, userId, orderId, IncludeTracking(ctx)));
    }

    private static (string? Sub, string? UserId) Identity(ICurrentCaller caller) =>
        (caller.CognitoSub is { Length: > 0 } sub ? sub : null,
         caller.ResolvedInternalUserId is { Length: > 0 } id ? id : null);

    /// <summary>
    /// Reads the <c>includeTracking</c> query parameter the way ASP.NET's binder does.
    /// </summary>
    /// <remarks>
    /// The handler declares it as <c>bool includeTracking = false</c>, which the binder
    /// fills from the query string via <c>bool.TryParse</c> — case-insensitive, defaulting
    /// to false when absent or unparseable. Parsing it the same way here is what keeps the
    /// KEY and the BODY in agreement: a mismatch would file the tracking-bearing response
    /// under the <c>t0</c> key and serve it to a caller who asked for the bare shape.
    /// </remarks>
    private static bool IncludeTracking(EndpointFilterInvocationContext ctx) =>
        bool.TryParse(ctx.HttpContext.Request.Query["includeTracking"], out var value) && value;
}
