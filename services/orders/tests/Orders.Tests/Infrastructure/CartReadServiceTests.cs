using Microsoft.Extensions.DependencyInjection;
using Orders.Application.Carts;
using Orders.Domain.Entities;
using Orders.Infrastructure.Carts;
using Orders.Infrastructure.Id;
using Orders.Tests.Api;
using Xunit;

namespace Orders.Tests.Infrastructure;

[Collection(Orders.Tests.Api.OrdersApiCollection.Name)]
public class CartReadServiceTests
{
    private readonly OrdersApiFactory _factory;

    public CartReadServiceTests(OrdersApiFactory factory) => _factory = factory;

    // An empty cart is a 200 with zeros, never a 404 — the frontend must not branch.
    [Fact]
    public async Task A_user_with_no_cart_reads_an_empty_cart()
    {
        using var scope = _factory.Services.CreateScope();
        var reads = scope.ServiceProvider.GetRequiredService<CartReadService>();

        var cart = await reads.GetMyCartAsync("sub-with-no-cart");

        Assert.Null(cart.Id);
        Assert.Empty(cart.Items);
        Assert.Equal(0, cart.Subtotal.Cents);
        Assert.False(cart.CanCheckout);
    }

    [Fact]
    public async Task An_available_line_is_priced_from_the_live_catalogue()
    {
        var sub = $"sub-{Guid.NewGuid():N}";
        // Own product, own known stock/price — SeededProductId is shared across the
        // whole assembly (CreateOrderEndpointTests draws its stock down via real
        // order creation, and nothing restores it outside the E2E cleanup route), so
        // asserting against it here would make this test's outcome depend on what
        // else ran first instead of on CartReadService's own logic.
        var productId = await SeedProductAsync(stock: 50, priceCents: 1000);
        await SeedCartAsync(sub, productId, quantity: 2);

        using var scope = _factory.Services.CreateScope();
        var reads = scope.ServiceProvider.GetRequiredService<CartReadService>();

        var cart = await reads.GetMyCartAsync(sub);

        var line = Assert.Single(cart.Items);
        Assert.True(line.Available);
        Assert.Null(line.UnavailableReason);           // omitted, never a value
        Assert.Equal("Widget", line.Name);
        Assert.Equal(1000, line.UnitPrice!.Cents);     // the seeded product's price
        Assert.Equal(2000, line.Subtotal!.Cents);
        Assert.Equal(2000, cart.Subtotal.Cents);
        Assert.True(cart.CanCheckout);
    }

    [Fact]
    public async Task A_line_asking_for_more_than_stock_is_insufficient_stock()
    {
        var sub = $"sub-{Guid.NewGuid():N}";
        // Own product with a KNOWN stock level (see the comment on the happy-path
        // test above) — the assertion below needs to know exactly how many units
        // remain, which only holds for a product nothing else in the suite touches.
        var productId = await SeedProductAsync(stock: 5, priceCents: 1000);
        await SeedCartAsync(sub, productId, quantity: 99);

        using var scope = _factory.Services.CreateScope();
        var reads = scope.ServiceProvider.GetRequiredService<CartReadService>();

        var cart = await reads.GetMyCartAsync(sub);

        var line = Assert.Single(cart.Items);
        Assert.False(line.Available);
        Assert.Equal(UnavailableReason.InsufficientStock, line.UnavailableReason);
        // Still reports what it WOULD cost, and still says how many remain.
        Assert.Equal(99000, line.Subtotal!.Cents);
        Assert.Equal(5u, line.UnitsInStock);
        // ...but contributes nothing to the cart.
        Assert.Equal(0, cart.Subtotal.Cents);
        Assert.False(cart.CanCheckout);
    }

    [Fact]
    public async Task A_line_whose_product_vanished_is_unknown_product()
    {
        var sub = $"sub-{Guid.NewGuid():N}";
        await SeedCartAsync(sub, NanoId.NewId(NanoId.ProductPrefix), quantity: 1);

        using var scope = _factory.Services.CreateScope();
        var reads = scope.ServiceProvider.GetRequiredService<CartReadService>();

        var cart = await reads.GetMyCartAsync(sub);

        var line = Assert.Single(cart.Items);
        Assert.False(line.Available);
        Assert.Equal(UnavailableReason.UnknownProduct, line.UnavailableReason);
        // No catalogue row left, so no price, no name, no artwork.
        Assert.Null(line.UnitPrice);
        Assert.Null(line.Subtotal);
        Assert.Null(line.Name);
        Assert.Null(line.Image);
    }

    // Inserts a fresh product with a caller-chosen stock/price, so a test's
    // assertions rest on values IT controls rather than on the shared
    // SeededProductId — same pattern as CreateOrderServiceTests.SeedProduct and
    // ProductReadServiceTests. A fresh nano id per call keeps concurrent tests from
    // interfering with each other's catalogue rows.
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

    private async Task SeedCartAsync(string sub, string productId, uint quantity)
    {
        await using var db = _factory.NewWriteContext();
        var cart = new Cart
        {
            Id = NanoId.NewId(NanoId.CartPrefix),
            UserId = NanoId.NewId("usr_"),
            CognitoSub = sub,
        };
        db.Carts.Add(cart);
        db.CartItems.Add(new CartItem
        {
            Id = NanoId.NewId(NanoId.CartItemPrefix),
            CartId = cart.Id,
            ProductId = productId,
            Quantity = quantity,
        });
        await db.SaveChangesAsync();
    }
}
