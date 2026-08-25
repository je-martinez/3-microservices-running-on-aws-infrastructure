using System.Net;
using System.Net.Http.Json;
using Microsoft.EntityFrameworkCore;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;
using Xunit;

namespace Orders.Tests.Api;

[Collection(OrdersApiCollection.Name)]
public class CartEndpointsTests
{
    private readonly OrdersApiFactory _factory;

    public CartEndpointsTests(OrdersApiFactory factory) => _factory = factory;

    private HttpClient Client(string sub)
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("x-user-id", sub);
        return client;
    }

    [Fact]
    public async Task Get_returns_200_with_an_empty_cart_when_there_is_none()
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("x-user-id", $"sub-{Guid.NewGuid():N}");

        var response = await client.GetAsync("/v1/cart");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonCart>();
        Assert.Null(body!.Id);
        Assert.Empty(body.Items);
    }

    [Fact]
    public async Task Put_creates_the_cart_and_returns_it_fully_calculated()
    {
        // Own seeded product with known stock — SeededProductId is shared and drawn
        // down by other test classes in this collection.
        var productId = await SeedProductAsync(stock: 5, priceCents: 1000);
        // KnownCognitoSub is the only sub the stub IUserDirectory resolves; any other
        // sub makes ReplaceAsync throw UnknownUserException and the PUT answer 404.
        var client = Client(OrdersApiFactory.KnownCognitoSub);
        await client.DeleteAsync("/v1/cart"); // start from no cart, in case an earlier test left one.

        var response = await client.PutAsJsonAsync("/v1/cart", new
        {
            items = new[] { new { productId, quantity = 2 } },
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonCart>();
        Assert.NotNull(body!.Id);
        var line = Assert.Single(body.Items);
        Assert.Equal(2, line.Quantity);
        // Both money views present — the whole point of the change.
        Assert.Equal(2000, line.Subtotal!.Cents);
        Assert.Equal("20.00", line.Subtotal.Amount);
        Assert.Equal("$20.00", line.Subtotal.Formatted);

        await client.DeleteAsync("/v1/cart");
    }

    [Fact]
    public async Task Delete_returns_204_and_is_idempotent()
    {
        var productId = await SeedProductAsync(stock: 5, priceCents: 1000);
        var client = Client(OrdersApiFactory.KnownCognitoSub);
        await client.PutAsJsonAsync("/v1/cart", new
        {
            items = new[] { new { productId, quantity = 1 } },
        });

        Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync("/v1/cart")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync("/v1/cart")).StatusCode);
    }

    [Theory]
    // A negative quantity is the only quantity that is an error.
    [InlineData("{\"items\":[{\"productId\":\"prd_x\",\"quantity\":-1}]}")]
    // Two entries for one product is ambiguous under replacement semantics.
    [InlineData("{\"items\":[{\"productId\":\"prd_x\",\"quantity\":1},{\"productId\":\"prd_x\",\"quantity\":2}]}")]
    // A missing/misspelled key binds items to null — the bug that produced an opaque
    // 500 on POST /v1/orders before it was guarded.
    [InlineData("{}")]
    [InlineData("{\"items\":null}")]
    [InlineData("{\"items\":[{\"quantity\":1}]}")]
    public async Task Put_rejects_an_invalid_body_with_400(string json)
    {
        // Validation runs BEFORE identity resolution, so any known-shaped sub works —
        // an unknown one is used here to prove this is a pure 400 request-shape check,
        // never reaching the 404 unknown-user path.
        var client = Client($"sub-{Guid.NewGuid():N}");

        var response = await client.PutAsync("/v1/cart",
            new StringContent(json, System.Text.Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Cart_routes_require_identity()
    {
        var anonymous = _factory.CreateClient();

        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/v1/cart")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.DeleteAsync("/v1/cart")).StatusCode);
    }

    // Same pattern as CartWriteServiceTests/CartReadServiceTests: a dedicated product
    // with known stock, rather than depending on SeededProductId's level (shared and
    // drawn down by earlier test classes in the collection).
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

    // Minimal shapes for asserting on the JSON contract, so a rename of a C# property
    // that changes the wire format fails here rather than silently reaching clients.
    // camelCase: ASP.NET's default System.Text.Json casing, which Program.cs never
    // overrides — the repo's snake_case convention applies to the SQS envelope, not HTTP.
    private record JsonMoney(long Cents, string Amount, string Formatted, string Currency);
    private record JsonLine(string ProductId, int Quantity, bool Available, JsonMoney? Subtotal);
    private record JsonCart(string? Id, List<JsonLine> Items, JsonMoney Total, bool CanCheckout);
}
