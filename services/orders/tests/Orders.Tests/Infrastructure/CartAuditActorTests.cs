using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Orders.Application.Abstractions;
using Orders.Application.Carts;
using Orders.Domain.Entities;
using Orders.Infrastructure.Carts;
using Orders.Infrastructure.Id;
using Orders.Tests.Api;
using Xunit;

namespace Orders.Tests.Infrastructure;

/// <summary>The audit actor the cart write paths stamp into the audit columns.</summary>
/// <remarks>
/// CONTRACT: Read the stamped values off the PERSISTED ROW, never off the returned DTO —
/// <c>CartDto</c> carries no audit columns, so a DTO-level assertion would pass against a row
/// whose actor is null. See [[audit-fields]]
/// CONTRACT: <c>AuditInterceptor</c> stamps NOTHING and never throws on a null
/// <c>AmbientActor.Current</c>, so a <c>SaveChangesAsync</c> moved outside the handler's
/// <c>RunAsync</c> scope writes blank audit columns while the cart still saves and every
/// content assertion still passes. These tests are the only thing that fails then.
/// </remarks>
[Collection(OrdersApiCollection.Name)]
public class CartAuditActorTests
{
    private readonly OrdersApiFactory _factory;

    public CartAuditActorTests(OrdersApiFactory factory) => _factory = factory;

    [Fact]
    public async Task A_cart_put_stamps_the_update_cart_actor_on_the_cart_and_its_lines()
    {
        var sub = OrdersApiFactory.KnownCognitoSub;
        var productId = await SeedProductAsync();

        using (var scope = _factory.Services.CreateScope())
        {
            await scope.ServiceProvider.GetRequiredService<CartWriteService>().ReplaceAsync(
                new UpdateCartCommand([new CartLineInput(productId, 2)]), sub);
        }

        await using var db = _factory.NewWriteContext();
        var cart = await db.Carts
            .Include(c => c.Items)
            .AsNoTracking()
            .SingleAsync(c => c.CognitoSub == sub);

        Assert.Equal(AuditActor.UpdateCart, cart.CreatedBy);
        Assert.Equal(AuditActor.UpdateCart, cart.UpdatedBy);
        // The semantic actor, not the buyer's identity. A path stamping the caller's id would
        // satisfy "not null" while destroying the distinction deleted_by exists to record.
        Assert.NotEqual(OrdersApiFactory.KnownUserId, cart.CreatedBy);
        Assert.NotEqual(sub, cart.CreatedBy);

        // The lines too: they are saved in the same SaveChangesAsync, so a lost actor scope
        // blanks both, and asserting only on the parent would still catch it — but a future
        // change that saves lines separately would not be caught without this.
        var item = Assert.Single(cart.Items);
        Assert.Equal(AuditActor.UpdateCart, item.CreatedBy);

        await CleanupAsync(sub);
    }

    [Fact]
    public async Task A_cart_delete_stamps_the_delete_cart_actor_on_the_soft_deleted_rows()
    {
        var sub = OrdersApiFactory.OtherCognitoSub;
        var productId = await SeedProductAsync();

        using (var scope = _factory.Services.CreateScope())
        {
            var writes = scope.ServiceProvider.GetRequiredService<CartWriteService>();
            await writes.ReplaceAsync(
                new UpdateCartCommand([new CartLineInput(productId, 1)]), sub);
            await writes.DeleteAsync(sub);
        }

        await using var db = _factory.NewWriteContext();
        // IgnoreQueryFilters: the rows this asserts on are exactly the ones the soft-delete
        // filter hides, so without it the query returns nothing and the test passes vacuously.
        var cart = await db.Carts
            .IgnoreQueryFilters()
            .Include(c => c.Items)
            .AsNoTracking()
            .SingleAsync(c => c.CognitoSub == sub);

        Assert.NotNull(cart.DeletedAt);
        Assert.Equal(AuditActor.DeleteCart, cart.DeletedBy);
        // The delete actor REPLACES nothing: created_by still records who made the cart, which
        // is what makes "who removed it" a separate, answerable question.
        Assert.Equal(AuditActor.UpdateCart, cart.CreatedBy);

        var item = Assert.Single(cart.Items);
        Assert.Equal(AuditActor.DeleteCart, item.DeletedBy);
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
            UnitsInStock = 5,
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
