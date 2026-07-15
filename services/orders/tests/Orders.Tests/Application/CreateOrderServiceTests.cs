using Microsoft.EntityFrameworkCore;
using Orders.Application.Abstractions;
using Orders.Application.Identity;
using Orders.Application.Orders;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;
using Orders.Infrastructure.Messaging;
using Orders.Infrastructure.Orders;
using Orders.Infrastructure.Persistence;
using Testcontainers.MySql;

namespace Orders.Tests.Application;

// CreateOrderService lives in Orders.Infrastructure.Orders (needs the write
// DbContext + EF Core); Application keeps the command/exceptions/ports.
public class CreateOrderServiceTests : IAsyncLifetime
{
    private readonly MySqlContainer _mysql =
        new MySqlBuilder("mysql:8.0").WithDatabase("orders").Build();
    public Task InitializeAsync() => _mysql.StartAsync();
    public Task DisposeAsync() => _mysql.DisposeAsync().AsTask();

    private OrdersWriteDbContext Ctx()
    {
        var cs = _mysql.GetConnectionString();
        return new OrdersWriteDbContext(new DbContextOptionsBuilder<OrdersWriteDbContext>()
            .UseMySql(cs, ServerVersion.AutoDetect(cs)).Options);
    }

    private sealed class FixedDirectory : IUserDirectory
    {
        private readonly string? _id;
        public FixedDirectory(string? id) => _id = id;
        public Task<string?> ResolveInternalUserIdAsync(string sub, CancellationToken ct = default) => Task.FromResult(_id);
    }

    private sealed class FixedConfig : IConfigurationReader
    {
        private readonly decimal _taxRate;
        public FixedConfig(decimal taxRate) => _taxRate = taxRate;
        public Task<decimal> GetTaxRateAsync(CancellationToken ct = default) => Task.FromResult(_taxRate);
    }

    private async Task<string> SeedProduct(uint stock, long priceCents)
    {
        await using var db = Ctx();
        await db.Database.MigrateAsync();
        var id = NanoId.NewId(NanoId.ProductPrefix);
        db.Products.Add(new Product { Id = id, Name = "P", Description = "d", UnitPriceCents = priceCents, UnitsInStock = stock, CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow });
        await db.SaveChangesAsync();
        return id;
    }

    [Fact]
    public async Task Creates_order_and_decrements_stock()
    {
        var productId = await SeedProduct(stock: 10, priceCents: 1000);
        await using var db = Ctx();
        var svc = new CreateOrderService(db, new FixedDirectory("usr_a"), new NoopEventPublisher(), new FixedConfig(0.10m));

        var orderId = await svc.CreateAsync(
            new CreateOrderCommand(new[] { new CreateOrderLine(productId, 3) }), "sub-a");

        Assert.StartsWith("ord_", orderId);
        var product = await db.Products.FirstAsync(p => p.Id == productId);
        Assert.Equal(7u, product.UnitsInStock);         // 10 - 3
        var order = await db.Orders.Include(o => o.Details).FirstAsync(o => o.Id == orderId);
        Assert.Equal("usr_a", order.UserId);
        Assert.Equal("sub-a", order.CognitoSub);
        Assert.Equal(3000, order.SubtotalCents);         // 3 * 1000
        Assert.Equal(300, order.TaxCents);               // 10%
        Assert.Equal(3300, order.TotalCents);
        // CreatedBy now records the semantic actor, not the buyer's id.
        Assert.Equal(AuditActor.CreateOrder, order.CreatedBy);
        Assert.Equal(AuditActor.CreateOrder, order.UpdatedBy);
        Assert.NotEqual("usr_a", order.CreatedBy);
        var detail = Assert.Single(order.Details);
        Assert.Equal("usr_a", detail.UserId);            // both ids stamped on the line too
        Assert.Equal("sub-a", detail.CognitoSub);
        Assert.Equal(AuditActor.CreateOrder, detail.CreatedBy);
    }

    [Fact]
    public async Task Rejects_when_stock_insufficient()
    {
        var productId = await SeedProduct(stock: 2, priceCents: 1000);
        await using var db = Ctx();
        var svc = new CreateOrderService(db, new FixedDirectory("usr_a"), new NoopEventPublisher(), new FixedConfig(0.10m));

        await Assert.ThrowsAsync<InsufficientStockException>(() =>
            svc.CreateAsync(new CreateOrderCommand(new[] { new CreateOrderLine(productId, 5) }), "sub-a"));

        var product = await db.Products.FirstAsync(p => p.Id == productId);
        Assert.Equal(2u, product.UnitsInStock);          // unchanged — full rollback
        Assert.False(await db.Orders.AnyAsync());        // no order persisted
    }

    [Fact]
    public async Task Rejects_unknown_user()
    {
        var productId = await SeedProduct(stock: 10, priceCents: 1000);
        await using var db = Ctx();
        var svc = new CreateOrderService(db, new FixedDirectory(null), new NoopEventPublisher(), new FixedConfig(0.10m));

        await Assert.ThrowsAsync<UnknownUserException>(() =>
            svc.CreateAsync(new CreateOrderCommand(new[] { new CreateOrderLine(productId, 1) }), "sub-x"));
    }
}
