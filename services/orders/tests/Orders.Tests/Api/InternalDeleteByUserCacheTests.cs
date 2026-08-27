using System.Net;
using System.Net.Http.Json;
using Orders.Domain.Entities;
using Orders.Infrastructure.Caching;
using Orders.Infrastructure.Id;

namespace Orders.Tests.Api;

/// <summary>
/// <c>DELETE /v1/orders/by-user</c> — the account-deletion cascade — must forget every
/// cache entry belonging to the erased user.
/// </summary>
/// <remarks>
/// <para>
/// The cascade runs four <c>ExecuteUpdateAsync</c>/<c>SaveChanges</c> statements across
/// three tables and nothing else in the request would tell the cache those rows are gone.
/// Left alone, a deleted user's cart and orders keep being served from Redis for their
/// full TTL, and — worse — their identity mapping keeps resolving a sub that no longer
/// belongs to anybody for up to an HOUR, the longest-lived entry in the service.
/// </para>
/// <para>
/// <b>Why this class exists separately from <c>InternalDeleteByUserTests</c>.</b> That
/// class runs on <c>OrdersE2eApiFactory</c>, which owns no Redis container and runs with
/// <c>CACHE_ENABLED=false</c>. With the kill switch off no <c>ICacheGateway</c> is
/// registered, the filter skips itself, and no <c>X-Cache</c> header is emitted at all,
/// so every assertion here would read null there. <c>OrdersApiFactory</c> is the only
/// host in the suite with a live cache.
/// </para>
/// <para>
/// <b>Every test here WARMS before it deletes.</b> A test that deleted against a cold
/// cache would pass against a no-op invalidator — asserting only that a missing key is
/// missing — which is the precise shape of a cache assertion that cannot fail. The
/// <c>MISS -&gt; HIT</c> pair before each cascade is what makes the final <c>MISS</c>
/// mean something.
/// </para>
/// </remarks>
[Collection(OrdersApiCollection.Name)]
public class InternalDeleteByUserCacheTests
{
    private const string Path = "/v1/orders/by-user";

    private readonly OrdersApiFactory _factory;

    public InternalDeleteByUserCacheTests(OrdersApiFactory factory) => _factory = factory;

    private static string? CacheHeader(HttpResponseMessage response) =>
        response.Headers.TryGetValues("X-Cache", out var values)
            ? values.FirstOrDefault()
            : null;

    private HttpClient Client(string sub)
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("x-user-id", sub);
        return client;
    }

    /// <summary>The cascade call itself: internal key, both identities, as Users sends it.</summary>
    private async Task<HttpResponseMessage> CascadeAsync(string sub, string userId)
    {
        var request = new HttpRequestMessage(HttpMethod.Delete, Path)
        {
            Content = JsonContent.Create(new { cognitoSub = sub, userId }),
        };
        request.Headers.Add("x-api-key", "test-key");
        return await _factory.CreateClient().SendAsync(request);
    }

    [Fact]
    public async Task Cascade_invalidates_the_deleted_users_cart_and_orders()
    {
        await _factory.FlushCacheAsync();

        var client = Client(OrdersApiFactory.KnownCognitoSub);

        // Warm all three per-user families. my-orders is warmed in BOTH tracking
        // variants: t0 and t1 are separate keys, and the variable suffix is the whole
        // reason invalidation goes through the key index instead of naming keys.
        Assert.Equal("MISS", CacheHeader(await client.GetAsync("/v1/cart")));
        Assert.Equal("HIT", CacheHeader(await client.GetAsync("/v1/cart")));
        Assert.Equal("MISS", CacheHeader(await client.GetAsync("/v1/orders/my-orders")));
        Assert.Equal("HIT", CacheHeader(await client.GetAsync("/v1/orders/my-orders")));
        Assert.Equal(
            "MISS",
            CacheHeader(await client.GetAsync("/v1/orders/my-orders?includeTracking=true")));
        Assert.Equal(
            "HIT",
            CacheHeader(await client.GetAsync("/v1/orders/my-orders?includeTracking=true")));

        var response = await CascadeAsync(
            OrdersApiFactory.KnownCognitoSub, OrdersApiFactory.KnownUserId);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        // The whole point: nothing of this user's survives the cascade in the cache.
        Assert.Equal("MISS", CacheHeader(await client.GetAsync("/v1/cart")));
        Assert.Equal("MISS", CacheHeader(await client.GetAsync("/v1/orders/my-orders")));
        Assert.Equal(
            "MISS",
            CacheHeader(await client.GetAsync("/v1/orders/my-orders?includeTracking=true")));
    }

    [Fact]
    public async Task Cascade_invalidates_the_deleted_users_identity_mapping()
    {
        await _factory.FlushCacheAsync();

        const string sub = "sub-cascade-cache-identity";
        var key = CacheKeys.Identity(sub);

        // Seeded DIRECTLY rather than warmed through a request, and that is a statement
        // about this host rather than a shortcut. Both factories replace IUserDirectory
        // wholesale with a stub, which removes the CachedUserDirectory decorator that
        // writes this key in production — so no amount of HTTP traffic here would create
        // it, and a test that warmed it "through the API" would be asserting against a
        // key that never existed. Writing it by hand reproduces exactly what the real
        // decorator stores: the internal usr_ id, under the same key, with the same TTL.
        await _factory.SetCacheKeyAsync(key, "\"usr_cascade_cache\"", CacheKeys.IdentityTtl);
        Assert.True(await _factory.CacheKeyExistsAsync(key));

        var response = await CascadeAsync(sub, "usr_cascade_cache");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        // The entry NOT in the per-user index. Sweeping the index alone leaves this
        // behind, still resolving a sub whose account no longer exists, for the rest of
        // its 1h TTL — far longer than any response entry the sweep removes.
        Assert.False(await _factory.CacheKeyExistsAsync(key));
    }

    [Fact]
    public async Task Cascade_leaves_another_users_entries_alone()
    {
        // Invalidating one user must not degenerate into a FLUSHDB. A blunt
        // implementation passes both facts above and only fails here.
        await _factory.FlushCacheAsync();

        var other = Client(OrdersApiFactory.OtherCognitoSub);
        Assert.Equal("MISS", CacheHeader(await other.GetAsync("/v1/cart")));
        Assert.Equal("HIT", CacheHeader(await other.GetAsync("/v1/cart")));

        var response = await CascadeAsync(
            OrdersApiFactory.KnownCognitoSub, OrdersApiFactory.KnownUserId);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        Assert.Equal("HIT", CacheHeader(await other.GetAsync("/v1/cart")));
    }

    [Fact]
    public async Task Cascade_leaves_the_shared_product_catalogue_alone()
    {
        // The catalogue belongs to no user, and the cascade restores NO stock: it
        // soft-deletes orders, lines and carts and never writes product.units_in_stock
        // (unlike the E2E cleanup, which restocks and therefore must invalidate it).
        // Dropping this key would cold-start the catalogue for every other user to
        // reflect a change that did not happen.
        await _factory.FlushCacheAsync();

        var client = Client(OrdersApiFactory.KnownCognitoSub);
        Assert.Equal("MISS", CacheHeader(await client.GetAsync("/v1/products")));
        Assert.Equal("HIT", CacheHeader(await client.GetAsync("/v1/products")));

        var response = await CascadeAsync(
            OrdersApiFactory.KnownCognitoSub, OrdersApiFactory.KnownUserId);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        Assert.Equal("HIT", CacheHeader(await client.GetAsync("/v1/products")));
    }

    [Fact]
    public async Task A_cascade_that_deletes_nothing_still_invalidates()
    {
        // The counts the cascade reports say nothing about what is CACHED. A user with
        // no live orders can still have a warm cart entry and a warm identity mapping —
        // an empty cart is cached like any other response — so gating invalidation on a
        // non-zero deleted count would strand exactly those entries. This pins that the
        // invalidation is unconditional.
        await _factory.FlushCacheAsync();

        const string sub = "sub-cascade-cache-empty";
        var key = CacheKeys.Identity(sub);
        await _factory.SetCacheKeyAsync(key, "\"usr_cascade_empty\"", CacheKeys.IdentityTtl);

        var response = await CascadeAsync(sub, "usr_cascade_empty");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        Assert.False(await _factory.CacheKeyExistsAsync(key));
    }
}
