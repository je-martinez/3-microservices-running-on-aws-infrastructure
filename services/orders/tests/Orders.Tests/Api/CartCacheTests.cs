using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Orders.Tests.Api;

/// <summary>
/// <c>GET /v1/cart</c> and the invalidation every cart write owes it.
/// </summary>
/// <remarks>
/// The cart is the endpoint where staleness is most visible to a user: they change it and
/// immediately read it back. A 60s TTL is nowhere near tight enough to cover that, so the
/// correctness here comes entirely from the explicit invalidation — which is why every
/// fact below asserts on the BODY as well as on the <c>X-Cache</c> header. A header alone
/// cannot distinguish "invalidated correctly" from "never cached at all".
/// </remarks>
[Collection(OrdersApiCollection.Name)]
public class CartCacheTests
{
    private readonly OrdersApiFactory _factory;

    public CartCacheTests(OrdersApiFactory factory) => _factory = factory;

    private HttpClient Client(string sub)
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("x-user-id", sub);
        return client;
    }

    private static string? CacheHeader(HttpResponseMessage response) =>
        response.Headers.TryGetValues("X-Cache", out var values)
            ? values.FirstOrDefault()
            : null;

    [Fact]
    public async Task Second_cart_read_is_a_hit_and_a_put_returns_it_to_a_miss()
    {
        // The factory's Redis is a COLLECTION fixture shared with every other class in
        // OrdersApiCollection. Without this flush, an entry another class left behind
        // decides whether the first read below is a MISS.
        await _factory.FlushCacheAsync();

        // KnownCognitoSub is the only sub this factory's stub IUserDirectory resolves, and
        // an unresolved sub leaves ResolvedInternalUserId null — which makes the key
        // builder decline and nothing is cached at all. This test needs a caller the cache
        // will actually key on.
        var client = Client(OrdersApiFactory.KnownCognitoSub);

        // Start from a known cart state rather than whatever an earlier class left in the
        // shared database: this class asserts on item counts.
        await client.DeleteAsync("/v1/cart");
        await _factory.FlushCacheAsync();

        var first = await client.GetAsync("/v1/cart");
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.Equal("MISS", CacheHeader(first));
        // A MISS carries no TTL header — only a HIT does.
        Assert.False(first.Headers.Contains("X-Cache-TTL"));

        var second = await client.GetAsync("/v1/cart");
        Assert.Equal("HIT", CacheHeader(second));
        Assert.True(second.Headers.Contains("X-Cache-TTL"));
        var ttl = int.Parse(second.Headers.GetValues("X-Cache-TTL").First());
        Assert.InRange(ttl, 1, 60); // CacheKeys.CartTtl is 60s.

        // The write in between must invalidate.
        var put = await client.PutAsJsonAsync("/v1/cart", new
        {
            items = new[] { new { productId = _factory.SeededProductId, quantity = 1 } },
        });
        Assert.Equal(HttpStatusCode.OK, put.StatusCode);

        var third = await client.GetAsync("/v1/cart");
        Assert.Equal("MISS", CacheHeader(third));

        // And the body must be the NEW cart, not the empty one that was cached. This is
        // the assertion that would fail if the invalidation ran BEFORE the commit and a
        // read repopulated the old value.
        var body = await third.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Single(body.GetProperty("items").EnumerateArray());

        await client.DeleteAsync("/v1/cart");
    }

    [Fact]
    public async Task A_cart_hit_replays_the_miss_byte_for_byte()
    {
        // The cart carries money (per-line and per-cart totals), which is exactly the
        // shape a serializer mismatch corrupts invisibly: a body cached with
        // JsonSerializer's PascalCase defaults still round-trips through a typed
        // assertion, because System.Text.Json reads case-insensitively on the web
        // defaults — while every real client reads nulls and zeroes. Only the raw strings
        // pin it.
        await _factory.FlushCacheAsync();
        var client = Client(OrdersApiFactory.KnownCognitoSub);

        await client.PutAsJsonAsync("/v1/cart", new
        {
            items = new[] { new { productId = _factory.SeededProductId, quantity = 2 } },
        });
        await _factory.FlushCacheAsync();

        var miss = await client.GetAsync("/v1/cart");
        var hit = await client.GetAsync("/v1/cart");

        Assert.Equal("MISS", CacheHeader(miss));
        Assert.Equal("HIT", CacheHeader(hit));
        Assert.Equal(
            await miss.Content.ReadAsStringAsync(),
            await hit.Content.ReadAsStringAsync());
        // Not a trivially-equal pair of empty bodies: the cart really does carry the line.
        Assert.Contains("\"quantity\":2", await hit.Content.ReadAsStringAsync());

        await client.DeleteAsync("/v1/cart");
    }

    [Fact]
    public async Task Delete_cart_invalidates_the_cached_cart()
    {
        await _factory.FlushCacheAsync();
        var client = Client(OrdersApiFactory.KnownCognitoSub);

        await client.PutAsJsonAsync("/v1/cart", new
        {
            items = new[] { new { productId = _factory.SeededProductId, quantity = 2 } },
        });

        Assert.Equal("MISS", CacheHeader(await client.GetAsync("/v1/cart")));
        Assert.Equal("HIT", CacheHeader(await client.GetAsync("/v1/cart")));

        var deleted = await client.DeleteAsync("/v1/cart");
        Assert.Equal(HttpStatusCode.NoContent, deleted.StatusCode);

        var after = await client.GetAsync("/v1/cart");
        Assert.Equal("MISS", CacheHeader(after));
        var body = await after.Content.ReadFromJsonAsync<JsonElement>();
        // The cart is gone: GET always answers 200 with the empty shape, never a 404 —
        // and crucially not the two-unit cart that was cached a moment ago.
        Assert.Empty(body.GetProperty("items").EnumerateArray());
    }

    [Fact]
    public async Task An_emptying_put_invalidates_too()
    {
        // ReplaceAsync commits in three different places and only one of them is the
        // "normal" path. This exercises the EMPTIED branch, which returns before the
        // normal commit is ever reached — an invalidation hooked to that commit site
        // alone would leave the pre-empty cart cached here while every other fact in this
        // class still passed.
        await _factory.FlushCacheAsync();
        var client = Client(OrdersApiFactory.KnownCognitoSub);

        await client.PutAsJsonAsync("/v1/cart", new
        {
            items = new[] { new { productId = _factory.SeededProductId, quantity = 2 } },
        });

        Assert.Equal("MISS", CacheHeader(await client.GetAsync("/v1/cart")));
        Assert.Equal("HIT", CacheHeader(await client.GetAsync("/v1/cart")));

        // items: [] is the documented way to empty (and therefore delete) the cart, and
        // it never resolves identity — so it takes the emptied branch's own commit.
        var emptied = await client.PutAsJsonAsync("/v1/cart", new { items = Array.Empty<object>() });
        Assert.Equal(HttpStatusCode.OK, emptied.StatusCode);

        var after = await client.GetAsync("/v1/cart");
        Assert.Equal("MISS", CacheHeader(after));
        var body = await after.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Empty(body.GetProperty("items").EnumerateArray());
    }

    [Fact]
    public async Task A_caller_whose_identity_cannot_be_resolved_is_never_cached()
    {
        // The stub directory resolves only KnownCognitoSub, so this caller reaches the
        // handler authenticated but with a null ResolvedInternalUserId — the exact state
        // CallerContextMiddleware leaves behind when Users is down. The key builder must
        // decline, which means NO X-Cache header at all (the filter returns before it
        // touches Redis), not a MISS and not a shared key.
        await _factory.FlushCacheAsync();
        var client = Client("sub-unresolvable");

        var first = await client.GetAsync("/v1/cart");
        var second = await client.GetAsync("/v1/cart");

        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.Null(CacheHeader(first));
        Assert.Null(CacheHeader(second));
    }
}
