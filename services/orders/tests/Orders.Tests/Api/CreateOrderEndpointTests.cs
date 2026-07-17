using System.Net;
using System.Net.Http.Json;
using Orders.Application.Orders;

namespace Orders.Tests.Api;

public class CreateOrderEndpointTests : IClassFixture<OrdersApiFactory>
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

    private sealed record ErrorBody(string Error, string? Detail);
}
