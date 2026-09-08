using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Orders.Application.Abstractions;
using Orders.Application.Identity;
using Orders.Application.Orders;
using Orders.Application.Tracking;
using Orders.Domain.Entities;
using Orders.Domain.Pricing;
using Orders.Domain;
using Orders.Infrastructure.Caching;
using Orders.Infrastructure.Carts;
using Orders.Infrastructure.Id;
using Orders.Infrastructure.Observability;
using Orders.Infrastructure.Persistence;

namespace Orders.Infrastructure.Orders;

// Every write runs inside a transaction: resolve identity via IUserDirectory (gRPC), lock
// each product row FOR UPDATE, validate and decrement stock, persist order + lines with
// both identifiers, emit ORDER_CREATED. Any failure rolls the whole thing back.
public class CreateOrderService
{
    private readonly OrdersWriteDbContext _db;
    private readonly IUserDirectory _users;
    private readonly IEventPublisher _events;
    private readonly IConfigurationReader _config;
    private readonly ITrackingInitiator _tracking;
    private readonly IWorkflowTracer _tracer;
    private readonly ICacheInvalidator _cache;
    private readonly string _assetsBaseUrl;
    private readonly ILogger<CreateOrderService> _logger;

    /// <param name="assetsBaseUrl">
    /// Assets base URL used ONLY to render the response's image URLs; the row stores the
    /// bucket-relative key. A trailing slash is tolerated. See ProductReadService.
    /// </param>
    public CreateOrderService(
        OrdersWriteDbContext db,
        IUserDirectory users,
        IEventPublisher events,
        IConfigurationReader config,
        ITrackingInitiator tracking,
        IWorkflowTracer tracer,
        ICacheInvalidator cache,
        string assetsBaseUrl,
        ILogger<CreateOrderService> logger)
    {
        _db = db;
        _users = users;
        _events = events;
        _config = config;
        _tracking = tracking;
        _tracer = tracer;
        _cache = cache;
        _assetsBaseUrl = assetsBaseUrl.TrimEnd('/');
        _logger = logger;
    }

    /// <param name="testMode">Forwarded to Tracking as <c>x-test-mode</c>.</param>
    /// <param name="e2eSource">
    /// Tags the order with <c>"E2E Source"</c> for the e2e-cleanup endpoint and forwards
    /// <c>x-e2e-source</c> to Tracking.
    /// CONTRACT: The Api layer owns the <c>E2E_TESTING_ENABLED</c> guard for both flags, so
    /// production passes false whatever the client sent. See [[testing]]
    /// </param>
    public async Task<OrderDto> CreateAsync(
        CreateOrderCommand command,
        string cognitoSub,
        bool testMode = false,
        bool e2eSource = false,
        CancellationToken ct = default)
    {
        // WHY: The span's attributes mirror the create_order_* log lines below, so the
        // trace and the log stream say the same thing. See [[logging-context]]
        return await _tracer.TraceWorkflowAsync(
            "create_order",
            new Dictionary<string, object?> { ["app_event"] = "create_order_started" },
            () => CreateInternalAsync(command, cognitoSub, testMode, e2eSource, ct));
    }

    private async Task<OrderDto> CreateInternalAsync(
        CreateOrderCommand command,
        string cognitoSub,
        bool testMode,
        bool e2eSource,
        CancellationToken ct)
    {
        _logger.LogInformation(
            "Starting order creation {app_event} {line_count}",
            "create_order_started", command.Lines.Count);

        // WHY: Failure branches are logged at the step that produces them — by the endpoint
        // they are indistinguishable typed errors. Each rethrows untouched, so the 404/409
        // contract is unchanged. ResolveCallerAsync (not the id-only call) because the
        // address rides on the same GetUserById response. See [[logging-context]]
        var caller = await _users.ResolveCallerAsync(cognitoSub, ct);
        if (caller is null)
        {
            _logger.LogError(
                "Order creation failed: the caller is not a known user {app_event} {reason}",
                "create_order_failed", "unknown_user");
            _tracer.SetReason("unknown_user");
            throw new UnknownUserException(cognitoSub);
        }

        var userId = caller.InternalUserId;

        // CONTRACT: Serialize the address ONCE and reuse it for the order row and Tracking —
        // per-destination serialization is how the two copies drift. PII: never log it and
        // never put it in an exception. See [[logging-context]]
        var shippingAddressJson = ShippingAddressSnapshot.Serialize(caller.Address);

        // Tax rate is read per-request from the configuration table (not an env var).
        var taxRate = await _config.GetTaxRateAsync(ct);

        // CONTRACT: Apply shipping ONCE at order level, never inside the per-line pricing
        // loop. It is charged per shipment, so it must not reach OrderPricing.PriceLine or
        // any OrderDetail — a line total exceeding unit_price * quantity cannot be explained
        // from its own columns. See [[money-representation]]
        var shippingCents = await _config.GetShippingCentsAsync(ct);

        // WHY: The audit interceptor stamps CreatedBy/UpdatedBy with the actor, describing
        // WHAT produced the row; the buyer is traced via UserId/CognitoSub.
        // See [[audit-fields]]
        return await AmbientActor.RunAsync(AuditActor.CreateOrder, async () =>
        {
            await using var tx = await _db.Database.BeginTransactionAsync(ct);

            var now = DateTime.UtcNow;
            var order = new Order
            {
                Id = NanoId.NewId(NanoId.OrderPrefix),
                UserId = userId,
                CognitoSub = cognitoSub,
                // WHY: Point-in-time snapshot — a later profile edit must not rewrite where
                // THIS shipment was sent. Null when none is on file.
                ShippingAddress = shippingAddressJson,
                // Empty list, not null, when this is an ordinary order (see Order.Tags).
                Tags = e2eSource ? new List<string> { Order.E2eSourceTag } : new List<string>(),
                CreatedAt = now,
                UpdatedAt = now,
            };

            long subtotal = 0, tax = 0, total = 0;

            // CONTRACT: Consolidate duplicate ProductIds BEFORE locking, so each product is
            // locked, priced and decremented exactly once. Ordered by ProductId for a
            // deterministic lock order — otherwise two concurrent orders deadlock.
            var consolidatedLines = command.Lines
                .GroupBy(l => l.ProductId)
                .Select(g => new CreateOrderLine(g.Key, (uint)g.Sum(l => (long)l.Quantity)))
                .OrderBy(l => l.ProductId, StringComparer.Ordinal)
                .ToList();

            // WHY: Filled inside the pricing loop, the only place a Product entity is in
            // hand — OrderDetail records ProductId alone, so recovering names afterwards
            // costs a second query for rows already read and locked.
            var eventItems = new List<OrderCreatedItem>(consolidatedLines.Count);

            foreach (var line in consolidatedLines)
            {
                // CONTRACT: Keep the ForUpdateInterceptor.Tag — it appends FOR UPDATE, and
                // without the pessimistic lock concurrent orders oversell the same stock.
                // Requires the open write transaction above. See [[ADR-0004-soft-delete-only]]
                var product = await _db.Products
                    .TagWith(ForUpdateInterceptor.Tag)
                    .FirstOrDefaultAsync(p => p.Id == line.ProductId, ct);

                if (product is null)
                {
                    _logger.LogError(
                        "Order creation failed: unknown product {app_event} {reason} {product_id}",
                        "create_order_failed", "unknown_product", line.ProductId);
                    _tracer.SetReason("unknown_product");
                    throw new UnknownProductException(line.ProductId);
                }

                if (product.UnitsInStock < line.Quantity)
                {
                    _logger.LogError(
                        "Order creation failed: insufficient stock {app_event} {reason} {product_id} {requested} {available}",
                        "create_order_failed", "insufficient_stock", line.ProductId,
                        line.Quantity, product.UnitsInStock);
                    _tracer.SetReason("insufficient_stock");
                    throw new InsufficientStockException(line.ProductId);
                }

                var (lineSub, lineTax, lineTotal) = OrderPricing.PriceLine(product.UnitPriceCents, line.Quantity, taxRate);
                subtotal += lineSub;
                tax += lineTax;
                total += lineTotal;

                product.UnitsInStock -= line.Quantity;
                product.UpdatedAt = now;

                // WHY: A point-in-time snapshot of the catalogue — a later rename or
                // repricing must never rewrite what a past receipt said.
                eventItems.Add(new OrderCreatedItem(product.Name, line.Quantity, product.UnitPriceCents));

                order.Details.Add(new OrderDetail
                {
                    Id = NanoId.NewId(NanoId.OrderDetailPrefix),
                    OrderId = order.Id,
                    ProductId = product.Id,
                    UserId = userId,
                    CognitoSub = cognitoSub,
                    Quantity = line.Quantity,
                    // Same snapshot as eventItems above, and for the same reason: the
                    // receipt must not change when the catalogue does. The Uri stays
                    // relative — OrderLineMapper composes the absolute form on read.
                    ProductName = product.Name,
                    ProductImage = product.Image,
                    SubtotalCents = lineSub,
                    TaxCents = lineTax,
                    TotalCents = lineTotal,
                    CreatedAt = now,
                    UpdatedAt = now,
                });
            }

            order.SubtotalCents = subtotal;
            order.TaxCents = tax;
            order.ShippingCents = shippingCents;

            // CONTRACT: Shipping is added once, here — the one place the order total
            // diverges from the sum of its lines. See [[money-representation]]
            total += shippingCents;
            order.TotalCents = total;

            _db.Orders.Add(order);

            // CONTRACT: Delete the cart INSIDE this transaction. Outside it, a rollback
            // (insufficient stock, a failed write) loses the buyer's selection AND the
            // order. Routed through CartWriteService so the three deletion paths cannot
            // drift apart; no-ops when the caller had no cart. See [[soft-delete]]
            await CartWriteService.DeleteForUserAsync(_db, cognitoSub, ct);

            await _db.SaveChangesAsync(ct);
            // CONTRACT: The consumer has no access to this database, so everything the
            // receipt prints travels here — recipient, greeting, product names, and all four
            // money figures, which it must never derive from one another. The address is the
            // same serialization persisted above, not a third rendering.
            // See [[events-pipeline-design]]
            await _events.PublishOrderCreatedAsync(
                order.Id, userId, caller.Email, caller.FullName,
                subtotal, tax, shippingCents, total,
                shippingAddressJson, eventItems, now, cognitoSub, ct);
            await tx.CommitAsync(ct);

            // CONTRACT: Invalidate AFTER the commit, never before. A concurrent read landing
            // between the delete and the commit repopulates the pre-order state, which then
            // sits stale for its full TTL. One commit staled three entries — cart, my-orders,
            // catalogue stock counts — and this removes all three. ICacheInvalidator swallows
            // its own failures so it cannot fail a paid order.
            // See [[x-cache-response-header]]
            await _cache.InvalidateOrderCreationAsync(cognitoSub, ct);

            // WHY: After the commit, so the success line never claims something a rollback
            // later undid.
            _logger.LogInformation(
                "Order creation completed {app_event} {order_id} {line_count} {total_cents}",
                "create_order_succeeded", order.Id, order.Details.Count, total);
            // WHY: Set here, not in CreateAsync — the id only exists once the transaction
            // that minted it has committed.
            _tracer.SetAttribute("app_event", "create_order_succeeded");
            _tracer.SetAttribute("order_id", order.Id);

            // CONTRACT: Call Tracking AFTER the commit, never inside the transaction. The
            // loop above holds FOR UPDATE on every product, and a network call would hold
            // those row locks for its whole timeout, serializing the entire catalogue's
            // checkout. It also would let Tracking record an order a later rollback erased.
            // The outcome only affects the log stream; the 201 is identical either way.
            // See [[orders-service-design]]
            var trackingResult = await _tracking.InitTrackingAsync(
                order.Id, shippingAddressJson, cognitoSub, testMode, e2eSource, ct);

            if (!trackingResult.IsTracked)
            {
                // CONTRACT: Never log the address here (PII). WARNING, not ERROR — the order
                // succeeded and returns 201; only a downstream side effect is degraded.
                // IsTracked (not `== Created`) is the predicate: a 409 is already tracked.
                _logger.LogWarning(
                    "Tracking initiation did not succeed for a created order {app_event} {reason} {order_id} {status_code}",
                    "init_tracking_failed", ReasonFor(trackingResult.Outcome), order.Id, trackingResult.StatusCode);
            }

            // CONTRACT: Keep this mapping in sync with OrderReadService.Map — it maps the
            // in-memory order rather than re-querying, so the two can silently diverge.
            return new OrderDto(
                order.Id, order.UserId, order.CognitoSub,
                Money.FromCents(order.SubtotalCents), Money.FromCents(order.TaxCents), Money.FromCents(order.ShippingCents), Money.FromCents(order.TotalCents),
                order.CreatedAt,
                order.Details.Select(d => OrderLineMapper.Map(d, _assetsBaseUrl)).ToList());
        });
    }

    // WHY: One reason per outcome that can actually reach this branch. Created and
    // AlreadyTracked are unreachable — both satisfy IsTracked. See [[logging-context]]
    private static string ReasonFor(TrackingInitOutcome outcome) => outcome switch
    {
        TrackingInitOutcome.UnknownUser => "tracking_unknown_user",
        TrackingInitOutcome.Unauthorized => "tracking_missing_user_header",
        TrackingInitOutcome.Unreachable => "tracking_unreachable",
        _ => "tracking_rejected",
    };
}
