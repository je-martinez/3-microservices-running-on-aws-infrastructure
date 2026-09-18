using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Orders.Domain.Entities;
using Orders.Infrastructure.Caching;
using Orders.Infrastructure.Id;

namespace Orders.Tests.Api;

/// <summary>
/// <c>POST /v1/orders/{orderId}/cache-invalidation</c> — the route Tracking calls when a
/// delivery status changes, so Orders forgets the responses that EMBED that tracking.
/// CONTRACT: Every test here WARMS to a confirmed HIT before it invalidates. Against a cold
/// cache they pass with a no-op invalidator, asserting only that a missing key is missing.
/// CONTRACT: Keep them on <c>OrdersApiFactory</c>, the only host with a live cache — under
/// <c>CACHE_ENABLED=false</c> no <c>X-Cache</c> header is emitted and every assertion reads
/// null. See [[x-cache-response-header]]
/// </summary>
[Collection(OrdersApiCollection.Name)]
public class InternalOrderCacheInvalidationTests : IDisposable
{
    private readonly OrdersApiFactory _factory;

    public InternalOrderCacheInvalidationTests(OrdersApiFactory factory) => _factory = factory;

    // StubTrackings is shared collection state; clear what this class stubbed.
    public void Dispose() => _factory.ClearTrackings();

    private static string Path(string orderId) => $"/v1/orders/{orderId}/cache-invalidation";

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

    /// <summary>The call as Tracking makes it: internal key, order id, no user identity.</summary>
    private async Task<HttpResponseMessage> InvalidateAsync(
        string orderId, string? apiKey = "test-key")
    {
        var request = new HttpRequestMessage(HttpMethod.Post, Path(orderId));
        if (apiKey is not null)
        {
            request.Headers.Add("x-api-key", apiKey);
        }

        return await _factory.CreateClient().SendAsync(request);
    }

    /// <summary>Places one order on a product of its own and returns its id.</summary>
    /// <remarks>
    /// A DEDICATED product, not the factory's <c>SeededProductId</c>: that row carries five
    /// units and other classes consume all of them, so sharing it starves them into a 409 in
    /// a full run while every test in this file still passes alone.
    /// </remarks>
    private async Task<string> CreateOrderAsync(HttpClient client)
    {
        var productId = await SeedProductAsync();
        var created = await client.PostAsJsonAsync(
            "/v1/orders",
            new { lines = new[] { new { productId, quantity = 1 } } });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        return (await created.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("id").GetString()!;
    }

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

    /// <summary>
    /// Stubs a tracking for EVERY order this caller can list, not only the one under test.
    /// CONTRACT: Every listed order — the factory is a collection fixture, so other classes'
    /// orders appear in this caller's list, and one order without a tracking makes the whole
    /// <c>t1</c> list entry unstorable (see <c>TrackingCacheRules</c>). The warm-up would
    /// then never reach a HIT and the test would assert nothing. See [[testing]]
    /// </summary>
    private async Task StubTrackingsForListAsync(HttpClient client)
    {
        var listed = await (await client.GetAsync("/v1/orders/my-orders"))
            .Content.ReadFromJsonAsync<JsonElement>();
        foreach (var element in listed.EnumerateArray())
        {
            var id = element.GetProperty("id").GetString()!;
            _factory.StubTrackings[id] = OrdersApiFactory.TrackingFor(id);
        }
    }

    [Fact]
    public async Task Invalidation_forgets_the_tracking_bearing_order_read()
    {
        var client = Client(OrdersApiFactory.KnownCognitoSub);
        var orderId = await CreateOrderAsync(client);
        _factory.StubTrackings[orderId] = OrdersApiFactory.TrackingFor(orderId);
        await _factory.FlushCacheAsync();

        var path = $"/v1/orders/{orderId}?includeTracking=true";
        Assert.Equal("MISS", CacheHeader(await client.GetAsync(path)));
        Assert.Equal("HIT", CacheHeader(await client.GetAsync(path)));

        var response = await InvalidateAsync(orderId);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        // The bug this route exists for: a status change in Tracking left this entry
        // serving the previous status for the rest of its TTL.
        Assert.Equal("MISS", CacheHeader(await client.GetAsync(path)));
    }

    [Fact]
    public async Task Invalidation_forgets_the_my_orders_list_that_embeds_the_tracking()
    {
        // The list key carries no order id, so it cannot be addressed from the route's
        // parameter — it is reachable only through the owner's key index. A route that
        // deleted just the two order-detail keys passes the test above and fails here,
        // leaving the list screen stale while the detail screen refreshes.
        var client = Client(OrdersApiFactory.KnownCognitoSub);
        var orderId = await CreateOrderAsync(client);
        await StubTrackingsForListAsync(client);
        await _factory.FlushCacheAsync();

        const string path = "/v1/orders/my-orders?includeTracking=true";
        Assert.Equal("MISS", CacheHeader(await client.GetAsync(path)));
        Assert.Equal("HIT", CacheHeader(await client.GetAsync(path)));

        var response = await InvalidateAsync(orderId);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        Assert.Equal("MISS", CacheHeader(await client.GetAsync(path)));
    }

    [Fact]
    public async Task Invalidation_forgets_the_tracking_free_variants_too()
    {
        // t0 goes as well. The sweep that reaches t1 reaches t0 at no extra cost, whereas
        // naming only the t1 keys would mean enumerating the suffixes the index exists to
        // avoid enumerating — and leaving a t0 entry that disagrees with its t1 twin about
        // the same order is a worse state than either being stale.
        var client = Client(OrdersApiFactory.KnownCognitoSub);
        var orderId = await CreateOrderAsync(client);
        await _factory.FlushCacheAsync();

        var detail = $"/v1/orders/{orderId}";
        Assert.Equal("MISS", CacheHeader(await client.GetAsync(detail)));
        Assert.Equal("HIT", CacheHeader(await client.GetAsync(detail)));
        Assert.Equal("MISS", CacheHeader(await client.GetAsync("/v1/orders/my-orders")));
        Assert.Equal("HIT", CacheHeader(await client.GetAsync("/v1/orders/my-orders")));

        var response = await InvalidateAsync(orderId);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        Assert.Equal("MISS", CacheHeader(await client.GetAsync(detail)));
        Assert.Equal("MISS", CacheHeader(await client.GetAsync("/v1/orders/my-orders")));
    }

    [Fact]
    public async Task Invalidation_reaches_entries_filed_under_the_owners_internal_id()
    {
        // Keys are filed under whatever the client sent in x-user-id, and Tracking sends no
        // identity at all — the route resolves the owner from the order row, which holds
        // BOTH ids. A route sweeping only the row's cognito_sub leaves a caller who
        // authenticated with their usr_ id on a HIT. Every other test here warms under the
        // sub and so cannot catch this. See [[x-cache-response-header]]
        var client = Client(OrdersApiFactory.SelfResolvingUserId);
        var orderId = await CreateOrderAsync(client);
        await _factory.FlushCacheAsync();

        var detail = $"/v1/orders/{orderId}";
        Assert.Equal("MISS", CacheHeader(await client.GetAsync(detail)));
        Assert.Equal("HIT", CacheHeader(await client.GetAsync(detail)));

        var response = await InvalidateAsync(orderId);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        Assert.Equal("MISS", CacheHeader(await client.GetAsync(detail)));
    }

    [Fact]
    public async Task Invalidation_leaves_another_users_entries_alone()
    {
        // Invalidating one order must not degenerate into a FLUSHDB. A blunt implementation
        // passes every assertion above and only fails here.
        var owner = Client(OrdersApiFactory.KnownCognitoSub);
        var orderId = await CreateOrderAsync(owner);
        await _factory.FlushCacheAsync();

        var bystander = Client(OrdersApiFactory.OtherCognitoSub);
        Assert.Equal("MISS", CacheHeader(await bystander.GetAsync("/v1/orders/my-orders")));
        Assert.Equal("HIT", CacheHeader(await bystander.GetAsync("/v1/orders/my-orders")));

        var response = await InvalidateAsync(orderId);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        Assert.Equal("HIT", CacheHeader(await bystander.GetAsync("/v1/orders/my-orders")));
    }

    [Fact]
    public async Task Invalidation_leaves_the_shared_product_catalogue_alone()
    {
        // The catalogue belongs to no user and a delivery status change moves no stock.
        // Dropping this key would cold-start the catalogue for everyone on every status
        // transition — the highest-frequency event in the system.
        var client = Client(OrdersApiFactory.KnownCognitoSub);
        var orderId = await CreateOrderAsync(client);
        await _factory.FlushCacheAsync();

        Assert.Equal("MISS", CacheHeader(await client.GetAsync("/v1/products")));
        Assert.Equal("HIT", CacheHeader(await client.GetAsync("/v1/products")));

        var response = await InvalidateAsync(orderId);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        Assert.Equal("HIT", CacheHeader(await client.GetAsync("/v1/products")));
    }

    [Fact]
    public async Task Invalidation_leaves_the_owners_identity_mapping_alone()
    {
        // Unlike the account-deletion cascade, the user still exists and their sub still
        // resolves to the same usr_ id. Dropping it would put a gRPC call back on the next
        // request for no correctness gain.
        var client = Client(OrdersApiFactory.KnownCognitoSub);
        var orderId = await CreateOrderAsync(client);
        await _factory.FlushCacheAsync();

        var identityKey = CacheKeys.Identity(OrdersApiFactory.KnownCognitoSub);
        await _factory.SetCacheKeyAsync(
            identityKey, $"\"{OrdersApiFactory.KnownUserId}\"", CacheKeys.IdentityTtl);

        var response = await InvalidateAsync(orderId);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        Assert.True(await _factory.CacheKeyExistsAsync(identityKey));
    }

    [Fact]
    public async Task An_unknown_order_is_404_and_invalidates_nothing()
    {
        // Not 200: an order id Orders cannot resolve names no owner, so there is no key set
        // to sweep, and answering 200 would let Tracking record a success for an
        // invalidation that never happened.
        await _factory.FlushCacheAsync();

        var client = Client(OrdersApiFactory.KnownCognitoSub);
        Assert.Equal("MISS", CacheHeader(await client.GetAsync("/v1/orders/my-orders")));
        Assert.Equal("HIT", CacheHeader(await client.GetAsync("/v1/orders/my-orders")));

        var response = await InvalidateAsync("ord_doesnotexist01");
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);

        Assert.Equal("HIT", CacheHeader(await client.GetAsync("/v1/orders/my-orders")));
    }

    [Fact]
    public async Task A_request_without_the_internal_key_is_401_and_invalidates_nothing()
    {
        var client = Client(OrdersApiFactory.KnownCognitoSub);
        var orderId = await CreateOrderAsync(client);
        await _factory.FlushCacheAsync();

        var detail = $"/v1/orders/{orderId}";
        Assert.Equal("MISS", CacheHeader(await client.GetAsync(detail)));
        Assert.Equal("HIT", CacheHeader(await client.GetAsync(detail)));

        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (await InvalidateAsync(orderId, apiKey: null)).StatusCode);
        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (await InvalidateAsync(orderId, apiKey: "wrong-key")).StatusCode);

        // The rejection is total: an unauthenticated caller cannot even cost the owner a
        // cold cache, which on a route needing no user identity would be a free way to
        // strip the cache off any order whose id an attacker can guess.
        Assert.Equal("HIT", CacheHeader(await client.GetAsync(detail)));
    }

    [Fact]
    public async Task Invalidation_still_works_for_a_soft_deleted_order()
    {
        // The owner lookup IGNORES the global soft-delete filter. An erased order's cached
        // entries outlive the row by their full TTL, and a 404 here would leave whoever
        // deleted it staring at the order they just removed.
        var client = Client(OrdersApiFactory.KnownCognitoSub);
        var orderId = await CreateOrderAsync(client);
        await _factory.FlushCacheAsync();

        Assert.Equal("MISS", CacheHeader(await client.GetAsync("/v1/orders/my-orders")));
        Assert.Equal("HIT", CacheHeader(await client.GetAsync("/v1/orders/my-orders")));

        await using (var db = _factory.NewWriteContext())
        {
            await db.Database.ExecuteSqlRawAsync(
                "UPDATE `order` SET deleted_at = UTC_TIMESTAMP() WHERE id = {0}", orderId);
        }

        var response = await InvalidateAsync(orderId);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        Assert.Equal("MISS", CacheHeader(await client.GetAsync("/v1/orders/my-orders")));
    }
}
