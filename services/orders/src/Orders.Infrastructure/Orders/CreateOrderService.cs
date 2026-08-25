using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Orders.Application.Abstractions;
using Orders.Application.Identity;
using Orders.Application.Orders;
using Orders.Application.Tracking;
using Orders.Domain;
using Orders.Domain.Entities;
using Orders.Domain.Pricing;
using Orders.Infrastructure.Id;
using Orders.Infrastructure.Observability;
using Orders.Infrastructure.Persistence;

namespace Orders.Infrastructure.Orders;

// Every write runs inside a transaction. Resolves identity via IUserDirectory
// (gRPC), locks each product row FOR UPDATE, validates + decrements stock,
// persists order+lines with BOTH identifiers, emits ORDER_CREATED. Any failure
// rolls the whole thing back.
//
// Lives in Infrastructure (not Application, as the plan drafted) because it
// depends on OrdersWriteDbContext + EF Core; Application must not reference
// Infrastructure or that would invert the Clean Architecture dependency
// direction. It mirrors OrderReadService. Application owns the command records,
// exceptions, and ports (IUserDirectory / IEventPublisher); the Api wires this
// concrete service.
public class CreateOrderService
{
    private readonly OrdersWriteDbContext _db;
    private readonly IUserDirectory _users;
    private readonly IEventPublisher _events;
    private readonly IConfigurationReader _config;
    private readonly ITrackingInitiator _tracking;
    private readonly IWorkflowTracer _tracer;
    private readonly ILogger<CreateOrderService> _logger;

    public CreateOrderService(
        OrdersWriteDbContext db,
        IUserDirectory users,
        IEventPublisher events,
        IConfigurationReader config,
        ITrackingInitiator tracking,
        IWorkflowTracer tracer,
        ILogger<CreateOrderService> logger)
    {
        _db = db;
        _users = users;
        _events = events;
        _config = config;
        _tracking = tracking;
        _tracer = tracer;
        _logger = logger;
    }

    /// <param name="testMode">
    /// Forwarded to Tracking as <c>x-test-mode</c>. The Api layer is responsible for the
    /// <c>E2E_TESTING_ENABLED</c> guard, so a production runtime always passes false here
    /// regardless of what the client sent.
    /// </param>
    /// <param name="e2eSource">
    /// Tags the order with <c>"E2E Source"</c> so the e2e-cleanup endpoint can find it, and
    /// is forwarded to Tracking as <c>x-e2e-source</c> so its record is tagged too. Same
    /// division of responsibility as <paramref name="testMode"/>: the Api layer applies the
    /// <c>E2E_TESTING_ENABLED</c> guard, so production always passes false.
    /// </param>
    public async Task<OrderDto> CreateAsync(
        CreateOrderCommand command,
        string cognitoSub,
        bool testMode = false,
        bool e2eSource = false,
        CancellationToken ct = default)
    {
        // The workflow span for the ONE Orders flow that carries flow logs. Its
        // attributes mirror the create_order_started/_succeeded/_failed log lines
        // below, so the trace and the log stream say the same thing.
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

        // Failure branches are logged HERE, at the step that produces them: by
        // the time the endpoint maps the exception to a status code it is just
        // a typed error, and "the caller is unknown" versus "the product is out
        // of stock" are different operational problems. Each rethrows
        // untouched, so the 404/409 HTTP contract is unchanged.
        //
        // ResolveCallerAsync, not ResolveInternalUserIdAsync: order creation needs the
        // delivery address as well as the id, and both ride on the SAME GetUserById
        // response — asking twice would spend an extra round trip for data already in hand.
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

        // Serialized ONCE, here, and then used for two things: persisted on the order and
        // handed to Tracking after the commit. Serializing separately per destination is
        // how the two copies would drift. PII — never logged, never put in an exception.
        var shippingAddressJson = ShippingAddressSnapshot.Serialize(caller.Address);

        // Tax rate is read per-request from the configuration table (not an env var).
        var taxRate = await _config.GetTaxRateAsync(ct);

        // Same source as the tax rate: a flat, ORDER-level delivery charge, read per-request
        // so it can change without a redeploy. Read here, next to the rate, but applied ONCE
        // to the order below — never inside the per-line pricing loop. It is charged for the
        // shipment, not per product, so it deliberately never reaches OrderPricing.PriceLine
        // or any OrderDetail: a line whose total exceeded unit_price * quantity could not be
        // explained from its own columns.
        var shippingCents = await _config.GetShippingCentsAsync(ct);

        // Wrap the whole transactional write so the audit interceptor stamps
        // CreatedBy/UpdatedBy with `orders_api:create_order` rather than the
        // buyer's id. The buyer is still traced via UserId/CognitoSub on the row;
        // CreatedBy now describes WHAT produced it (mirrors Users' runAsActor).
        return await AmbientActor.RunAsync(AuditActor.CreateOrder, async () =>
        {
            await using var tx = await _db.Database.BeginTransactionAsync(ct);

            var now = DateTime.UtcNow;
            var order = new Order
            {
                Id = NanoId.NewId(NanoId.OrderPrefix),
                UserId = userId,
                CognitoSub = cognitoSub,
                // Point-in-time snapshot: a later edit to the user's profile address must
                // not rewrite where THIS shipment was sent. Null when none is on file.
                ShippingAddress = shippingAddressJson,
                // Empty list, not null, when this is an ordinary order (see Order.Tags).
                Tags = e2eSource ? new List<string> { Order.E2eSourceTag } : new List<string>(),
                CreatedAt = now,
                UpdatedAt = now,
            };

            long subtotal = 0, tax = 0, total = 0;

            // Consolidate duplicate lines (same ProductId) BEFORE locking/pricing so
            // each product is locked, validated, priced, and decremented exactly ONCE
            // per order, and produces a single OrderDetail row with the summed
            // quantity. Ordered by ProductId for a stable, deterministic lock order.
            var consolidatedLines = command.Lines
                .GroupBy(l => l.ProductId)
                .Select(g => new CreateOrderLine(g.Key, (uint)g.Sum(l => (long)l.Quantity)))
                .OrderBy(l => l.ProductId, StringComparer.Ordinal)
                .ToList();

            // The emailed receipt's line items, assembled IN the pricing loop below rather
            // than after it. That loop is the only place a Product entity is in hand:
            // OrderDetail records ProductId alone, so once it ends the names are gone and
            // recovering them would cost a second query for rows this transaction has
            // already read and locked. One entry per consolidated line, so it matches
            // order.Details exactly.
            var eventItems = new List<OrderCreatedItem>(consolidatedLines.Count);

            foreach (var line in consolidatedLines)
            {
                // Pessimistic lock so concurrent orders cannot oversell. Pure LINQ
                // tagged with ForUpdateInterceptor.Tag — the interceptor appends
                // FOR UPDATE, and EF Core's global query filter applies deleted_at
                // IS NULL automatically (ADR-0004), so a soft-deleted product is
                // never locked/read/sold. Requires the open write transaction above.
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

                // Captured here, from the entity already loaded above, so it is a
                // point-in-time snapshot of the catalogue: a later rename or repricing must
                // never rewrite what a past receipt said, exactly like the money columns
                // being persisted on the line below.
                eventItems.Add(new OrderCreatedItem(product.Name, line.Quantity, product.UnitPriceCents));

                order.Details.Add(new OrderDetail
                {
                    Id = NanoId.NewId(NanoId.OrderDetailPrefix),
                    OrderId = order.Id,
                    ProductId = product.Id,
                    UserId = userId,
                    CognitoSub = cognitoSub,
                    Quantity = line.Quantity,
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

            // `total` accumulated above is the LINE total (subtotal + tax summed across
            // details); shipping is added once here because it is charged per shipment.
            // This is the one place the order's total diverges from the sum of its lines,
            // and it is why the emailed receipt's Subtotal/Shipping/Tax/Total adds up.
            total += shippingCents;
            order.TotalCents = total;

            _db.Orders.Add(order);
            await _db.SaveChangesAsync(ct);
            // caller.Email and caller.FullName both come from the GetUserById round
            // trip this method already makes: the pipeline's ORDER_CREATED handler
            // renders the confirmation mail and needs a recipient and a greeting, and
            // Orders stores neither of its own. No extra call for either.
            //
            // The money breakdown travels as four separate figures — subtotal, tax,
            // shipping, total — because the mail is an itemised RECEIPT that prints all
            // four and a reader checks the arithmetic. The consumer must never derive one
            // from the others; they are computed once, here, by the code that priced the
            // order.
            //
            // shippingAddressJson is the SAME serialization persisted on the order and
            // handed to Tracking, not a third rendering of the address — null when the
            // buyer has none on file, which the publisher omits from the wire rather than
            // sending as null.
            //
            // eventItems carries the product NAMES, which is the one thing the consumer
            // could not obtain for itself: it has no access to this database, and
            // OrderDetail stores only ProductId.
            //
            // cognitoSub is the request's own identity, already in hand and already
            // stamped onto the order above. It lands in the envelope's `author` block —
            // WHO originated the event, alongside the userId that says who it is about
            // (the same person here; not on every event).
            await _events.PublishOrderCreatedAsync(
                order.Id, userId, caller.Email, caller.FullName,
                subtotal, tax, shippingCents, total,
                shippingAddressJson, eventItems, now, cognitoSub, ct);
            await tx.CommitAsync(ct);

            // AFTER the commit: the order genuinely exists at this point, so the
            // success line never claims something a rollback later undid.
            _logger.LogInformation(
                "Order creation completed {app_event} {order_id} {line_count} {total_cents}",
                "create_order_succeeded", order.Id, order.Details.Count, total);
            // The span carries the same identity the success log line does. Set
            // here, not in CreateAsync: the id only exists once the transaction
            // that minted it has committed.
            _tracer.SetAttribute("app_event", "create_order_succeeded");
            _tracer.SetAttribute("order_id", order.Id);

            // Tracking is initiated AFTER the commit, deliberately, for two reasons.
            //
            //   1. Locks. The loop above holds `SELECT ... FOR UPDATE` on every product in
            //      the order. A network call inside the transaction would hold those row
            //      locks for the duration of that call (up to the client's 5s timeout),
            //      blocking every other order touching the same products — one slow
            //      downstream would serialize the whole catalog's checkout path.
            //   2. Durability. The client's entire failure design assumes the order already
            //      exists: it never throws, precisely so a tracking hiccup cannot roll back
            //      a committed order. Calling it inside the transaction would invert that —
            //      Tracking could create a record for an order a later rollback erased.
            //
            // The outcome therefore only ever affects the log stream: the order is created
            // and its 201 response is identical regardless of what Tracking answers.
            var trackingResult = await _tracking.InitTrackingAsync(
                order.Id, shippingAddressJson, cognitoSub, testMode, e2eSource, ct);

            if (!trackingResult.IsTracked)
            {
                // IsTracked (not `== Created`) is the success predicate: a 409 means the
                // order is already tracked, which is the end state we wanted.
                //
                // The order itself succeeded, so this is a WARNING, not an ERROR: the
                // request did what the customer asked and returns 201. What is degraded is
                // a downstream side effect — a real, backfillable gap worth alerting on,
                // but not a failed order. Never log the address here (PII).
                _logger.LogWarning(
                    "Tracking initiation did not succeed for a created order {app_event} {reason} {order_id} {status_code}",
                    "init_tracking_failed", ReasonFor(trackingResult.Outcome), order.Id, trackingResult.StatusCode);
            }

            // Map the in-memory order (order.Details already populated) instead of
            // re-querying — mirrors OrderReadService.Map exactly; keep both in sync.
            return new OrderDto(
                order.Id, order.UserId, order.CognitoSub,
                Money.FromCents(order.SubtotalCents), Money.FromCents(order.TaxCents), Money.FromCents(order.ShippingCents), Money.FromCents(order.TotalCents),
                order.CreatedAt,
                order.Details.Select(d => new OrderLineDto(
                    d.ProductId, d.Quantity,
                    Money.FromCents(d.SubtotalCents), Money.FromCents(d.TaxCents), Money.FromCents(d.TotalCents)))
                    .ToList());
        });
    }

    // One `reason` per outcome that can actually reach this branch, per the logging
    // convention (a reason vocabulary describes real code paths, not speculative ones).
    // Created/AlreadyTracked are unreachable here — both satisfy IsTracked.
    private static string ReasonFor(TrackingInitOutcome outcome) => outcome switch
    {
        TrackingInitOutcome.UnknownUser => "tracking_unknown_user",
        TrackingInitOutcome.Unauthorized => "tracking_missing_user_header",
        TrackingInitOutcome.Unreachable => "tracking_unreachable",
        _ => "tracking_rejected",
    };
}
