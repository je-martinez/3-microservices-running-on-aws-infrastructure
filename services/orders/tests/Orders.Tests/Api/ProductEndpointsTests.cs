using System.Net;
using System.Net.Http.Json;
using Orders.Application.Orders;

namespace Orders.Tests.Api;

public class ProductEndpointsTests : IClassFixture<OrdersApiFactory>
{
    private readonly OrdersApiFactory _factory;
    public ProductEndpointsTests(OrdersApiFactory factory) => _factory = factory;

    [Fact]
    public async Task Get_without_user_header_is_401()
    {
        var client = _factory.CreateClient();
        var resp = await client.GetAsync("/v1/products");
        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }

    [Fact]
    public async Task Get_with_known_user_returns_200_with_seeded_catalog()
    {
        var client = _factory.CreateClient();
        var req = new HttpRequestMessage(HttpMethod.Get, "/v1/products");
        req.Headers.Add("x-user-id", OrdersApiFactory.KnownCognitoSub);

        var resp = await client.SendAsync(req);

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<List<ProductDto>>();
        Assert.NotNull(body);
        Assert.Contains(body!, p => p.Id == _factory.SeededProductId);

        var seeded = body!.Single(p => p.Id == _factory.SeededProductId);
        Assert.Equal("Widget", seeded.Name);
        Assert.Equal(1000, seeded.UnitPriceCents);
        Assert.Equal((uint)5, seeded.UnitsInStock);
    }
}
