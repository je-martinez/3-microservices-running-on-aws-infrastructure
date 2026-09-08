using Orders.Api.Identity;
using Orders.Infrastructure.Caching;

namespace Orders.Api.Caching;

/// <summary>
/// The <see cref="CacheKeyBuilder"/> implementations for the three per-user reads.
/// </summary>
/// <remarks>
/// CONTRACT: Return <c>null</c> when either identifier is missing. Users being down leaves an
/// authenticated caller with no resolved id, and building a key anyway puts an empty segment
/// where <c>user_id</c> belongs — every unresolvable caller then SHARES that one key, serving
/// one user's cart to another.
/// CONTRACT: Never call <see cref="ICurrentCaller.ResolveInternalUserIdAsync"/> here. These
/// run on the HIT path, so a resolving key builder reintroduces the gRPC call the cache
/// exists to remove. See [[x-cache-response-header]]
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
    /// Reads <c>includeTracking</c> the way ASP.NET's binder does.
    /// CONTRACT: Parse exactly as the binder does (<c>bool.TryParse</c>, defaulting false) —
    /// a mismatch files the tracking-bearing response under the <c>t0</c> key.
    /// See [[x-cache-response-header]]
    /// </summary>
    private static bool IncludeTracking(EndpointFilterInvocationContext ctx) =>
        bool.TryParse(ctx.HttpContext.Request.Query["includeTracking"], out var value) && value;
}
