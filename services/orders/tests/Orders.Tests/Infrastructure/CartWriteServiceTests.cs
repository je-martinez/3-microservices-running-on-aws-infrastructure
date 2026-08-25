using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Orders.Application.Carts;
using Orders.Domain.Entities;
using Orders.Infrastructure.Carts;
using Orders.Infrastructure.Id;
using Orders.Tests.Api;
using Xunit;

namespace Orders.Tests.Infrastructure;

[Collection(Orders.Tests.Api.OrdersApiCollection.Name)]
public class CartWriteServiceTests
{
    private readonly OrdersApiFactory _factory;

    public CartWriteServiceTests(OrdersApiFactory factory) => _factory = factory;

    [Fact]
    public async Task A_first_put_creates_the_cart()
    {
        var sub = OrdersApiFactory.KnownCognitoSub;
        var productId = await SeedProductAsync(stock: 5, priceCents: 1000);
        using var scope = _factory.Services.CreateScope();
        var writes = scope.ServiceProvider.GetRequiredService<CartWriteService>();

        var cart = await writes.ReplaceAsync(
            new UpdateCartCommand([new CartLineInput(productId, 2)]), sub);

        Assert.NotNull(cart.Id);
        Assert.StartsWith("crt_", cart.Id);
        var line = Assert.Single(cart.Items);
        Assert.Equal(2u, line.Quantity);

        await CleanupAsync(sub);
    }

    // Replacement, not merge: the second PUT is the whole truth about the cart.
    [Fact]
    public async Task A_second_put_replaces_the_line_set()
    {
        var sub = OrdersApiFactory.KnownCognitoSub;
        var productId = await SeedProductAsync(stock: 5, priceCents: 1000);
        using var scope = _factory.Services.CreateScope();
        var writes = scope.ServiceProvider.GetRequiredService<CartWriteService>();

        var first = await writes.ReplaceAsync(
            new UpdateCartCommand([new CartLineInput(productId, 2)]), sub);

        var second = await writes.ReplaceAsync(
            new UpdateCartCommand([new CartLineInput(productId, 5)]), sub);

        // Same cart, updated quantity — not a second cart, and not two lines.
        Assert.Equal(first.Id, second.Id);
        var line = Assert.Single(second.Items);
        Assert.Equal(5u, line.Quantity);

        await CleanupAsync(sub);
    }

    // quantity: 0 removes the line rather than being rejected, so the frontend can
    // send its desired state verbatim without filtering zeros out first.
    [Fact]
    public async Task A_zero_quantity_removes_that_line()
    {
        var sub = OrdersApiFactory.KnownCognitoSub;
        var productId = await SeedProductAsync(stock: 5, priceCents: 1000);
        var otherProductId = await SeedProductAsync(stock: 5, priceCents: 1000);
        using var scope = _factory.Services.CreateScope();
        var writes = scope.ServiceProvider.GetRequiredService<CartWriteService>();

        await writes.ReplaceAsync(new UpdateCartCommand(
        [
            new CartLineInput(productId, 2),
            new CartLineInput(otherProductId, 1),
        ]), sub);

        var after = await writes.ReplaceAsync(new UpdateCartCommand(
        [
            new CartLineInput(productId, 2),
            new CartLineInput(otherProductId, 0),
        ]), sub);

        var line = Assert.Single(after.Items);
        Assert.Equal(productId, line.ProductId);

        await CleanupAsync(sub);
    }

    // The one invariant behind every deletion path: a cart with no live lines
    // does not exist. All three inputs below must reach the same state.
    [Theory]
    [InlineData("empty-array")]
    [InlineData("all-zeros")]
    public async Task A_cart_left_with_no_lines_is_deleted(string how)
    {
        var sub = OrdersApiFactory.KnownCognitoSub;
        var productId = await SeedProductAsync(stock: 5, priceCents: 1000);
        using var scope = _factory.Services.CreateScope();
        var writes = scope.ServiceProvider.GetRequiredService<CartWriteService>();

        await writes.ReplaceAsync(
            new UpdateCartCommand([new CartLineInput(productId, 2)]), sub);

        var emptying = how == "empty-array"
            ? new UpdateCartCommand([])
            : new UpdateCartCommand([new CartLineInput(productId, 0)]);

        var after = await writes.ReplaceAsync(emptying, sub);

        Assert.Null(after.Id);
        Assert.Empty(after.Items);
        // Subtotal, not Total: shipping is reported unconditionally, so an emptied
        // cart's Total is the delivery charge, not zero. See CartPricing.
        Assert.Equal(0, after.Subtotal.Cents);
        Assert.False(after.CanCheckout);

        // And it is really gone from the database, not merely absent from the DTO.
        await using var db = _factory.NewWriteContext();
        Assert.False(await db.Carts.AnyAsync(c => c.CognitoSub == sub));
    }

    // Emptying frees the slot, so the user can start again. This is the pairing the
    // unique index would break if the generated column were wrong.
    [Fact]
    public async Task A_user_can_start_a_new_cart_after_emptying_one()
    {
        var sub = OrdersApiFactory.KnownCognitoSub;
        var productId = await SeedProductAsync(stock: 5, priceCents: 1000);
        using var scope = _factory.Services.CreateScope();
        var writes = scope.ServiceProvider.GetRequiredService<CartWriteService>();

        var first = await writes.ReplaceAsync(
            new UpdateCartCommand([new CartLineInput(productId, 1)]), sub);
        await writes.ReplaceAsync(new UpdateCartCommand([]), sub);

        var second = await writes.ReplaceAsync(
            new UpdateCartCommand([new CartLineInput(productId, 1)]), sub);

        Assert.NotNull(second.Id);
        Assert.NotEqual(first.Id, second.Id);

        await CleanupAsync(sub);
    }

    [Fact]
    public async Task Delete_removes_the_cart_and_is_idempotent()
    {
        var sub = OrdersApiFactory.KnownCognitoSub;
        var productId = await SeedProductAsync(stock: 5, priceCents: 1000);
        using var scope = _factory.Services.CreateScope();
        var writes = scope.ServiceProvider.GetRequiredService<CartWriteService>();

        await writes.ReplaceAsync(
            new UpdateCartCommand([new CartLineInput(productId, 1)]), sub);

        await writes.DeleteAsync(sub);
        // Second call must not throw: DELETE is idempotent.
        await writes.DeleteAsync(sub);

        await using var db = _factory.NewWriteContext();
        Assert.False(await db.Carts.AnyAsync(c => c.CognitoSub == sub));
    }

    // Inserts a fresh product with a caller-chosen stock/price, so a test's
    // assertions rest on values IT controls rather than on the shared
    // SeededProductId — same pattern as CartReadServiceTests.SeedProductAsync.
    // A fresh nano id per call keeps concurrent tests from interfering with
    // each other's catalogue rows.
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

    private async Task CleanupAsync(string sub)
    {
        using var scope = _factory.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<CartWriteService>().DeleteAsync(sub);
    }
}
