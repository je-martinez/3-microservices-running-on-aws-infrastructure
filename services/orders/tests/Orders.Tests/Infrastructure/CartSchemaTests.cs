using Microsoft.EntityFrameworkCore;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;
using Orders.Tests.Api;
using Xunit;

namespace Orders.Tests.Infrastructure;

[Collection(Orders.Tests.Api.OrdersApiCollection.Name)]
public class CartSchemaTests
{
    private readonly OrdersApiFactory _factory;

    public CartSchemaTests(OrdersApiFactory factory) => _factory = factory;

    // The invariant this whole design rests on. If the index is missing or its
    // expression is wrong, this passes silently in code review and fails in
    // production as two live carts for one user.
    [Fact]
    public async Task A_user_cannot_hold_two_active_carts()
    {
        await using var db = _factory.NewWriteContext();
        var userId = NanoId.NewId("usr_");

        db.Carts.Add(new Cart { Id = NanoId.NewId(NanoId.CartPrefix), UserId = userId, CognitoSub = "sub-a" });
        await db.SaveChangesAsync();

        db.Carts.Add(new Cart { Id = NanoId.NewId(NanoId.CartPrefix), UserId = userId, CognitoSub = "sub-a" });

        await Assert.ThrowsAnyAsync<DbUpdateException>(() => db.SaveChangesAsync());
    }

    // The other half: soft-deleting frees the slot. Without the CASE expression the
    // unique index would block a user from ever starting a second cart.
    [Fact]
    public async Task A_soft_deleted_cart_frees_the_slot()
    {
        await using var db = _factory.NewWriteContext();
        var userId = NanoId.NewId("usr_");

        var first = new Cart { Id = NanoId.NewId(NanoId.CartPrefix), UserId = userId, CognitoSub = "sub-b" };
        db.Carts.Add(first);
        await db.SaveChangesAsync();

        first.DeletedAt = DateTime.UtcNow;
        await db.SaveChangesAsync();

        db.Carts.Add(new Cart { Id = NanoId.NewId(NanoId.CartPrefix), UserId = userId, CognitoSub = "sub-b" });

        // No throw: the deleted row's generated column is NULL, which the unique index ignores.
        await db.SaveChangesAsync();
    }

    [Fact]
    public async Task A_cart_cannot_hold_two_active_lines_for_one_product()
    {
        await using var db = _factory.NewWriteContext();
        var cart = new Cart { Id = NanoId.NewId(NanoId.CartPrefix), UserId = NanoId.NewId("usr_"), CognitoSub = "sub-c" };
        db.Carts.Add(cart);
        await db.SaveChangesAsync();

        var productId = _factory.SeededProductId;
        db.CartItems.Add(new CartItem { Id = NanoId.NewId(NanoId.CartItemPrefix), CartId = cart.Id, ProductId = productId, Quantity = 1 });
        await db.SaveChangesAsync();

        db.CartItems.Add(new CartItem { Id = NanoId.NewId(NanoId.CartItemPrefix), CartId = cart.Id, ProductId = productId, Quantity = 2 });

        await Assert.ThrowsAnyAsync<DbUpdateException>(() => db.SaveChangesAsync());
    }
}
