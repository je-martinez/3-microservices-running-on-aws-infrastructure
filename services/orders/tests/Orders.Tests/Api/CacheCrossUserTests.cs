using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;

namespace Orders.Tests.Api;

/// <summary>
/// The property no other test in this task can establish: one caller is never served
/// another caller's cached response, and one caller's write never blows away another's
/// entry.
/// </summary>
/// <remarks>
/// <para>
/// Every other cache test could pass while the cache still served user A's cart to user B
/// — the only way that surfaces is by asking two DIFFERENT callers for the same route and
/// comparing the bodies.
/// </para>
/// <para>
/// <b>It needs two callers the directory actually resolves.</b> A second caller the stub
/// does not know reaches the handler with a null <c>ResolvedInternalUserId</c>, so the key
/// builder declines and nothing is cached for them at all — the isolation assertion would
/// then pass because caching was SKIPPED, not because the keys were scoped, and it would
/// keep passing if the keys stopped carrying identity entirely. <c>OrdersApiFactory</c>
/// grew an <c>OtherCognitoSub</c> for exactly this.
/// </para>
/// <para>
/// <b>Not <c>OrdersE2eApiFactory</c>, despite it already having two identities.</b> That
/// host runs with <c>CACHE_ENABLED=false</c> and owns no Redis container — deliberately,
/// so a regression that made the service require Redis unconditionally fails there. With
/// the kill switch off no <c>ICacheGateway</c> is registered, the filter skips itself, and
/// no <c>X-Cache</c> header is emitted at all, so every assertion here would read null.
/// This factory is the only one in the suite with a live cache.
/// </para>
/// </remarks>
[Collection(OrdersApiCollection.Name)]
public class CacheCrossUserTests
{
    private readonly OrdersApiFactory _factory;

    public CacheCrossUserTests(OrdersApiFactory factory) => _factory = factory;

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
    public async Task User_b_never_receives_user_a_cached_cart()
    {
        await _factory.FlushCacheAsync();

        var a = Client(OrdersApiFactory.KnownCognitoSub);
        var b = Client(OrdersApiFactory.OtherCognitoSub);

        // Start both from a known state — the database is shared with every other class
        // in this collection.
        await a.DeleteAsync("/v1/cart");
        await b.DeleteAsync("/v1/cart");

        // A has a cart with three units.
        var putA = await a.PutAsJsonAsync("/v1/cart", new
        {
            items = new[] { new { productId = _factory.SeededProductId, quantity = 3 } },
        });
        Assert.Equal(HttpStatusCode.OK, putA.StatusCode);

        await _factory.FlushCacheAsync();

        // Warm A's entry to a confirmed HIT, so the cache definitely holds A's cart.
        Assert.Equal("MISS", CacheHeader(await a.GetAsync("/v1/cart")));
        Assert.Equal("HIT", CacheHeader(await a.GetAsync("/v1/cart")));

        // B, who has no cart at all, must MISS — a HIT here would already mean B read A's
        // entry.
        var firstB = await b.GetAsync("/v1/cart");
        Assert.Equal("MISS", CacheHeader(firstB));

        // And the BODY is B's own empty cart, not A's three units. The header alone is not
        // enough: a filter that keyed correctly but served the wrong stored value would
        // still report MISS on this first read.
        var bodyB = await firstB.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Empty(bodyB.GetProperty("items").EnumerateArray());

        // B's own second read hits B's own entry, still empty.
        var secondB = await b.GetAsync("/v1/cart");
        Assert.Equal("HIT", CacheHeader(secondB));
        var secondBodyB = await secondB.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Empty(secondBodyB.GetProperty("items").EnumerateArray());

        // A is untouched by any of B's traffic.
        var bodyA = await (await a.GetAsync("/v1/cart")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(
            3,
            bodyA.GetProperty("items").EnumerateArray().First().GetProperty("quantity").GetInt32());

        await a.DeleteAsync("/v1/cart");
    }

    [Fact]
    public async Task Invalidating_user_a_does_not_invalidate_user_b()
    {
        await _factory.FlushCacheAsync();

        var a = Client(OrdersApiFactory.KnownCognitoSub);
        var b = Client(OrdersApiFactory.OtherCognitoSub);

        await a.GetAsync("/v1/cart");
        await b.GetAsync("/v1/cart");
        Assert.Equal("HIT", CacheHeader(await a.GetAsync("/v1/cart")));
        Assert.Equal("HIT", CacheHeader(await b.GetAsync("/v1/cart")));

        // A writes. The per-user key index must scope the sweep to A alone — an
        // implementation that flushed the database, or matched keys by a prefix broad
        // enough to catch both, would pass every other test in this task and only fail
        // here.
        await a.PutAsJsonAsync("/v1/cart", new
        {
            items = new[] { new { productId = _factory.SeededProductId, quantity = 1 } },
        });

        Assert.Equal("MISS", CacheHeader(await a.GetAsync("/v1/cart")));
        Assert.Equal("HIT", CacheHeader(await b.GetAsync("/v1/cart")));

        await a.DeleteAsync("/v1/cart");
    }

    [Fact]
    public async Task User_b_never_receives_user_a_cached_orders()
    {
        // The same property on the my-orders family, which differs from the cart in a way
        // that matters: its key carries a t0/t1 suffix, so it is reachable only through
        // the per-user index rather than by name.
        await _factory.FlushCacheAsync();

        var a = Client(OrdersApiFactory.KnownCognitoSub);
        var b = Client(OrdersApiFactory.OtherCognitoSub);

        // A needs at least one order for the comparison to mean anything — see the guard
        // at the end. Placed against a DEDICATED product rather than SeededProductId,
        // whose 5 units the other classes in this collection consume exactly.
        var productId = await SeedProductAsync(stock: 10, priceCents: 1000);
        var created = await a.PostAsJsonAsync("/v1/orders", new
        {
            lines = new[] { new { productId, quantity = 1 } },
        });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        await _factory.FlushCacheAsync();

        var ordersA = await (await a.GetAsync("/v1/orders/my-orders"))
            .Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("HIT", CacheHeader(await a.GetAsync("/v1/orders/my-orders")));

        // B has placed no orders on this host, so B's list is empty — and must not be A's.
        var firstB = await b.GetAsync("/v1/orders/my-orders");
        Assert.Equal("MISS", CacheHeader(firstB));
        var ordersB = await firstB.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Empty(ordersB.EnumerateArray());

        // Guard against the whole assertion being vacuous: if A had no orders either,
        // "B's list is empty" would prove nothing about isolation. This is not
        // hypothetical — it fired on the first run of this test, when A's order had not
        // yet been placed.
        Assert.NotEmpty(ordersA.EnumerateArray());
    }

    // Same pattern as CartCheckoutTests/CartEndpointsTests: a dedicated product with
    // known stock, rather than depending on SeededProductId's level (shared, and drawn
    // down by the other classes in this collection).
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
