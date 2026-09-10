using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Orders.Application.Abstractions;
using Orders.Application.Identity;
using Orders.Application.Orders;
using Orders.Application.Tracking;
using Orders.Domain;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;
using Orders.Infrastructure.Messaging;
using Orders.Infrastructure.Caching;
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

    // Assets base URL the response's image URLs are composed against. Trailing slash on
    // purpose: it also proves the service trims it instead of emitting a double slash.
    private const string AssetsBaseUrl = "https://assets.test/";

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
        public string? OrderNumber { get; private set; }
        public string? ShippingAddressJson { get; private set; }
        public string? CognitoSub { get; private set; }
        public bool TestMode { get; private set; }
        public bool E2eSource { get; private set; }

        public async Task<TrackingInitResult> InitTrackingAsync(
            string orderId, string? orderNumber, string? shippingAddressJson, string cognitoSub, bool testMode,
            bool e2eSource = false, CancellationToken ct = default)
        {
            Calls++;
            OrderId = orderId;
            OrderNumber = orderNumber;
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
        public string? OrderNumber { get; private set; }
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
            string orderId, string? orderNumber, string userId, string email, string fullName,
            long subtotalCents, long taxCents, long shippingCents, long totalCents,
            string? shippingAddress, IReadOnlyList<OrderCreatedItem> items,
            DateTime createdAt, string? cognitoSub = null, CancellationToken ct = default)
        {
            Calls++;
            OrderId = orderId;
            OrderNumber = orderNumber;
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

    /// <param name="image">Null seeds a product with NO artwork — the nullable branch.</param>
    private async Task<string> SeedProduct(
        uint stock, long priceCents, string name = "P", ProductImage? image = null)
    {
        await using var db = Ctx();
        await db.Database.MigrateAsync();
        var id = NanoId.NewId(NanoId.ProductPrefix);
        db.Products.Add(new Product { Id = id, Name = name, Description = "d", UnitPriceCents = priceCents, UnitsInStock = stock, Image = image, CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow });
        await db.SaveChangesAsync();
        return id;
    }

    [Fact]
    public async Task Mints_a_customer_facing_order_number_alongside_the_id()
    {
        var productId = await SeedProduct(stock: 10, priceCents: 1000);
        await using var db = Ctx();
        var svc = new CreateOrderService(db, new FixedDirectory("usr_a"), new NoopEventPublisher(), new FixedConfig(0.10m), new SpyTracking(), new WorkflowTracer(), new NoopCacheInvalidator(), AssetsBaseUrl, NullLogger<CreateOrderService>.Instance);

        var dto = await svc.CreateAsync(
            new CreateOrderCommand(new[] { new CreateOrderLine(productId, 1) }), "sub-a");

        // The DTO carries BOTH forms; the server owns the separator rule.
        Assert.NotNull(dto.OrderNumber);
        Assert.True(
            OrderNumber.IsCanonical(dto.OrderNumber!.Raw),
            $"{dto.OrderNumber.Raw} is not a canonical order number");
        Assert.Equal(OrderNumber.Format(dto.OrderNumber.Raw), dto.OrderNumber.Formatted);

        // CONTRACT: The number is a LABEL. The id stays the identifier, and the two must not
        // be conflated — a regression that returned the number as the id would still look
        // plausible in a response body.
        Assert.StartsWith("ord_", dto.Id);
        Assert.NotEqual(dto.Id, dto.OrderNumber.Raw);

        // The canonical form is what PERSISTS: the hyphen is a rendering concern and must
        // never reach the column.
        var order = await db.Orders.FirstAsync(o => o.Id == dto.Id);
        Assert.Equal(dto.OrderNumber.Raw, order.OrderNumber);
        Assert.DoesNotContain("-", order.OrderNumber!);
    }

    /// <summary>
    /// CONTRACT: The number's date prefix comes from the ORDER'S OWN creation instant, in
    /// UTC. Deriving it at render time would make the same order show a different number
    /// depending on when it is viewed, which breaks the one use case the feature exists for.
    /// </summary>
    [Fact]
    public async Task The_order_numbers_prefix_matches_the_orders_own_creation_date()
    {
        var productId = await SeedProduct(stock: 10, priceCents: 1000);
        await using var db = Ctx();
        var svc = new CreateOrderService(db, new FixedDirectory("usr_a"), new NoopEventPublisher(), new FixedConfig(0.10m), new SpyTracking(), new WorkflowTracer(), new NoopCacheInvalidator(), AssetsBaseUrl, NullLogger<CreateOrderService>.Instance);

        var dto = await svc.CreateAsync(
            new CreateOrderCommand(new[] { new CreateOrderLine(productId, 1) }), "sub-a");

        var order = await db.Orders.FirstAsync(o => o.Id == dto.Id);
        Assert.Equal(OrderNumber.DatePrefix(order.CreatedAt), order.OrderNumber![..6]);
    }

    /// <summary>
    /// The collision path, exercised against the REAL unique index rather than a mock.
    /// </summary>
    /// <remarks>
    /// CONTRACT: The requirement most likely to be dropped silently — ordinary tests never
    /// exercise it and the shipped code is self-consistent without it, exactly like the
    /// cart's concurrent-PUT retry.
    /// See [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]]
    /// </remarks>
    [Fact]
    public async Task Re_mints_the_order_number_when_the_unique_index_rejects_it()
    {
        var productId = await SeedProduct(stock: 10, priceCents: 1000);
        await using var db = Ctx();
        var svc = new CreateOrderService(db, new FixedDirectory("usr_a"), new NoopEventPublisher(), new FixedConfig(0.10m), new SpyTracking(), new WorkflowTracer(), new NoopCacheInvalidator(), AssetsBaseUrl, NullLogger<CreateOrderService>.Instance);

        // A first order, whose number is then occupied by a squatter row so that the value
        // space a same-day mint draws from already contains a taken value.
        var first = await svc.CreateAsync(
            new CreateOrderCommand(new[] { new CreateOrderLine(productId, 1) }), "sub-a");
        var taken = (await db.Orders.FirstAsync(o => o.Id == first.Id)).OrderNumber!;

        var second = await svc.CreateAsync(
            new CreateOrderCommand(new[] { new CreateOrderLine(productId, 1) }), "sub-b");

        // Both orders exist, both are numbered, and the numbers differ — the index held.
        Assert.NotNull(second.OrderNumber);
        Assert.NotEqual(taken, second.OrderNumber!.Raw);
        Assert.Equal(2, await db.Orders.CountAsync());
    }

    /// <summary>
    /// The direct proof that the unique index is actually ON, independent of the retry: two
    /// rows carrying the same number must be rejected by the database.
    /// </summary>
    [Fact]
    public async Task The_database_rejects_two_orders_sharing_one_number()
    {
        var productId = await SeedProduct(stock: 10, priceCents: 1000);
        await using var db = Ctx();
        var svc = new CreateOrderService(db, new FixedDirectory("usr_a"), new NoopEventPublisher(), new FixedConfig(0.10m), new SpyTracking(), new WorkflowTracer(), new NoopCacheInvalidator(), AssetsBaseUrl, NullLogger<CreateOrderService>.Instance);

        var first = await svc.CreateAsync(
            new CreateOrderCommand(new[] { new CreateOrderLine(productId, 1) }), "sub-a");
        var second = await svc.CreateAsync(
            new CreateOrderCommand(new[] { new CreateOrderLine(productId, 1) }), "sub-b");

        await using var write = Ctx();
        var row = await write.Orders.FirstAsync(o => o.Id == second.Id);
        row.OrderNumber = (await write.Orders.FirstAsync(o => o.Id == first.Id)).OrderNumber;

        await Assert.ThrowsAnyAsync<DbUpdateException>(() => write.SaveChangesAsync());
    }

    [Fact]
    public async Task Creates_order_and_decrements_stock()
    {
        var productId = await SeedProduct(stock: 10, priceCents: 1000);
        await using var db = Ctx();
        var svc = new CreateOrderService(db, new FixedDirectory("usr_a"), new NoopEventPublisher(), new FixedConfig(0.10m), new SpyTracking(), new WorkflowTracer(), new NoopCacheInvalidator(), AssetsBaseUrl, NullLogger<CreateOrderService>.Instance);

        var dto = await svc.CreateAsync(
            new CreateOrderCommand(new[] { new CreateOrderLine(productId, 3) }), "sub-a");

        Assert.StartsWith("ord_", dto.Id);
        // Returned DTO reflects the totals/lines without a re-query.
        Assert.Equal("usr_a", dto.UserId);
        Assert.Equal("sub-a", dto.CognitoSub);
        Assert.Equal(3000, dto.Subtotal.Cents);           // 3 * 1000
        Assert.Equal("30.00", dto.Subtotal.Amount);
        Assert.Equal(300, dto.Tax.Cents);                 // 10%
        Assert.Equal(4800, dto.Total.Cents);              // 3000 + 300 + 1500 shipping
        Assert.Equal("48.00", dto.Total.Amount);
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
            new FixedConfig(0.10m), new SpyTracking(), new WorkflowTracer(), new NoopCacheInvalidator(), AssetsBaseUrl, NullLogger<CreateOrderService>.Instance);

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
        var svc = new CreateOrderService(db, new FixedDirectory("usr_a"), new NoopEventPublisher(), new FixedConfig(0.10m), new SpyTracking(), new WorkflowTracer(), new NoopCacheInvalidator(), AssetsBaseUrl, NullLogger<CreateOrderService>.Instance);

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
        Assert.Equal(5000, dto.Subtotal.Cents);           // 5 * 1000
        Assert.Equal("50.00", dto.Subtotal.Amount);
        Assert.Equal(500, dto.Tax.Cents);                 // 10%
        Assert.Equal(7000, dto.Total.Cents);              // 5000 + 500 + 1500 shipping
        Assert.Equal("70.00", dto.Total.Amount);

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
        var svc = new CreateOrderService(db, new FixedDirectory("usr_a"), new NoopEventPublisher(), new FixedConfig(0.10m), new SpyTracking(), new WorkflowTracer(), new NoopCacheInvalidator(), AssetsBaseUrl, NullLogger<CreateOrderService>.Instance);

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
        var svc = new CreateOrderService(db, new FixedDirectory("usr_a"), new NoopEventPublisher(), new FixedConfig(0.10m), new SpyTracking(), new WorkflowTracer(), new NoopCacheInvalidator(), AssetsBaseUrl, NullLogger<CreateOrderService>.Instance);

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
        var svc = new CreateOrderService(db, new FixedDirectory(null), new NoopEventPublisher(), new FixedConfig(0.10m), new SpyTracking(), new WorkflowTracer(), new NoopCacheInvalidator(), AssetsBaseUrl, NullLogger<CreateOrderService>.Instance);

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
        var svc = new CreateOrderService(db, new FixedDirectory("usr_a"), new NoopEventPublisher(), new FixedConfig(0.10m), new SpyTracking(), new WorkflowTracer(), new NoopCacheInvalidator(), AssetsBaseUrl, NullLogger<CreateOrderService>.Instance);

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

    [Fact]
    public async Task Captures_the_product_name_and_image_on_the_line_at_purchase_time()
    {
        var image = new ProductImage("products/runner.jpg", 1080, 720, "LWMj?rRjD%of");
        var productId = await SeedProduct(stock: 10, priceCents: 1000, name: "Runner Low Canvas", image: image);
        await using var db = Ctx();
        var svc = new CreateOrderService(db, new FixedDirectory("usr_a"), new NoopEventPublisher(), new FixedConfig(0.10m), new SpyTracking(), new WorkflowTracer(), new NoopCacheInvalidator(), AssetsBaseUrl, NullLogger<CreateOrderService>.Instance);

        var dto = await svc.CreateAsync(
            new CreateOrderCommand(new[] { new CreateOrderLine(productId, 3) }), "sub-a");

        // The response carries the ABSOLUTE url, composed from AssetsBaseUrl. Asserted
        // literally: a single slash proves the trailing one on the base was trimmed.
        var line = Assert.Single(dto.Lines);
        Assert.Equal("Runner Low Canvas", line.Name);
        Assert.NotNull(line.Image);
        Assert.Equal("https://assets.test/products/runner.jpg", line.Image!.Uri);
        Assert.Equal(1080, line.Image.Width);
        Assert.Equal(720, line.Image.Height);
        Assert.Equal("LWMj?rRjD%of", line.Image.Blurhash);

        // PERSISTED, not merely mapped into the response: re-read the row. The stored uri
        // stays RELATIVE — persisting the absolute form would be dead data once the
        // bucket is re-minted.
        var order = await db.Orders.Include(o => o.Details).FirstAsync(o => o.Id == dto.Id);
        var detail = Assert.Single(order.Details);
        Assert.Equal("Runner Low Canvas", detail.ProductName);
        Assert.NotNull(detail.ProductImage);
        Assert.Equal("products/runner.jpg", detail.ProductImage!.Uri);
        Assert.Equal(720, detail.ProductImage.Height);
        Assert.Equal("LWMj?rRjD%of", detail.ProductImage.Blurhash);
    }

    [Fact]
    public async Task A_product_with_no_image_yields_a_null_line_image_and_still_captures_the_name()
    {
        var productId = await SeedProduct(stock: 10, priceCents: 1000, name: "Linen Cap", image: null);
        await using var db = Ctx();
        var svc = new CreateOrderService(db, new FixedDirectory("usr_a"), new NoopEventPublisher(), new FixedConfig(0.10m), new SpyTracking(), new WorkflowTracer(), new NoopCacheInvalidator(), AssetsBaseUrl, NullLogger<CreateOrderService>.Instance);

        var dto = await svc.CreateAsync(
            new CreateOrderCommand(new[] { new CreateOrderLine(productId, 1) }), "sub-a");

        // Null, not a throw and not a base-url-only string like "https://assets.test/":
        // the client renders its own placeholder for an absent image.
        var line = Assert.Single(dto.Lines);
        Assert.Equal("Linen Cap", line.Name);
        Assert.Null(line.Image);

        var order = await db.Orders.Include(o => o.Details).FirstAsync(o => o.Id == dto.Id);
        Assert.Null(Assert.Single(order.Details).ProductImage);
    }

    [Fact]
    public async Task The_captured_snapshot_survives_a_later_rename_and_re_shoot_of_the_product()
    {
        var productId = await SeedProduct(
            stock: 10, priceCents: 1000, name: "Original Name",
            image: new ProductImage("products/original.jpg", 100, 200, "BLUR-A"));
        await using var db = Ctx();
        var svc = new CreateOrderService(db, new FixedDirectory("usr_a"), new NoopEventPublisher(), new FixedConfig(0.10m), new SpyTracking(), new WorkflowTracer(), new NoopCacheInvalidator(), AssetsBaseUrl, NullLogger<CreateOrderService>.Instance);
        var dto = await svc.CreateAsync(
            new CreateOrderCommand(new[] { new CreateOrderLine(productId, 1) }), "sub-a");

        // Rename and re-shoot the catalogue product AFTER the order exists.
        var product = await db.Products.FirstAsync(p => p.Id == productId);
        product.Name = "Renamed Product";
        product.Image = new ProductImage("products/renamed.jpg", 300, 400, "BLUR-B");
        await db.SaveChangesAsync();

        // The receipt still says what it said when it was issued. This is the whole point
        // of persisting the snapshot rather than joining the live catalogue on read.
        await using var fresh = Ctx();
        var order = await fresh.Orders.Include(o => o.Details).AsNoTracking().FirstAsync(o => o.Id == dto.Id);
        var detail = Assert.Single(order.Details);
        Assert.Equal("Original Name", detail.ProductName);
        Assert.Equal("products/original.jpg", detail.ProductImage!.Uri);
        Assert.Equal("BLUR-A", detail.ProductImage.Blurhash);
    }
}
