using Microsoft.EntityFrameworkCore;
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

    public CreateOrderService(OrdersWriteDbContext db, IUserDirectory users, IEventPublisher events, IConfigurationReader config)
    {
        _db = db;
        _users = users;
        _events = events;
        _config = config;
    }

    public async Task<string> CreateAsync(CreateOrderCommand command, string cognitoSub, CancellationToken ct = default)
    {
        var userId = await _users.ResolveInternalUserIdAsync(cognitoSub, ct)
            ?? throw new UnknownUserException(cognitoSub);

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

            foreach (var line in command.Lines)
            {
                // Pessimistic lock so concurrent orders cannot oversell. FromSqlInterpolated
                // parameterizes {line.ProductId} (no SQL injection). FOR UPDATE needs the
                // open transaction above (InnoDB).
                //
                // Raw SQL bypasses EF Core's global query filter, so the soft-delete
                // predicate (deleted_at IS NULL) MUST be applied explicitly here (ADR-0004);
                // otherwise a soft-deleted product could be locked, read, and sold. When the
                // product is soft-deleted this returns null → treated as unorderable via the
                // InsufficientStockException below (the product effectively no longer exists).
                var product = await _db.Products
                    .FromSqlInterpolated($"SELECT * FROM product WHERE id = {line.ProductId} AND deleted_at IS NULL FOR UPDATE")
                    .FirstOrDefaultAsync(ct)
                    ?? throw new InsufficientStockException(line.ProductId);

                if (product.UnitsInStock < line.Quantity)
                    throw new InsufficientStockException(line.ProductId);

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

            return order.Id;
        });
    }
}
