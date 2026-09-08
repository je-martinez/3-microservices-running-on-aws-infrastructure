using System.Net;

namespace Orders.Tests.Api;

/// <summary>
/// <c>DELETE /v1/orders/e2e-cleanup</c> must forget the product catalogue it restocked.
/// </summary>
/// <remarks>
/// CONTRACT: The restock uses <c>ExecuteUpdateAsync</c>, which bypasses <c>SaveChanges</c>
/// and every interceptor, so without an explicit invalidation the cached catalogue reports
/// the drained stock for its full 10-minute TTL — longer than an E2E suite runs, so the next
/// run reads zeroes and fails on fixtures that merely place an order.
/// CONTRACT: Keep this separate from <c>E2eTagsAndCleanupTests</c>, which runs with
/// <c>CACHE_ENABLED=false</c> and emits no <c>X-Cache</c> header at all — the assertion is
/// unmakeable there. See [[x-cache-response-header]]
/// </remarks>
[Collection(OrdersApiCollection.Name)]
public class E2eCleanupCacheTests
{
    private readonly OrdersApiFactory _factory;

    public E2eCleanupCacheTests(OrdersApiFactory factory) => _factory = factory;

    private static string? CacheHeader(HttpResponseMessage response) =>
        response.Headers.TryGetValues("X-Cache", out var values)
            ? values.FirstOrDefault()
            : null;

    [Fact]
    public async Task E2e_cleanup_invalidates_the_product_catalogue()
    {
        await _factory.FlushCacheAsync();

        // Same host, same Redis, same MySQL — only the route-mapping flag differs.
        var host = _factory.WithWebHostBuilder(b => b.UseSetting("E2E_TESTING_ENABLED", "true"));
        var client = host.CreateClient();
        client.DefaultRequestHeaders.Add("x-user-id", OrdersApiFactory.KnownCognitoSub);

        Assert.Equal("MISS", CacheHeader(await client.GetAsync("/v1/products")));
        Assert.Equal("HIT", CacheHeader(await client.GetAsync("/v1/products")));

        var cleanup = await client.DeleteAsync("/v1/orders/e2e-cleanup");
        Assert.Equal(HttpStatusCode.OK, cleanup.StatusCode);

        // The whole point: the restock is invisible to a client until this MISS.
        Assert.Equal("MISS", CacheHeader(await client.GetAsync("/v1/products")));
    }

    [Fact]
    public async Task The_cleanup_leaves_other_cache_families_alone()
    {
        // Invalidating the catalogue must not degenerate into a FLUSHDB. The cleanup has
        // no caller identity to sweep by and has no business touching per-user entries;
        // a blunt implementation would pass the fact above and only fail here.
        await _factory.FlushCacheAsync();

        var host = _factory.WithWebHostBuilder(b => b.UseSetting("E2E_TESTING_ENABLED", "true"));
        var client = host.CreateClient();
        client.DefaultRequestHeaders.Add("x-user-id", OrdersApiFactory.KnownCognitoSub);

        await client.GetAsync("/v1/cart");
        Assert.Equal("HIT", CacheHeader(await client.GetAsync("/v1/cart")));

        Assert.Equal(
            HttpStatusCode.OK,
            (await client.DeleteAsync("/v1/orders/e2e-cleanup")).StatusCode);

        Assert.Equal("HIT", CacheHeader(await client.GetAsync("/v1/cart")));
    }
}
