using System.Net;
using System.Net.Http.Json;
using Microsoft.EntityFrameworkCore;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;
using Xunit;

namespace Orders.Tests.Api;

[Collection(OrdersApiCollection.Name)]
public class CartCheckoutTests
{
    private readonly OrdersApiFactory _factory;

    public CartCheckoutTests(OrdersApiFactory factory) => _factory = factory;

    private HttpClient Client()
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("x-user-id", OrdersApiFactory.KnownCognitoSub);
        return client;
    }

    // Without this, the user reloads after checking out and finds the cart they
    // just bought still sitting there, ready to be bought again.
    [Fact]
    public async Task Creating_an_order_deletes_the_callers_cart()
    {
        var productId = await SeedProductAsync(stock: 5, priceCents: 1000);
        var client = Client();
        await client.PutAsJsonAsync("/v1/cart", new
        {
            items = new[] { new { productId, quantity = 1 } },
        });

        var order = await client.PostAsJsonAsync("/v1/orders", new
        {
            lines = new[] { new { productId, quantity = 1u } },
        });
        Assert.Equal(HttpStatusCode.Created, order.StatusCode);

        await using var db = _factory.NewWriteContext();
        Assert.False(await db.Carts.AnyAsync(c => c.CognitoSub == OrdersApiFactory.KnownCognitoSub));
    }

    // A user who orders without ever using a cart must not hit an error path.
    [Fact]
    public async Task Creating_an_order_without_a_cart_succeeds()
    {
        var productId = await SeedProductAsync(stock: 5, priceCents: 1000);
        var client = Client();
        await client.DeleteAsync("/v1/cart");

        var order = await client.PostAsJsonAsync("/v1/orders", new
        {
            lines = new[] { new { productId, quantity = 1u } },
        });

        Assert.Equal(HttpStatusCode.Created, order.StatusCode);
    }

    // The deletion is part of the order transaction: a rolled-back order must leave
    // the cart intact, or the user loses their selection AND gets no order.
    [Fact]
    public async Task A_failed_order_leaves_the_cart_intact()
    {
        // Small, known stock — the request below deliberately asks for more than
        // this, so the order write rolls back with a 409.
        var productId = await SeedProductAsync(stock: 2, priceCents: 1000);
        var client = Client();
        await client.PutAsJsonAsync("/v1/cart", new
        {
            items = new[] { new { productId, quantity = 1 } },
        });

        // Far beyond the seeded stock, so the write rolls back with 409.
        var order = await client.PostAsJsonAsync("/v1/orders", new
        {
            lines = new[] { new { productId, quantity = 9999u } },
        });
        Assert.Equal(HttpStatusCode.Conflict, order.StatusCode);

        await using var db = _factory.NewWriteContext();
        Assert.True(await db.Carts.AnyAsync(c => c.CognitoSub == OrdersApiFactory.KnownCognitoSub));

        await client.DeleteAsync("/v1/cart");
    }

    // Same pattern as CartWriteServiceTests/CartReadServiceTests/CartEndpointsTests: a
    // dedicated product with known stock, rather than depending on SeededProductId's
    // level (shared and drawn down by earlier test classes in the collection).
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
