using System.Net;
using Orders.Tests.Api;

namespace Orders.Tests.Identity;

// Exercises CallerContextMiddleware end-to-end through the real Program pipeline
// (OrdersApiFactory): the public allowlist (health) must pass with no header,
// every other route must 401 without x-user-id, and succeed once it's set.
public class AuthMiddlewareTests : IClassFixture<OrdersApiFactory>
{
    private readonly OrdersApiFactory _factory;
    public AuthMiddlewareTests(OrdersApiFactory factory) => _factory = factory;

    [Fact]
    public async Task Health_with_no_header_returns_200()
    {
        var client = _factory.CreateClient();

        var response = await client.GetAsync("/v1/health");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task My_orders_with_no_header_returns_401()
    {
        var client = _factory.CreateClient();

        var response = await client.GetAsync("/v1/orders/my-orders");

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task My_orders_with_header_returns_200()
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("x-user-id", "sub-1");

        var response = await client.GetAsync("/v1/orders/my-orders");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }
}
