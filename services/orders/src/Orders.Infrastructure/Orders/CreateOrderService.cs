using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Orders.Application.Abstractions;
using Orders.Application.Identity;
using Orders.Application.Orders;
using Orders.Application.Payments;
using Orders.Application.Tracking;
using Orders.Domain.Entities;
using Orders.Domain.Pricing;
using Orders.Domain;
using Orders.Domain.Payments;
using Orders.Infrastructure.Caching;
using Orders.Infrastructure.Carts;
using Orders.Infrastructure.Id;
using Orders.Infrastructure.Observability;
using Orders.Infrastructure.Payments;
using Orders.Infrastructure.Persistence;
using Orders.Infrastructure.Persistence.Configurations;

namespace Orders.Infrastructure.Orders;

// Every write runs inside a transaction: resolve identity via IUserDirectory (gRPC), lock
// each product row FOR UPDATE, validate and decrement stock, persist order + lines with
// both identifiers, emit ORDER_CREATED. Any failure rolls the whole thing back. With Stripe
// enabled the order is charged BEFORE that transaction opens.
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
    private readonly StripeSettings _stripe;
    private readonly StripePaymentCharger _charger;

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
        ILogger<CreateOrderService> logger,
        StripeSettings? stripe = null,
        StripePaymentCharger? charger = null)
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
        _stripe = stripe ?? new StripeSettings(Enabled: false);
        _charger = charger ?? new StripePaymentCharger(client: null, NullLogger<StripePaymentCharger>.Instance);
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
        CancellationToken ct = default) =>
        (await CreateOrReplayAsync(command, cognitoSub, testMode, e2eSource, ct)).Order;

    /// <summary>
    /// Creates the order, or returns the one the caller's Idempotency-Key already produced.
    /// </summary>
    /// <inheritdoc cref="CreateAsync" path="/param"/>
    public async Task<CreateOrderResult> CreateOrReplayAsync(
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

    private async Task<CreateOrderResult> CreateInternalAsync(
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

        // CONTRACT: With Stripe on, a (user, Idempotency-Key) pair that already has an order gets
        // THAT order back, before any pricing or charge — or 422 when the request's fingerprint
        // differs from the one stored with it. See [[2026-09-19-stripe-payments-design]]
        var clientKey = _stripe.Enabled
            ? command.IdempotencyKey
                ?? throw new ArgumentException("An Idempotency-Key is required when Stripe is enabled.", nameof(command))
            : null;
        var requestHash = clientKey is null ? null : CreateOrderFingerprint.Compute(command);
        if (clientKey is not null && await FindByIdempotencyKeyAsync(userId, clientKey, ct) is { } existing)
        {
            return ReplayOrReject(existing, requestHash);
        }

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

        // CONTRACT: Consolidate duplicate ProductIds BEFORE locking, so each product is
        // locked, priced and decremented exactly once. Ordered by ProductId for a
        // deterministic lock order — otherwise two concurrent orders deadlock.
        var consolidatedLines = command.Lines
            .GroupBy(l => l.ProductId)
            .Select(g => new CreateOrderLine(g.Key, (uint)g.Sum(l => (long)l.Quantity)))
            .OrderBy(l => l.ProductId, StringComparer.Ordinal)
            .ToList();

        // WHY: Derived from (user, key) on the Stripe path — the id travels as PaymentIntent
        // metadata, and a retry sending a different id is rejected by Stripe as a mismatch.
        var orderId = clientKey is null
            ? NanoId.NewId(NanoId.OrderPrefix)
            : NanoId.DerivedId(NanoId.OrderPrefix, $"{userId}\n{clientKey}");

        // CONTRACT: Charge BEFORE persisting and OUTSIDE the transaction below. After it, a
        // failed charge leaves an order nobody paid for; inside it, the FOR UPDATE locks are
        // held for the whole Stripe round trip and checkout serializes on those products.
        // See [[2026-09-19-stripe-payments-design]]
        PaymentSnapshot? payment = null;
        if (_stripe.Enabled)
        {
            var paymentMethodId = command.PaymentMethodId
                ?? throw new ArgumentException("A payment method is required when Stripe is enabled.", nameof(command));
            var amountCents = await PriceForChargeAsync(consolidatedLines, taxRate, shippingCents, ct);
            try
            {
                payment = await _charger.ChargeAsync(
                    orderId, amountCents, caller.StripeCustomerId, paymentMethodId,
                    StripePaymentCharger.ChargeIdempotencyKeyFor(userId, clientKey!), ct);
            }
            catch (Exception ex) when (ex is IdempotencyKeyReusedException or IdempotencyKeyMismatchException)
            {
                KeyRejected(ex is IdempotencyKeyReusedException ? "idempotency_key_reused" : "idempotency_key_mismatch", orderId);
                throw;
            }
            catch (IdempotencyKeyInFlightException ex)
            {
                if (await AwaitInFlightOrderAsync(userId, clientKey!, ct) is { } inFlight)
                {
                    return ReplayOrReject(inFlight, requestHash);
                }

                // CONTRACT: WARNING, never ERROR — a double-submitted checkout is routine, and the
                // client's retry after Retry-After finds the order. See [[logging-context]]
                _logger.LogWarning(
                    "Order creation deferred: the same idempotency key is still in flight {app_event} {reason} {order_id}",
                    "create_order_failed", ex.Reason, orderId);
                _tracer.SetReason(ex.Reason);
                throw;
            }
            catch (PaymentDeclinedException ex)
            {
                // WHY: The charger wrote the payment_declined line; the workflow span carries the
                // same three fields. WorkflowTracer leaves this span's status Unset.
                _tracer.SetAttribute("app_event", "payment_declined");
                _tracer.SetReason(ex.Reason);
                _tracer.SetAttribute("order_id", orderId);
                throw;
            }
            catch (PaymentUnavailableException ex)
            {
                _logger.LogError(
                    "Order creation failed: payments unavailable {app_event} {reason} {order_id}",
                    "create_order_failed", ex.Reason, orderId);
                _tracer.SetReason(ex.Reason);
                throw;
            }
        }

        // CONTRACT: A succeeded charge is refunded if ANYTHING fails before the commit — a stock
        // conflict or deleted product found under the lock, the price guard, a failed save or
        // commit. The original exception still propagates, so the caller keeps its 409/404/500.
        // One exception: a concurrent duplicate that lost the insert race gets the winner's
        // order, and is NOT refunded — Stripe replayed the winner's PaymentIntent to it.
        // See [[2026-09-19-stripe-payments-design]]
        var committed = false;
        try
        {
            return new CreateOrderResult(await PersistAsync(), Created: true);
        }
        catch (Exception ex) when (!committed && (payment is not null || clientKey is not null))
        {
            if (ex is DbUpdateException
                && clientKey is not null
                && await FindByIdempotencyKeyAsync(userId, clientKey, ct) is { } winner)
            {
                if (payment is not null && winner.PaymentIntentId != payment.PaymentIntentId)
                {
                    await _charger.RefundAsync(orderId, payment.PaymentIntentId);
                }

                return ReplayOrReject(winner, requestHash);
            }

            if (payment is not null)
            {
                await _charger.RefundAsync(orderId, payment.PaymentIntentId);
            }

            throw;
        }

        // WHY: The audit interceptor stamps CreatedBy/UpdatedBy with the actor, describing
        // WHAT produced the row; the buyer is traced via UserId/CognitoSub.
        // See [[audit-fields]]
        Task<OrderDto> PersistAsync() => AmbientActor.RunAsync(AuditActor.CreateOrder, async () =>
        {
            await using var tx = await _db.Database.BeginTransactionAsync(ct);

            var now = DateTime.UtcNow;
            if (clientKey is not null)
            {
                // WHY: created_at stores microseconds; truncating here makes the 201 body and a
                // later replayed 200 body byte-identical.
                now = new DateTime(now.Ticks - (now.Ticks % 10), DateTimeKind.Utc);
            }

            var order = new Order
            {
                Id = orderId,
                IdempotencyKey = clientKey,
                IdempotencyRequestHash = requestHash,
                // CONTRACT: Minted from the order's OWN creation instant, in UTC, so the
                // number stays reproducible from created_at and does not depend on which
                // host served the request. Re-minted on a unique-index collision below.
                // See [[friendly-order-number]]
                OrderNumber = OrderNumber.New(now),
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
                    throw UnknownProduct(line.ProductId);
                }

                if (product.UnitsInStock < line.Quantity)
                {
                    throw InsufficientStock(line, product.UnitsInStock);
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

            if (payment is not null)
            {
                // CONTRACT: The persisted total must be what was charged. Prices are re-read
                // under the lock, so a catalogue repricing between the two reads lands here.
                if (payment.AmountCents != total)
                {
                    throw new InvalidOperationException(
                        $"Order {order.Id} was charged {payment.AmountCents} cents but prices to {total}.");
                }

                order.ApplyPaymentSnapshot(payment);
            }

            _db.Orders.Add(order);

            // CONTRACT: Delete the cart INSIDE this transaction. Outside it, a rollback
            // (insufficient stock, a failed write) loses the buyer's selection AND the
            // order. Routed through CartWriteService so the three deletion paths cannot
            // drift apart; no-ops when the caller had no cart. See [[soft-delete]]
            await CartWriteService.DeleteForUserAsync(_db, cognitoSub, ct);

            await SaveWithOrderNumberRetryAsync(order, ct);
            // CONTRACT: The consumer has no access to this database, so everything the
            // receipt prints travels here — recipient, greeting, product names, and all four
            // money figures, which it must never derive from one another. The address is the
            // same serialization persisted above, not a third rendering.
            // See [[events-pipeline-design]]
            await _events.PublishOrderCreatedAsync(
                order.Id, order.OrderNumber, userId, caller.Email, caller.FullName,
                subtotal, tax, shippingCents, total,
                shippingAddressJson, eventItems, now, cognitoSub, ct);
            await tx.CommitAsync(ct);
            committed = true;

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
                order.Id, order.OrderNumber, shippingAddressJson, cognitoSub, testMode, e2eSource, ct);

            if (!trackingResult.IsTracked)
            {
                // CONTRACT: Never log the address here (PII). WARNING, not ERROR — the order
                // succeeded and returns 201; only a downstream side effect is degraded.
                // IsTracked (not `== Created`) is the predicate: a 409 is already tracked.
                _logger.LogWarning(
                    "Tracking initiation did not succeed for a created order {app_event} {reason} {order_id} {status_code}",
                    "init_tracking_failed", ReasonFor(trackingResult.Outcome), order.Id, trackingResult.StatusCode);
            }

            return ToDto(order);
        });
    }

    // CONTRACT: Keep this mapping in sync with OrderReadService.Map — it maps the in-memory
    // order rather than re-querying, so the two can silently diverge. It also renders a
    // replayed order, so the created and replayed bodies stay identical: UTC kind, lines in
    // the consolidated (ProductId) order.
    private OrderDto ToDto(Order order) => new(
        order.Id, OrderNumberDto.FromCanonical(order.OrderNumber), order.UserId, order.CognitoSub,
        Money.FromCents(order.SubtotalCents), Money.FromCents(order.TaxCents), Money.FromCents(order.ShippingCents), Money.FromCents(order.TotalCents),
        DateTime.SpecifyKind(order.CreatedAt, DateTimeKind.Utc),
        order.Details
            .OrderBy(d => d.ProductId, StringComparer.Ordinal)
            .Select(d => OrderLineMapper.Map(d, _assetsBaseUrl))
            .ToList());

    /// <summary>The order a (user, Idempotency-Key) pair already produced, with its lines.</summary>
    /// <remarks>
    /// CONTRACT: Ignores the soft-delete filter — the unique index covers deleted rows too, and a
    /// filtered read would miss the winner and refund the PaymentIntent that paid for it.
    /// </remarks>
    private Task<Order?> FindByIdempotencyKeyAsync(string userId, string clientKey, CancellationToken ct) =>
        _db.Orders
            .AsNoTracking()
            .IgnoreQueryFilters()
            .Include(o => o.Details)
            .FirstOrDefaultAsync(o => o.UserId == userId && o.IdempotencyKey == clientKey, ct);

    /// <summary>
    /// Replays <paramref name="existing"/>, or throws <see cref="IdempotencyKeyMismatchException"/>
    /// when its stored fingerprint differs from this request's. A row with none replays unchecked.
    /// </summary>
    private CreateOrderResult ReplayOrReject(Order existing, string? requestHash)
    {
        if (existing.IdempotencyRequestHash is not null && existing.IdempotencyRequestHash != requestHash)
        {
            KeyRejected("idempotency_key_mismatch", existing.Id);
            throw new IdempotencyKeyMismatchException();
        }

        return Replayed(existing);
    }

    // WHY: WARNING — the client broke the key contract; nothing here is a fault.
    private void KeyRejected(string reason, string orderId)
    {
        _logger.LogWarning(
            "Order creation failed: idempotency key rejected {app_event} {reason} {order_id}",
            "create_order_failed", reason, orderId);
        _tracer.SetReason(reason);
    }

    private const int InFlightRecheckAttempts = 3;

    private static readonly TimeSpan InFlightRecheckDelay = TimeSpan.FromMilliseconds(500);

    /// <summary>The order under (user, key), re-read while Stripe reports that key in flight.</summary>
    /// <remarks>
    /// CONTRACT: Bounded, about 1.5 s in all — an unbounded wait turns a winner that failed into
    /// a hung checkout. See [[2026-09-19-stripe-payments-design]]
    /// </remarks>
    private async Task<Order?> AwaitInFlightOrderAsync(string userId, string clientKey, CancellationToken ct)
    {
        for (var attempt = 0; attempt < InFlightRecheckAttempts; attempt++)
        {
            await Task.Delay(InFlightRecheckDelay, ct);
            if (await FindByIdempotencyKeyAsync(userId, clientKey, ct) is { } order)
            {
                return order;
            }
        }

        return null;
    }

    private CreateOrderResult Replayed(Order existing)
    {
        _logger.LogInformation(
            "Order already exists for this idempotency key {app_event} {order_id}",
            "create_order_replayed", existing.Id);
        _tracer.SetAttribute("app_event", "create_order_replayed");
        _tracer.SetAttribute("order_id", existing.Id);
        return new CreateOrderResult(ToDto(existing), Created: false);
    }

    /// <summary>
    /// The total to charge, priced exactly as the locked loop in the transaction prices it.
    /// </summary>
    /// <remarks>
    /// CONTRACT: Keep AsNoTracking. A tracked read here makes the later FOR UPDATE query hand
    /// back these cached entities with THIS read's stock, and concurrent orders oversell.
    /// Unknown products and short stock fail here, before anything is charged.
    /// See [[2026-09-19-stripe-payments-design]]
    /// </remarks>
    private async Task<long> PriceForChargeAsync(
        IReadOnlyList<CreateOrderLine> lines, decimal taxRate, long shippingCents, CancellationToken ct)
    {
        var ids = lines.Select(l => l.ProductId).ToList();
        var products = await _db.Products
            .AsNoTracking()
            .Where(p => ids.Contains(p.Id))
            .ToDictionaryAsync(p => p.Id, ct);

        var total = shippingCents;
        foreach (var line in lines)
        {
            if (!products.TryGetValue(line.ProductId, out var product))
            {
                throw UnknownProduct(line.ProductId);
            }

            if (product.UnitsInStock < line.Quantity)
            {
                throw InsufficientStock(line, product.UnitsInStock);
            }

            total += OrderPricing.PriceLine(product.UnitPriceCents, line.Quantity, taxRate).TotalCents;
        }

        return total;
    }

    private UnknownProductException UnknownProduct(string productId)
    {
        _logger.LogError(
            "Order creation failed: unknown product {app_event} {reason} {product_id}",
            "create_order_failed", "unknown_product", productId);
        _tracer.SetReason("unknown_product");
        return new UnknownProductException(productId);
    }

    private InsufficientStockException InsufficientStock(CreateOrderLine line, uint available)
    {
        _logger.LogError(
            "Order creation failed: insufficient stock {app_event} {reason} {product_id} {requested} {available}",
            "create_order_failed", "insufficient_stock", line.ProductId, line.Quantity, available);
        _tracer.SetReason("insufficient_stock");
        return new InsufficientStockException(line.ProductId);
    }

    /// <summary>
    /// Saves the order, re-minting its order number if the unique index rejects it.
    /// </summary>
    /// <remarks>
    /// CONTRACT: Detect by INDEX NAME (<see cref="OrderConfiguration.OrderNumberIndexName"/>),
    /// never the bare MySQL error number — that also fires on the order's other constraints,
    /// where re-minting hides a real bug.
    /// CONTRACT: Bounded, and the last failure RETHROWS. An unbounded loop holds FOR UPDATE on
    /// every product in the order and serializes the catalogue's checkout.
    /// See [[friendly-order-number]]
    /// </remarks>
    private async Task SaveWithOrderNumberRetryAsync(Order order, CancellationToken ct)
    {
        const int maxAttempts = 3;

        for (var attempt = 1; ; attempt++)
        {
            try
            {
                await _db.SaveChangesAsync(ct);
                return;
            }
            catch (DbUpdateException ex) when (IsOrderNumberCollision(ex) && attempt < maxAttempts)
            {
                // WHY: Log the ATTEMPT and the order id, never the colliding number — it is
                // the customer-facing label and has no business in the log stream, which
                // keys on order_id. See [[logging-context]]
                _logger.LogWarning(
                    "Order number collided; re-minting {app_event} {reason} {order_id} {attempt}",
                    "create_order_number_retried", "order_number_collision", order.Id, attempt);

                // CONTRACT: Re-mint from the SAME created_at, not from "now". A retry that
                // crossed UTC midnight would otherwise place the order on the following day.
                order.OrderNumber = OrderNumber.New(order.CreatedAt);
            }
        }
    }

    /// <summary>Whether this failure is the order-number unique index rejecting a duplicate.</summary>
    /// <remarks>
    /// WHY: Match on the index name anywhere in the exception chain — Pomelo surfaces the
    /// constraint name inside the inner MySqlException's message, and the outer
    /// DbUpdateException does not carry it.
    /// </remarks>
    private static bool IsOrderNumberCollision(DbUpdateException exception)
    {
        for (Exception? error = exception; error is not null; error = error.InnerException)
        {
            if (error.Message.Contains(
                    OrderConfiguration.OrderNumberIndexName,
                    StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
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
