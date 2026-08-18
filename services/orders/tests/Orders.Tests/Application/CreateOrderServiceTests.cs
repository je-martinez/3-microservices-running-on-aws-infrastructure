using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Orders.Application.Abstractions;
using Orders.Application.Identity;
using Orders.Application.Orders;
using Orders.Application.Tracking;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;
using Orders.Infrastructure.Messaging;
using Orders.Infrastructure.Observability;
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

    // The email a resolved caller carries unless a test overrides it. Distinctive on
    // purpose: the publisher-seam test asserts this exact value crossed the seam, so a
    // regression that dropped or substituted the email could not pass by coincidence.
    private const string CallerEmail = "buyer@example.com";

    // The display name a resolved caller carries unless a test overrides it. Distinctive for
    // the same reason as CallerEmail: the publisher-seam test asserts this exact value
    // crossed the seam, so a regression that dropped it cannot pass by coincidence.
    private const string CallerFullName = "Ada Lovelace";

    private sealed class FixedDirectory : IUserDirectory
    {
        private readonly string? _id;
        private readonly CallerAddress? _address;
        private readonly string _email;
        private readonly string _fullName;

        // Address defaults to null — the "user has no address on file" branch. Tests that
        // exercise the snapshot pass one explicitly.
        public FixedDirectory(
            string? id,
            CallerAddress? address = null,
            string email = CallerEmail,
            string fullName = CallerFullName)
        {
            _id = id;
            _address = address;
            _email = email;
            _fullName = fullName;
        }

        public Task<string?> ResolveInternalUserIdAsync(string sub, CancellationToken ct = default) => Task.FromResult(_id);

        public Task<CallerProfile?> ResolveCallerAsync(string sub, CancellationToken ct = default) =>
            Task.FromResult(_id is null ? null : new CallerProfile(_id, _email, _fullName, _address));
    }

    // Records what order creation handed to Tracking, and when. Default outcome is
    // Created; tests that care about the failure path pass a different one.
    private sealed class SpyTracking : ITrackingInitiator
    {
        private readonly TrackingInitOutcome _outcome;
        private readonly Func<Task>? _onCall;

        public SpyTracking(TrackingInitOutcome outcome = TrackingInitOutcome.Created, Func<Task>? onCall = null)
        {
            _outcome = outcome;
            _onCall = onCall;
        }

        public int Calls { get; private set; }
        public string? OrderId { get; private set; }
        public string? ShippingAddressJson { get; private set; }
        public string? CognitoSub { get; private set; }
        public bool TestMode { get; private set; }
        public bool E2eSource { get; private set; }

        public async Task<TrackingInitResult> InitTrackingAsync(
            string orderId, string? shippingAddressJson, string cognitoSub, bool testMode,
            bool e2eSource = false, CancellationToken ct = default)
        {
            Calls++;
            OrderId = orderId;
            ShippingAddressJson = shippingAddressJson;
            CognitoSub = cognitoSub;
            TestMode = testMode;
            E2eSource = e2eSource;
            if (_onCall is not null) await _onCall();
            return new TrackingInitResult(_outcome, _outcome == TrackingInitOutcome.Created ? 201 : 500);
        }
    }

    // Records what order creation handed the publisher. The real SqsEventPublisher is
    // covered by SqsEventPublisherTests; what this pins is the SEAM — that the values the
    // service resolved actually reach it.
    private sealed class SpyPublisher : IEventPublisher
    {
        public int Calls { get; private set; }
        public string? OrderId { get; private set; }
        public string? UserId { get; private set; }
        public string? Email { get; private set; }
        public string? FullName { get; private set; }
        public long SubtotalCents { get; private set; }
        public long TaxCents { get; private set; }
        public long ShippingCents { get; private set; }
        public long TotalCents { get; private set; }
        public string? ShippingAddress { get; private set; }
        public IReadOnlyList<OrderCreatedItem> Items { get; private set; } = Array.Empty<OrderCreatedItem>();
        public string? CognitoSub { get; private set; }

        public Task PublishOrderCreatedAsync(
            string orderId, string userId, string email, string fullName,
            long subtotalCents, long taxCents, long shippingCents, long totalCents,
            string? shippingAddress, IReadOnlyList<OrderCreatedItem> items,
            DateTime createdAt, string? cognitoSub = null, CancellationToken ct = default)
        {
            Calls++;
            OrderId = orderId;
            UserId = userId;
            Email = email;
            FullName = fullName;
            SubtotalCents = subtotalCents;
            TaxCents = taxCents;
            ShippingCents = shippingCents;
            TotalCents = totalCents;
            ShippingAddress = shippingAddress;
            Items = items;
            CognitoSub = cognitoSub;
            return Task.CompletedTask;
        }
    }

    // The flat shipping charge every test below is priced against, unless it overrides it.
    // 1500 = $15.00, matching the ConfigurationSeed default.
    private const long ShippingCents = 1500;

    private sealed class FixedConfig : IConfigurationReader
    {
        private readonly decimal _taxRate;
        private readonly long _shippingCents;

        public FixedConfig(decimal taxRate, long shippingCents = ShippingCents)
        {
            _taxRate = taxRate;
            _shippingCents = shippingCents;
        }

        public Task<decimal> GetTaxRateAsync(CancellationToken ct = default) => Task.FromResult(_taxRate);

        public Task<long> GetShippingCentsAsync(CancellationToken ct = default) => Task.FromResult(_shippingCents);
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
        var svc = new CreateOrderService(db, new FixedDirectory("usr_a"), new NoopEventPublisher(), new FixedConfig(0.10m), new SpyTracking(), new WorkflowTracer(), NullLogger<CreateOrderService>.Instance);

        var dto = await svc.CreateAsync(
            new CreateOrderCommand(new[] { new CreateOrderLine(productId, 3) }), "sub-a");

        Assert.StartsWith("ord_", dto.Id);
        // Returned DTO reflects the totals/lines without a re-query.
        Assert.Equal("usr_a", dto.UserId);
        Assert.Equal("sub-a", dto.CognitoSub);
        Assert.Equal(3000, dto.SubtotalCents);           // 3 * 1000
        Assert.Equal(300, dto.TaxCents);                 // 10%
        Assert.Equal(4800, dto.TotalCents);              // 3000 + 300 + 1500 shipping
        var dtoLine = Assert.Single(dto.Lines);
        Assert.Equal(productId, dtoLine.ProductId);
        Assert.Equal(3u, dtoLine.Quantity);

        var product = await db.Products.FirstAsync(p => p.Id == productId);
        Assert.Equal(7u, product.UnitsInStock);         // 10 - 3
        var order = await db.Orders.Include(o => o.Details).FirstAsync(o => o.Id == dto.Id);
        Assert.Equal("usr_a", order.UserId);
        Assert.Equal("sub-a", order.CognitoSub);
        Assert.Equal(3000, order.SubtotalCents);         // 3 * 1000
        Assert.Equal(300, order.TaxCents);               // 10%
        // The configured flat rate is PERSISTED on the order, not just folded into the
        // total: the emailed receipt renders it as its own line, so it has to survive
        // a round trip to the database.
        Assert.Equal(1500, order.ShippingCents);
        Assert.Equal(4800, order.TotalCents);            // 3000 + 300 + 1500
        // CreatedBy now records the semantic actor, not the buyer's id.
        Assert.Equal(AuditActor.CreateOrder, order.CreatedBy);
        Assert.Equal(AuditActor.CreateOrder, order.UpdatedBy);
        Assert.NotEqual("usr_a", order.CreatedBy);
        var detail = Assert.Single(order.Details);
        Assert.Equal("usr_a", detail.UserId);            // both ids stamped on the line too
        Assert.Equal("sub-a", detail.CognitoSub);
        Assert.Equal(AuditActor.CreateOrder, detail.CreatedBy);
        // Shipping is charged once per SHIPMENT, so it must NOT appear on the line: the
        // detail's own total stays subtotal + tax and remains explainable from its unit
        // price and quantity alone.
        Assert.Equal(3000, detail.SubtotalCents);
        Assert.Equal(300, detail.TaxCents);
        Assert.Equal(3300, detail.TotalCents);
    }

    [Fact]
    public async Task Publishes_ORDER_CREATED_with_the_callers_email_from_the_directory()
    {
        var productId = await SeedProduct(stock: 10, priceCents: 1000);
        await using var db = Ctx();
        var events = new SpyPublisher();
        // A distinctive email so the assertion cannot pass on a coincidence (an empty
        // string, the user id, or the sub would all fail).
        var svc = new CreateOrderService(
            db, new FixedDirectory("usr_a", email: "distinct-buyer@example.com"), events,
            new FixedConfig(0.10m), new SpyTracking(), new WorkflowTracer(), NullLogger<CreateOrderService>.Instance);

        var dto = await svc.CreateAsync(
            new CreateOrderCommand(new[] { new CreateOrderLine(productId, 3) }), "sub-a");

        Assert.Equal(1, events.Calls);
        // The email the pipeline sends the confirmation to comes from the SAME GetUserById
        // response that resolved the internal id — no second round trip, and no
        // substitution of the sub or the id for it.
        Assert.Equal("distinct-buyer@example.com", events.Email);
        Assert.Equal(dto.Id, events.OrderId);
        Assert.Equal("usr_a", events.UserId);
        // The total that crosses the seam is the ORDER total, shipping included — the
        // same figure the receipt email prints, so 3000 + 300 + 1500.
        Assert.Equal(4800, events.TotalCents);
        // The request's own identity crosses the seam too: it becomes the envelope's
        // author.cognito_sub. A distinct value from the internal id, so a service that
        // passed the wrong one of the two cannot pass here.
        Assert.Equal("sub-a", events.CognitoSub);
    }

    [Fact]
    public async Task Consolidates_duplicate_product_lines_into_one_detail()
    {
        var productId = await SeedProduct(stock: 10, priceCents: 1000);
        await using var db = Ctx();
        var svc = new CreateOrderService(db, new FixedDirectory("usr_a"), new NoopEventPublisher(), new FixedConfig(0.10m), new SpyTracking(), new WorkflowTracer(), NullLogger<CreateOrderService>.Instance);

        // Two lines for the SAME product (qty 2 and 3) must consolidate into ONE
        // OrderDetail with Quantity 5, and stock must be decremented by 5 total —
        // not processed twice against the same already-loaded entity.
        var dto = await svc.CreateAsync(
            new CreateOrderCommand(new[]
            {
                new CreateOrderLine(productId, 2),
                new CreateOrderLine(productId, 3),
            }), "sub-a");

        // The returned DTO itself must reflect the consolidated line.
        var dtoLine = Assert.Single(dto.Lines);
        Assert.Equal(productId, dtoLine.ProductId);
        Assert.Equal(5u, dtoLine.Quantity);
        Assert.Equal(5000, dto.SubtotalCents);           // 5 * 1000
        Assert.Equal(500, dto.TaxCents);                 // 10%
        Assert.Equal(7000, dto.TotalCents);              // 5000 + 500 + 1500 shipping

        var product = await db.Products.FirstAsync(p => p.Id == productId);
        Assert.Equal(5u, product.UnitsInStock);          // 10 - (2 + 3)

        var order = await db.Orders.Include(o => o.Details).FirstAsync(o => o.Id == dto.Id);
        var detail = Assert.Single(order.Details);       // exactly one consolidated line
        Assert.Equal(productId, detail.ProductId);
        Assert.Equal(5u, detail.Quantity);
        Assert.Equal(5000, order.SubtotalCents);         // 5 * 1000
        Assert.Equal(500, order.TaxCents);               // 10%
        // Shipping is charged ONCE per order regardless of how many lines it has — the
        // two consolidated lines do not buy two shipments.
        Assert.Equal(1500, order.ShippingCents);
        Assert.Equal(7000, order.TotalCents);            // 5000 + 500 + 1500
    }

    [Fact]
    public async Task Rejects_when_consolidated_quantity_exceeds_stock()
    {
        var productId = await SeedProduct(stock: 4, priceCents: 1000);
        await using var db = Ctx();
        var svc = new CreateOrderService(db, new FixedDirectory("usr_a"), new NoopEventPublisher(), new FixedConfig(0.10m), new SpyTracking(), new WorkflowTracer(), NullLogger<CreateOrderService>.Instance);

        // Stock is 4; individually each line (2, then 3) would look fine against the
        // ORIGINAL stock, but the consolidated total (5) must be validated as a whole.
        await Assert.ThrowsAsync<InsufficientStockException>(() =>
            svc.CreateAsync(new CreateOrderCommand(new[]
            {
                new CreateOrderLine(productId, 2),
                new CreateOrderLine(productId, 3),
            }), "sub-a"));

        var product = await db.Products.FirstAsync(p => p.Id == productId);
        Assert.Equal(4u, product.UnitsInStock);          // unchanged — full rollback
        Assert.False(await db.Orders.AnyAsync());        // no order persisted
    }

    [Fact]
    public async Task Rejects_when_stock_insufficient()
    {
        var productId = await SeedProduct(stock: 2, priceCents: 1000);
        await using var db = Ctx();
        var svc = new CreateOrderService(db, new FixedDirectory("usr_a"), new NoopEventPublisher(), new FixedConfig(0.10m), new SpyTracking(), new WorkflowTracer(), NullLogger<CreateOrderService>.Instance);

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
        var svc = new CreateOrderService(db, new FixedDirectory(null), new NoopEventPublisher(), new FixedConfig(0.10m), new SpyTracking(), new WorkflowTracer(), NullLogger<CreateOrderService>.Instance);

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
        var svc = new CreateOrderService(db, new FixedDirectory("usr_a"), new NoopEventPublisher(), new FixedConfig(0.10m), new SpyTracking(), new WorkflowTracer(), NullLogger<CreateOrderService>.Instance);

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
