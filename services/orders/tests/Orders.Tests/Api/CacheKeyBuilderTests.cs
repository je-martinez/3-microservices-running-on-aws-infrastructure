using Microsoft.AspNetCore.Http;
using Orders.Api.Caching;
using Orders.Api.Identity;
using Orders.Infrastructure.Caching;

namespace Orders.Tests.Api;

/// <summary>
/// The three per-user key builders, in isolation: no HTTP host, no Redis, no fixture.
/// </summary>
/// <remarks>
/// Worth a pure unit test rather than only the endpoint tests, because the property that
/// matters most here is a NEGATIVE one — that no key is produced when the caller's
/// internal id is unknown — and an endpoint test cannot distinguish "declined to build a
/// key" from "built a key and Redis was down". Both are a MISS on the wire.
/// </remarks>
public class CacheKeyBuilderTests
{
    // CallerContextMiddleware.StampInternalUserIdAsync swallows EVERY non-cancellation
    // failure, so an authenticated caller can reach a handler with CognitoSub set and
    // ResolvedInternalUserId still null (Users down, an unknown sub, a gRPC deadline).
    // Building a key anyway would produce ONE key with an empty user_id segment shared by
    // every unresolvable caller — a cross-user leak. Declining costs a cache miss.
    private sealed class FakeCaller : ICurrentCaller
    {
        public string? CognitoSub { get; private set; }

        public string? ResolvedInternalUserId { get; init; }

        public void SetSub(string sub) => CognitoSub = sub;

        // The builders run on the HIT path, where the entire point is to avoid the
        // network. One that resolved would reintroduce the gRPC call the cache exists to
        // remove, so the fake fails loudly rather than quietly answering.
        public Task<string> ResolveInternalUserIdAsync(CancellationToken ct) =>
            throw new InvalidOperationException(
                "The key builders must never trigger resolution: they run on the hit path.");
    }

    private static FakeCaller Caller(string? sub, string? userId)
    {
        var caller = new FakeCaller { ResolvedInternalUserId = userId };
        if (sub is not null)
        {
            caller.SetSub(sub);
        }

        return caller;
    }

    private static EndpointFilterInvocationContext ContextFor(
        string? queryString = null,
        string? orderId = null)
    {
        var http = new DefaultHttpContext();
        http.Request.QueryString = new QueryString(queryString ?? string.Empty);
        if (orderId is not null)
        {
            http.Request.RouteValues["orderId"] = orderId;
        }

        return EndpointFilterInvocationContext.Create(http);
    }

    [Fact]
    public async Task Cart_key_is_null_when_the_internal_user_id_is_unresolved()
    {
        Assert.Null(await UserCacheKeyBuilders.Cart(ContextFor(), Caller("sub-known", null)));
    }

    [Fact]
    public async Task MyOrders_key_is_null_when_the_internal_user_id_is_unresolved()
    {
        Assert.Null(await UserCacheKeyBuilders.MyOrders(ContextFor(), Caller("sub-known", null)));
    }

    [Fact]
    public async Task OrderById_key_is_null_when_the_internal_user_id_is_unresolved()
    {
        Assert.Null(await UserCacheKeyBuilders.OrderById(
            ContextFor(orderId: "ord_abc"), Caller("sub-known", null)));
    }

    [Fact]
    public async Task Every_key_is_null_when_there_is_no_sub_at_all()
    {
        var caller = Caller(null, "usr_known");

        Assert.Null(await UserCacheKeyBuilders.Cart(ContextFor(), caller));
        Assert.Null(await UserCacheKeyBuilders.MyOrders(ContextFor(), caller));
        Assert.Null(await UserCacheKeyBuilders.OrderById(ContextFor(orderId: "ord_abc"), caller));
    }

    [Fact]
    public async Task Cart_key_is_built_when_both_identifiers_are_present()
    {
        Assert.Equal(
            CacheKeys.Cart("sub-known", "usr_known"),
            await UserCacheKeyBuilders.Cart(ContextFor(), Caller("sub-known", "usr_known")));
    }

    // includeTracking is a QUERY-bound bool defaulting to false (OrderEndpoints.cs). The
    // filter runs before the handler's parameters are bound, so the builder reads the raw
    // query string — and it must agree with ASP.NET's binder about what counts as true,
    // or the tracking-bearing body lands under the t0 key and is served to a caller who
    // asked for the bare shape.
    [Theory]
    [InlineData("", false)]
    [InlineData("?includeTracking=false", false)]
    [InlineData("?includeTracking=true", true)]
    [InlineData("?includeTracking=TRUE", true)]
    [InlineData("?includeTracking=notabool", false)]
    public async Task MyOrders_key_varies_with_includeTracking(string query, bool expected)
    {
        Assert.Equal(
            CacheKeys.MyOrders("sub-known", "usr_known", expected),
            await UserCacheKeyBuilders.MyOrders(
                ContextFor(query), Caller("sub-known", "usr_known")));
    }

    [Theory]
    [InlineData("", false)]
    [InlineData("?includeTracking=true", true)]
    public async Task OrderById_key_carries_the_order_id_and_the_tracking_flag(
        string query, bool expected)
    {
        Assert.Equal(
            CacheKeys.Order("sub-known", "usr_known", "ord_abc", expected),
            await UserCacheKeyBuilders.OrderById(
                ContextFor(query, "ord_abc"), Caller("sub-known", "usr_known")));
    }

    [Fact]
    public async Task OrderById_key_is_null_when_the_route_carries_no_order_id()
    {
        // Not reachable through the current route template, but the builder is public and
        // a key with an empty id segment would be a SHARED entry across every order.
        Assert.Null(await UserCacheKeyBuilders.OrderById(
            ContextFor(), Caller("sub-known", "usr_known")));
    }
}
