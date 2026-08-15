using System.Net;
using System.Net.Http.Json;
using Orders.Application.Orders;

namespace Orders.Tests.Api;

[Collection(Orders.Tests.Api.OrdersApiCollection.Name)]
public class CreateOrderEndpointTests
{
    private readonly OrdersApiFactory _factory;
    public CreateOrderEndpointTests(OrdersApiFactory factory) => _factory = factory;

    [Fact]
    public async Task Post_without_user_header_is_401()
    {
        var client = _factory.CreateClient();
        var resp = await client.PostAsJsonAsync("/v1/orders",
            new { lines = new[] { new { productId = "prd_x", quantity = 1 } } });
        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }

    [Fact]
    public async Task Post_with_known_user_creates_order_201()
    {
        var client = _factory.CreateClient();
        var req = new HttpRequestMessage(HttpMethod.Post, "/v1/orders")
        {
            Content = JsonContent.Create(new { lines = new[] { new { productId = _factory.SeededProductId, quantity = 2 } } }),
        };
        req.Headers.Add("x-user-id", OrdersApiFactory.KnownCognitoSub);

        var resp = await client.SendAsync(req);

        Assert.Equal(HttpStatusCode.Created, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<OrderDto>();
        Assert.NotNull(body);
        Assert.StartsWith("ord_", body!.Id);
        Assert.True(body.TotalCents > 0);
        var line = Assert.Single(body.Lines);
        Assert.Equal(_factory.SeededProductId, line.ProductId);
        Assert.Equal(2u, line.Quantity);
    }

    [Fact]
    public async Task Post_with_duplicate_product_lines_consolidates_in_response()
    {
        // Quantities kept small (1 + 1) because SeededProductId's stock (5 units) is
        // shared across every test in this IClassFixture-scoped factory.
        var client = _factory.CreateClient();
        var req = new HttpRequestMessage(HttpMethod.Post, "/v1/orders")
        {
            Content = JsonContent.Create(new
            {
                lines = new[]
                {
                    new { productId = _factory.SeededProductId, quantity = 1 },
                    new { productId = _factory.SeededProductId, quantity = 1 },
                },
            }),
        };
        req.Headers.Add("x-user-id", OrdersApiFactory.KnownCognitoSub);

        var resp = await client.SendAsync(req);

        Assert.Equal(HttpStatusCode.Created, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<OrderDto>();
        Assert.NotNull(body);
        var line = Assert.Single(body!.Lines);
        Assert.Equal(_factory.SeededProductId, line.ProductId);
        Assert.Equal(2u, line.Quantity);
        Assert.True(body.SubtotalCents > 0);
        Assert.True(body.TotalCents > 0);
    }

    [Fact]
    public async Task Post_over_stock_is_409()
    {
        var client = _factory.CreateClient();
        var req = new HttpRequestMessage(HttpMethod.Post, "/v1/orders")
        {
            Content = JsonContent.Create(new { lines = new[] { new { productId = _factory.SeededProductId, quantity = 9999 } } }),
        };
        req.Headers.Add("x-user-id", OrdersApiFactory.KnownCognitoSub);

        var resp = await client.SendAsync(req);

        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
    }

    [Fact]
    public async Task Post_with_unknown_product_is_404_not_409()
    {
        var client = _factory.CreateClient();
        var req = new HttpRequestMessage(HttpMethod.Post, "/v1/orders")
        {
            Content = JsonContent.Create(new { lines = new[] { new { productId = "prd_does_not_exist", quantity = 1 } } }),
        };
        req.Headers.Add("x-user-id", OrdersApiFactory.KnownCognitoSub);

        var resp = await client.SendAsync(req);

        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<ErrorBody>();
        Assert.NotNull(body);
        Assert.Equal("unknown_product", body!.Error);
        // The detail must name WHICH product was unknown (parity with insufficient_stock).
        Assert.NotNull(body.Detail);
        Assert.Contains("prd_does_not_exist", body.Detail!);
    }

    [Fact]
    public async Task Post_with_unknown_user_is_404()
    {
        var client = _factory.CreateClient();
        var req = new HttpRequestMessage(HttpMethod.Post, "/v1/orders")
        {
            Content = JsonContent.Create(new { lines = new[] { new { productId = _factory.SeededProductId, quantity = 1 } } }),
        };
        req.Headers.Add("x-user-id", "sub-nobody");

        var resp = await client.SendAsync(req);

        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
    }

    // A malformed body must be a 400, not a 500. `lines` is a non-nullable
    // reference type on CreateOrderRequest, but System.Text.Json does not enforce
    // that — an absent key binds to null, and the first thing CreateAsync did with
    // it was read `.Count`. That threw NullReferenceException out of the handler,
    // so every one of these cases answered 500 while the caller's mistake was a
    // plain bad request.
    //
    // Worth keeping as three cases rather than one: they enter through different
    // paths. `{}` omits the key, `{"lines": null}` sends it explicitly null, and
    // `{"items": […]}` is the realistic version — a caller using the wrong field
    // name, which is exactly how this was found.
    [Fact]
    public async Task Post_without_lines_key_is_400()
    {
        var client = _factory.CreateClient();
        var req = new HttpRequestMessage(HttpMethod.Post, "/v1/orders")
        {
            Content = JsonContent.Create(new { }),
        };
        req.Headers.Add("x-user-id", OrdersApiFactory.KnownCognitoSub);

        var resp = await client.SendAsync(req);

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<ErrorBody>();
        Assert.Equal("invalid_request", body!.Error);
    }

    [Fact]
    public async Task Post_with_wrong_field_name_is_400()
    {
        var client = _factory.CreateClient();
        var req = new HttpRequestMessage(HttpMethod.Post, "/v1/orders")
        {
            Content = JsonContent.Create(new { items = new[] { new { productId = _factory.SeededProductId, quantity = 1 } } }),
        };
        req.Headers.Add("x-user-id", OrdersApiFactory.KnownCognitoSub);

        var resp = await client.SendAsync(req);

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    // An EMPTY array is a different mistake from a missing one, and it must not
    // reach the write transaction either: it would open a transaction, resolve the
    // caller over gRPC, and commit an order with no lines and a zero total.
    [Fact]
    public async Task Post_with_empty_lines_is_400()
    {
        var client = _factory.CreateClient();
        var req = new HttpRequestMessage(HttpMethod.Post, "/v1/orders")
        {
            Content = JsonContent.Create(new { lines = Array.Empty<object>() }),
        };
        req.Headers.Add("x-user-id", OrdersApiFactory.KnownCognitoSub);

        var resp = await client.SendAsync(req);

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    private sealed record ErrorBody(string Error, string? Detail);
}
