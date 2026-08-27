using System.Net;
using System.Net.Http.Json;
using Orders.Application.Orders;

namespace Orders.Tests.Api;

/// <summary>
/// <c>GET /v1/products</c> through the real HTTP surface, against a real Redis.
/// </summary>
/// <remarks>
/// The catalogue is the simplest cached endpoint in the service — it belongs to no user,
/// so it needs no key index and cannot leak across callers — which makes it the right
/// place to pin the <c>X-Cache</c> contract itself.
/// </remarks>
[Collection(OrdersApiCollection.Name)]
public class ProductCacheTests
{
    private readonly OrdersApiFactory _factory;

    public ProductCacheTests(OrdersApiFactory factory) => _factory = factory;

    private HttpClient Client(string sub)
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("x-user-id", sub);
        return client;
    }

    [Fact]
    public async Task First_read_is_a_MISS_and_the_second_is_a_HIT_with_a_ttl()
    {
        // The factory is a collection fixture, so another class may already have warmed
        // this key. Flush rather than depend on test ordering.
        await _factory.FlushCacheAsync();
        var client = Client(OrdersApiFactory.KnownCognitoSub);

        var first = await client.GetAsync("/v1/products");
        var second = await client.GetAsync("/v1/products");

        Assert.Equal("MISS", first.Headers.GetValues("X-Cache").Single());
        Assert.False(first.Headers.Contains("X-Cache-TTL"));

        Assert.Equal("HIT", second.Headers.GetValues("X-Cache").Single());
        var ttl = int.Parse(second.Headers.GetValues("X-Cache-TTL").Single());
        Assert.InRange(ttl, 1, 600);
    }

    [Fact]
    public async Task A_hit_returns_the_same_body_as_the_miss()
    {
        await _factory.FlushCacheAsync();
        var client = Client(OrdersApiFactory.KnownCognitoSub);

        var miss = await client.GetFromJsonAsync<List<ProductDto>>("/v1/products");
        var hit = await client.GetFromJsonAsync<List<ProductDto>>("/v1/products");

        Assert.NotNull(miss);
        Assert.NotNull(hit);
        Assert.Equal(miss!.Count, hit!.Count);
        Assert.Equal(miss.Select(p => p.Id), hit.Select(p => p.Id));
        Assert.Equal(
            miss.Single(p => p.Id == _factory.SeededProductId).UnitPrice.Cents,
            hit.Single(p => p.Id == _factory.SeededProductId).UnitPrice.Cents);
    }

    [Fact]
    public async Task A_hit_replays_the_miss_byte_for_byte()
    {
        // The assertion the typed one above cannot make. A cached body serialized with
        // JsonSerializer's DEFAULTS rather than the app's options comes back PascalCase
        // ("UnitPrice") where the MISS produced camelCase ("unitPrice") — and
        // System.Text.Json is case-INSENSITIVE on the web defaults, so the typed
        // round-trip above still passes while every real client silently reads nulls and
        // zeroes. Comparing the raw strings is what actually pins the contract.
        await _factory.FlushCacheAsync();
        var client = Client(OrdersApiFactory.KnownCognitoSub);

        var miss = await client.GetAsync("/v1/products");
        var hit = await client.GetAsync("/v1/products");

        Assert.Equal("MISS", miss.Headers.GetValues("X-Cache").Single());
        Assert.Equal("HIT", hit.Headers.GetValues("X-Cache").Single());
        Assert.Equal(
            await miss.Content.ReadAsStringAsync(),
            await hit.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task An_unauthenticated_request_is_401_and_carries_no_cache_header()
    {
        // The 401 short-circuits in CallerContextMiddleware, BEFORE routing — so the
        // filter never runs and must not have stamped a header. This is the reason the
        // cache is an endpoint filter rather than middleware.
        var resp = await _factory.CreateClient().GetAsync("/v1/products");

        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
        Assert.False(resp.Headers.Contains("X-Cache"));
    }

    [Fact]
    public async Task With_the_cache_disabled_no_X_Cache_header_is_emitted_at_all()
    {
        // The kill switch's contract: CACHE_ENABLED=false registers NO ICacheGateway, so
        // the filter resolves it as null and skips itself entirely. Not "always BYPASS" —
        // a disabled cache is invisible, and a header saying otherwise would make the
        // load-test A/B measure a cache that is not there.
        var disabled = _factory.WithWebHostBuilder(b => b.UseSetting("CACHE_ENABLED", "false"));
        var client = disabled.CreateClient();
        client.DefaultRequestHeaders.Add("x-user-id", OrdersApiFactory.KnownCognitoSub);

        var resp = await client.GetAsync("/v1/products");

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        Assert.False(resp.Headers.Contains("X-Cache"));
        Assert.False(resp.Headers.Contains("X-Cache-TTL"));
    }

    [Fact]
    public async Task The_catalogue_entry_is_shared_across_callers()
    {
        // Products belong to no user, so a second caller must be served the FIRST
        // caller's entry — the one endpoint in this service where that is correct rather
        // than a leak. (Per-user routes get the opposite assertion in Task 3.)
        await _factory.FlushCacheAsync();

        var first = await Client(OrdersApiFactory.KnownCognitoSub).GetAsync("/v1/products");
        var second = await Client("sub-someone-else").GetAsync("/v1/products");

        Assert.Equal("MISS", first.Headers.GetValues("X-Cache").Single());
        Assert.Equal("HIT", second.Headers.GetValues("X-Cache").Single());
    }
}
