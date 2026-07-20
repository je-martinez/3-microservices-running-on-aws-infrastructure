using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Orders.Application.Abstractions;
using Orders.Application.Identity;
using Orders.Application.Orders;
using Orders.Domain.Entities;
using Orders.Domain.Pricing;
using Orders.Infrastructure.Id;
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
    private readonly ILogger<CreateOrderService> _logger;

    public CreateOrderService(
        OrdersWriteDbContext db,
        IUserDirectory users,
        IEventPublisher events,
        IConfigurationReader config,
        ILogger<CreateOrderService> logger)
    {
        _db = db;
        _users = users;
        _events = events;
        _config = config;
        _logger = logger;
    }

    public async Task<OrderDto> CreateAsync(CreateOrderCommand command, string cognitoSub, CancellationToken ct = default)
    {
        _logger.LogInformation(
            "Starting order creation {app_event} {line_count}",
            "create_order_started", command.Lines.Count);

        // Failure branches are logged HERE, at the step that produces them: by
        // the time the endpoint maps the exception to a status code it is just
        // a typed error, and "the caller is unknown" versus "the product is out
        // of stock" are different operational problems. Each rethrows
        // untouched, so the 404/409 HTTP contract is unchanged.
        var userId = await _users.ResolveInternalUserIdAsync(cognitoSub, ct);
        if (userId is null)
        {
            _logger.LogError(
                "Order creation failed: the caller is not a known user {app_event} {reason}",
                "create_order_failed", "unknown_user");
            throw new UnknownUserException(cognitoSub);
        }

        // Tax rate is read per-request from the configuration table (not an env var).
        var taxRate = await _config.GetTaxRateAsync(ct);

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
                    throw new UnknownProductException(line.ProductId);
                }

                if (product.UnitsInStock < line.Quantity)
                {
                    _logger.LogError(
                        "Order creation failed: insufficient stock {app_event} {reason} {product_id} {requested} {available}",
                        "create_order_failed", "insufficient_stock", line.ProductId,
                        line.Quantity, product.UnitsInStock);
                    throw new InsufficientStockException(line.ProductId);
                }

                var (lineSub, lineTax, lineTotal) = OrderPricing.PriceLine(product.UnitPriceCents, line.Quantity, taxRate);
                subtotal += lineSub;
                tax += lineTax;
                total += lineTotal;

                product.UnitsInStock -= line.Quantity;
                product.UpdatedAt = now;

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
            order.TotalCents = total;

            _db.Orders.Add(order);
            await _db.SaveChangesAsync(ct);
            await _events.PublishOrderCreatedAsync(order.Id, userId, total, now, ct);
            await tx.CommitAsync(ct);

            // AFTER the commit: the order genuinely exists at this point, so the
            // success line never claims something a rollback later undid.
            _logger.LogInformation(
                "Order creation completed {app_event} {order_id} {line_count} {total_cents}",
                "create_order_succeeded", order.Id, order.Details.Count, total);

            // Map the in-memory order (order.Details already populated) instead of
            // re-querying — mirrors OrderReadService.Map exactly; keep both in sync.
            return new OrderDto(
                order.Id, order.UserId, order.CognitoSub, order.SubtotalCents, order.TaxCents, order.TotalCents, order.CreatedAt,
                order.Details.Select(d => new OrderLineDto(d.ProductId, d.Quantity, d.SubtotalCents, d.TaxCents, d.TotalCents)).ToList());
        });
    }
}
