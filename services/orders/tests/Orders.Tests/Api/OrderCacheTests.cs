using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;

namespace Orders.Tests.Api;

/// <summary>
/// <c>GET /v1/orders/my-orders</c>, <c>GET /v1/orders/{orderId}</c>, and the invalidation
/// order creation owes all three cached families at once.
/// </summary>
[Collection(OrdersApiCollection.Name)]
public class OrderCacheTests
{
    private readonly OrdersApiFactory _factory;

    public OrderCacheTests(OrdersApiFactory factory) => _factory = factory;

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

    // The two includeTracking variants return DIFFERENT SHAPES from one route: a bare
    // OrderDto list at t0, an OrderWithTrackingDto[] at t1. If they shared a key,
    // whichever ran first would serve its shape to the other — a caller asking for
    // tracking would get a list with no `tracking` key, or a caller asking for the bare
    // list would get objects wrapped under `order`.
    //
    // Asserted on the BODY SHAPE, not merely on X-Cache. A key that varied while the body
    // did not would pass a header-only assertion while serving the wrong shape, and a key
    // that did NOT vary would be caught only here.
    [Fact]
    public async Task Include_tracking_variants_are_cached_under_separate_keys()
    {
        await _factory.FlushCacheAsync();
        var client = Client(OrdersApiFactory.KnownCognitoSub);

        // At least one order, so the two shapes have an element to differ on. Without a
        // row both bodies are `[]` and the shape assertions below are vacuous.
        var productId = await SeedProductAsync(stock: 10, priceCents: 1000);
        var created = await client.PostAsJsonAsync("/v1/orders", new
        {
            lines = new[] { new { productId, quantity = 1 } },
        });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        await _factory.FlushCacheAsync();

        var bareFirst = await client.GetAsync("/v1/orders/my-orders");
        Assert.Equal(HttpStatusCode.OK, bareFirst.StatusCode);
        Assert.Equal("MISS", CacheHeader(bareFirst));

        // A SECOND read at the same variant hits...
        Assert.Equal("HIT", CacheHeader(await client.GetAsync("/v1/orders/my-orders")));

        // ...but the OTHER variant is a fresh key, so it must MISS, not inherit the hit.
        var wrappedFirst = await client.GetAsync("/v1/orders/my-orders?includeTracking=true");
        Assert.Equal("MISS", CacheHeader(wrappedFirst));
        Assert.Equal(
            "HIT",
            CacheHeader(await client.GetAsync("/v1/orders/my-orders?includeTracking=true")));

        // And the cached bodies keep their own shapes. Both are arrays; the wrapped one's
        // elements carry an `order` object, the bare one's carry `id` directly.
        var bareResponse = await client.GetAsync("/v1/orders/my-orders");
        var wrappedResponse = await client.GetAsync("/v1/orders/my-orders?includeTracking=true");
        Assert.Equal("HIT", CacheHeader(bareResponse));
        Assert.Equal("HIT", CacheHeader(wrappedResponse));

        var bare = await bareResponse.Content.ReadFromJsonAsync<JsonElement>();
        var wrapped = await wrappedResponse.Content.ReadFromJsonAsync<JsonElement>();

        Assert.NotEmpty(bare.EnumerateArray());
        Assert.NotEmpty(wrapped.EnumerateArray());

        foreach (var element in bare.EnumerateArray())
        {
            Assert.True(element.TryGetProperty("id", out _));
            Assert.False(element.TryGetProperty("order", out _));
        }

        foreach (var element in wrapped.EnumerateArray())
        {
            Assert.True(element.TryGetProperty("order", out _));
            Assert.False(element.TryGetProperty("id", out _));
        }
    }

    // One create-order commit makes THREE things stale at once: the cart it consumed,
    // every my-orders entry (the new order belongs in the list), and the shared product
    // catalogue (stock decremented). Missing any one of the three is a silent staleness
    // bug, so all three are asserted in a single test rather than three that could each
    // pass while the composite behaviour is wrong.
    [Fact]
    public async Task Creating_an_order_invalidates_cart_my_orders_and_products()
    {
        await _factory.FlushCacheAsync();
        var client = Client(OrdersApiFactory.KnownCognitoSub);

        var productId = await SeedProductAsync(stock: 10, priceCents: 1000);
        await client.PutAsJsonAsync("/v1/cart", new
        {
            items = new[] { new { productId, quantity = 1 } },
        });

        // Warm all three to a confirmed HIT, so the cache definitely holds each entry
        // before the write. Warming without confirming would let a never-cached entry
        // masquerade as a correctly-invalidated one.
        await client.GetAsync("/v1/cart");
        Assert.Equal("HIT", CacheHeader(await client.GetAsync("/v1/cart")));
        await client.GetAsync("/v1/orders/my-orders");
        Assert.Equal("HIT", CacheHeader(await client.GetAsync("/v1/orders/my-orders")));
        await client.GetAsync("/v1/products");
        Assert.Equal("HIT", CacheHeader(await client.GetAsync("/v1/products")));

        var created = await client.PostAsJsonAsync("/v1/orders", new
        {
            lines = new[] { new { productId, quantity = 1 } },
        });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var createdId = (await created.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString();

        Assert.Equal("MISS", CacheHeader(await client.GetAsync("/v1/cart")));
        Assert.Equal("MISS", CacheHeader(await client.GetAsync("/v1/orders/my-orders")));
        Assert.Equal("MISS", CacheHeader(await client.GetAsync("/v1/products")));

        // Not just a MISS — the refreshed my-orders body must actually contain the new
        // order. A MISS proves the entry was removed; this proves the removal happened
        // AFTER the commit and not before it (invalidating first would let this very read
        // repopulate the pre-order list).
        var orders = await (await client.GetAsync("/v1/orders/my-orders"))
            .Content.ReadFromJsonAsync<JsonElement>();
        Assert.Contains(
            orders.EnumerateArray(),
            o => o.GetProperty("id").GetString() == createdId);

        // And the cart really is empty now, not merely uncached: order creation deletes
        // it inside its own transaction.
        var cart = await (await client.GetAsync("/v1/cart"))
            .Content.ReadFromJsonAsync<JsonElement>();
        Assert.Empty(cart.GetProperty("items").EnumerateArray());
    }

    [Fact]
    public async Task Order_by_id_is_cached_and_a_404_is_not()
    {
        await _factory.FlushCacheAsync();
        var client = Client(OrdersApiFactory.KnownCognitoSub);

        var productId = await SeedProductAsync(stock: 10, priceCents: 1000);
        var created = await client.PostAsJsonAsync("/v1/orders", new
        {
            lines = new[] { new { productId, quantity = 1 } },
        });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var orderId = (await created.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString();

        Assert.Equal("MISS", CacheHeader(await client.GetAsync($"/v1/orders/{orderId}")));
        var hit = await client.GetAsync($"/v1/orders/{orderId}");
        Assert.Equal("HIT", CacheHeader(hit));
        // The replayed body is the order, not an empty document.
        var body = await hit.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(orderId, body.GetProperty("id").GetString());

        // A 404 is never stored: only 200s are cached. Two consecutive misses on a
        // non-existent id is the observable proof — a filter that cached every result
        // would report HIT on the second.
        var missing = "ord_doesnotexist01";
        Assert.Equal(
            HttpStatusCode.NotFound,
            (await client.GetAsync($"/v1/orders/{missing}")).StatusCode);
        Assert.Equal("MISS", CacheHeader(await client.GetAsync($"/v1/orders/{missing}")));
        Assert.Equal("MISS", CacheHeader(await client.GetAsync($"/v1/orders/{missing}")));
    }

    [Fact]
    public async Task An_order_by_id_hit_replays_the_miss_byte_for_byte()
    {
        // An order carries four money figures (subtotal, tax, shipping, total), each a
        // nested object with `cents` and `amount`. A serializer mismatch corrupts all of
        // them at once and a typed round-trip still passes, because System.Text.Json reads
        // case-insensitively on the web defaults.
        await _factory.FlushCacheAsync();
        var client = Client(OrdersApiFactory.KnownCognitoSub);

        var productId = await SeedProductAsync(stock: 10, priceCents: 1000);
        var created = await client.PostAsJsonAsync("/v1/orders", new
        {
            lines = new[] { new { productId, quantity = 1 } },
        });
        var orderId = (await created.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString();

        var miss = await client.GetAsync($"/v1/orders/{orderId}");
        var hit = await client.GetAsync($"/v1/orders/{orderId}");

        Assert.Equal("MISS", CacheHeader(miss));
        Assert.Equal("HIT", CacheHeader(hit));

        var missBody = await miss.Content.ReadAsStringAsync();
        Assert.Equal(missBody, await hit.Content.ReadAsStringAsync());
        // camelCase, as Minimal APIs emit it — the property a PascalCase default would
        // silently change.
        Assert.Contains("\"subtotal\":", missBody);
    }

    // A DEDICATED product per order, not the factory's SeededProductId. That row carries
    // exactly 5 units and CreateOrderEndpointTests consumes all of them; an order placed
    // here against it starves that class into a 409 in a full run while every test in
    // this file still passes on its own. Same pattern as CartCheckoutTests.
    private async Task<string> SeedProductAsync(uint stock, long priceCents)
    {
        await using var db = _factory.NewWriteContext();
        var id = NanoId.NewId(NanoId.ProductPrefix);
        db.Products.Add(new Product
        {
            Id = id,
            Name = "Widget",
            Description = "d",
            UnitPriceCents = priceCents,
            UnitsInStock = stock,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow,
        });
        await db.SaveChangesAsync();
        return id;
    }
}
