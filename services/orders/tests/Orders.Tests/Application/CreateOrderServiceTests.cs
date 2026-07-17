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

    // ADR-0004 read-side soft-delete leak: the `SELECT ... FOR UPDATE` product lock
    // is raw SQL, so EF Core's global query filter does NOT apply. Without an explicit
    // `deleted_at IS NULL` predicate a soft-deleted product could be locked, read and
    // SOLD. This proves the lock no longer sees soft-deleted products: ordering one
    // throws and its stock is never decremented (the transaction never touches it).
    [Fact]
    public async Task Rejects_soft_deleted_product()
    {
        var productId = await SeedProduct(stock: 10, priceCents: 1000);

        // Soft-delete the product via the audit interceptor: a tracked .Remove() is
        // rewritten to an UPDATE that stamps deleted_at/deleted_by (row survives).
        await using (var seedDb = Ctx())
        {
            await AmbientActor.RunAsync(AuditActor.E2eCleanup, async () =>
            {
                var product = await seedDb.Products.SingleAsync(p => p.Id == productId);
                seedDb.Products.Remove(product);
                await seedDb.SaveChangesAsync();
            });
        }

        await using var db = Ctx();
        var svc = new CreateOrderService(db, new FixedDirectory("usr_a"), new NoopEventPublisher(), new FixedConfig(0.10m));

        // The soft-deleted product is not orderable: the FOR UPDATE lock returns null
        // (query filter hides it), so the service raises UnknownProductException —
        // same as a genuinely nonexistent product id (product effectively gone).
        await Assert.ThrowsAsync<UnknownProductException>(() =>
            svc.CreateAsync(new CreateOrderCommand(new[] { new CreateOrderLine(productId, 3) }), "sub-a"));

        // Stock was NOT decremented (transaction never locked/touched the row) and no
        // order persisted. IgnoreQueryFilters is required to read past the soft-delete filter.
        var product = await db.Products.IgnoreQueryFilters().FirstAsync(p => p.Id == productId);
        Assert.NotNull(product.DeletedAt);
        Assert.Equal(10u, product.UnitsInStock);         // unchanged
        Assert.False(await db.Orders.AnyAsync());        // no order persisted
    }
}
