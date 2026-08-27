using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Orders.Domain.Entities;
using Orders.Infrastructure.Caching;
using Orders.Infrastructure.Id;

namespace Orders.Tests.Api;

/// <summary>
/// The <c>includeTracking=true</c> reads must not freeze a not-yet-created tracking into a
/// 2-minute cache entry.
/// </summary>
/// <remarks>
/// <para>
/// <b>The window is real, not hypothetical.</b> <c>CreateOrderService</c> initiates tracking
/// AFTER its own transaction commits, so an order exists before its tracking does. A
/// <c>t1</c> read landing in between legitimately answers <c>tracking: null</c>; storing that
/// answer serves it as a HIT for the full TTL, long after Tracking has the record. It was
/// reproduced deterministically against the live stack, and it is what makes the gateway spec
/// <c>tracking-flow.spec.ts</c> fail intermittently with "tracking was not included".
/// </para>
/// <para>
/// Every test here asserts on <c>CacheKeyExistsAsync</c> as well as on <c>X-Cache</c>. The
/// header alone is not enough: it says what THIS response was, while the defect is about what
/// was WRITTEN. Checking the key directly is what makes "nothing was stored" an observation
/// rather than an inference.
/// </para>
/// </remarks>
[Collection(OrdersApiCollection.Name)]
public class TrackingNullCacheTests : IDisposable
{
    private readonly OrdersApiFactory _factory;

    public TrackingNullCacheTests(OrdersApiFactory factory) => _factory = factory;

    // The stub dictionary is shared collection state; leaving a tracking behind would make
    // an unrelated later class see trackings it never asked for.
    public void Dispose() => _factory.ClearTrackings();

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

    /// <summary>
    /// The reproduction, as an in-process test: read inside the window, then after it.
    /// </summary>
    [Fact]
    public async Task Order_by_id_with_null_tracking_is_served_but_not_stored()
    {
        await _factory.FlushCacheAsync();
        _factory.ClearTrackings();
        var client = Client(OrdersApiFactory.KnownCognitoSub);
        var orderId = await CreateOrderAsync(client);

        var key = CacheKeys.Order(
            OrdersApiFactory.KnownCognitoSub,
            OrdersApiFactory.KnownUserId,
            orderId,
            includeTracking: true);

        // --- inside the window: tracking does not exist yet ---
        var first = await client.GetAsync($"/v1/orders/{orderId}?includeTracking=true");
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.Equal("MISS", CacheHeader(first));
        // Served, and the null really is in the body — the response is not withheld.
        var firstBody = await first.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(JsonValueKind.Null, firstBody.GetProperty("tracking").ValueKind);

        // Nothing was written. This is the assertion the bug fails: today the null-bearing
        // body sits under this key for the full 2-minute TTL.
        Assert.False(
            await _factory.CacheKeyExistsAsync(key),
            "a response whose tracking is null must not be stored");

        // A second read inside the window still MISSes, so it re-runs the handler and can
        // observe the tracking the moment it appears.
        Assert.Equal(
            "MISS",
            CacheHeader(await client.GetAsync($"/v1/orders/{orderId}?includeTracking=true")));

        // --- the tracking now exists (what InitTrackingAsync does after the commit) ---
        _factory.StubTrackings[orderId] = OrdersApiFactory.TrackingFor(orderId);

        var afterward = await client.GetAsync($"/v1/orders/{orderId}?includeTracking=true");
        Assert.Equal("MISS", CacheHeader(afterward));
        var afterBody = await afterward.Content.ReadFromJsonAsync<JsonElement>();
        // The real tracking, not the stale null a HIT would have replayed.
        Assert.Equal(
            orderId,
            afterBody.GetProperty("tracking").GetProperty("order_id").GetString());

        // And NOW it caches: the rule declines a null, it does not disable the route.
        Assert.True(await _factory.CacheKeyExistsAsync(key));
        var hit = await client.GetAsync($"/v1/orders/{orderId}?includeTracking=true");
        Assert.Equal("HIT", CacheHeader(hit));
        var hitBody = await hit.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(
            orderId,
            hitBody.GetProperty("tracking").GetProperty("order_id").GetString());
    }

    /// <summary>
    /// The list case, with the mix that decides the rule: one brand-new order among older
    /// ones that already have their trackings.
    /// </summary>
    /// <remarks>
    /// Under an "any tracking present" rule this list WOULD be stored — and the one order the
    /// user is actually watching, the one just placed, would be pinned at <c>tracking: null</c>
    /// for two minutes. That is why the rule is "every".
    /// </remarks>
    [Fact]
    public async Task My_orders_is_not_stored_while_any_order_still_lacks_tracking()
    {
        await _factory.FlushCacheAsync();
        _factory.ClearTrackings();
        var client = Client(OrdersApiFactory.KnownCognitoSub);

        var older = await CreateOrderAsync(client);
        _factory.StubTrackings[older] = OrdersApiFactory.TrackingFor(older);

        // The brand-new one, still inside its tracking window.
        var fresh = await CreateOrderAsync(client);

        var key = CacheKeys.MyOrders(
            OrdersApiFactory.KnownCognitoSub,
            OrdersApiFactory.KnownUserId,
            includeTracking: true);
        await _factory.FlushCacheAsync();

        var first = await client.GetAsync("/v1/orders/my-orders?includeTracking=true");
        Assert.Equal("MISS", CacheHeader(first));

        var body = await first.Content.ReadFromJsonAsync<JsonElement>();
        var elements = body.EnumerateArray().ToList();
        // The mix the rule is about: at least one with tracking, at least one without.
        Assert.Contains(elements, e =>
            e.GetProperty("order").GetProperty("id").GetString() == older
            && e.GetProperty("tracking").ValueKind != JsonValueKind.Null);
        Assert.Contains(elements, e =>
            e.GetProperty("order").GetProperty("id").GetString() == fresh
            && e.GetProperty("tracking").ValueKind == JsonValueKind.Null);

        Assert.False(
            await _factory.CacheKeyExistsAsync(key),
            "a list containing an order without tracking must not be stored");
        Assert.Equal(
            "MISS",
            CacheHeader(await client.GetAsync("/v1/orders/my-orders?includeTracking=true")));

        // Once the fresh order's tracking lands, the whole list becomes cacheable.
        _factory.StubTrackings[fresh] = OrdersApiFactory.TrackingFor(fresh);

        Assert.Equal(
            "MISS",
            CacheHeader(await client.GetAsync("/v1/orders/my-orders?includeTracking=true")));
        Assert.True(await _factory.CacheKeyExistsAsync(key));
        Assert.Equal(
            "HIT",
            CacheHeader(await client.GetAsync("/v1/orders/my-orders?includeTracking=true")));
    }

    /// <summary>
    /// The t0 variants carry no tracking at all and must keep caching exactly as before.
    /// </summary>
    /// <remarks>
    /// The regression this guards is a blanket rule: "decline when tracking is null" applied
    /// without regard to shape would also decline <c>OrderDto</c>, which HAS no tracking
    /// member — silently turning both default reads into permanent misses, with no failing
    /// assertion anywhere else in the suite to say so.
    /// </remarks>
    [Fact]
    public async Task Bare_variants_still_cache_while_tracking_is_absent()
    {
        await _factory.FlushCacheAsync();
        _factory.ClearTrackings();
        var client = Client(OrdersApiFactory.KnownCognitoSub);
        var orderId = await CreateOrderAsync(client);
        await _factory.FlushCacheAsync();

        // No tracking exists for this order — precisely the state that must not affect t0.
        Assert.Equal("MISS", CacheHeader(await client.GetAsync($"/v1/orders/{orderId}")));
        Assert.Equal("HIT", CacheHeader(await client.GetAsync($"/v1/orders/{orderId}")));
        Assert.True(await _factory.CacheKeyExistsAsync(CacheKeys.Order(
            OrdersApiFactory.KnownCognitoSub,
            OrdersApiFactory.KnownUserId,
            orderId,
            includeTracking: false)));

        Assert.Equal("MISS", CacheHeader(await client.GetAsync("/v1/orders/my-orders")));
        Assert.Equal("HIT", CacheHeader(await client.GetAsync("/v1/orders/my-orders")));
        Assert.True(await _factory.CacheKeyExistsAsync(CacheKeys.MyOrders(
            OrdersApiFactory.KnownCognitoSub,
            OrdersApiFactory.KnownUserId,
            includeTracking: false)));
    }

    private async Task<string> CreateOrderAsync(HttpClient client)
    {
        var productId = await SeedProductAsync();
        var created = await client.PostAsJsonAsync("/v1/orders", new
        {
            lines = new[] { new { productId, quantity = 1 } },
        });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        return (await created.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
    }

    // A dedicated product per order, for the reason OrderCacheTests documents: sharing the
    // factory's seeded row starves CreateOrderEndpointTests into a 409 in a full run.
    private async Task<string> SeedProductAsync()
    {
        await using var db = _factory.NewWriteContext();
        var id = NanoId.NewId(NanoId.ProductPrefix);
        db.Products.Add(new Product
        {
            Id = id,
            Name = "Widget",
            Description = "d",
            UnitPriceCents = 1000,
            UnitsInStock = 10,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow,
        });
        await db.SaveChangesAsync();
        return id;
    }
}
