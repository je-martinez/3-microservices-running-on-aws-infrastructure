using Microsoft.EntityFrameworkCore;
using Orders.Application.Orders;
using Orders.Infrastructure.Persistence;

namespace Orders.Infrastructure.Orders;

// Ownership is enforced IN the query (WHERE cognito_sub = caller). Another user's
// order returns nothing → the API maps that to 404. No gRPC on reads.
//
// Lives in Infrastructure because it depends on OrdersReadDbContext; the plan
// placed it under Orders.Application, but Application must not reference
// Infrastructure/EF Core (that would invert the Clean Architecture dependency
// direction and create a circular project reference). OrderDto stays in
// Application as a pure record; the Api wires this concrete service.
public class OrderReadService
{
    private readonly OrdersReadDbContext _db;
    public OrderReadService(OrdersReadDbContext db) => _db = db;

    public async Task<OrderDto?> GetByIdAsync(string orderId, string callerSub)
    {
        var order = await _db.Orders.AsNoTracking()
            .Include(o => o.Details)
            .FirstOrDefaultAsync(o => o.Id == orderId && o.CognitoSub == callerSub);
        return order is null ? null : Map(order);
    }

    public async Task<IReadOnlyList<OrderDto>> GetMyOrdersAsync(string callerSub)
    {
        var orders = await _db.Orders.AsNoTracking()
            .Include(o => o.Details)
            .Where(o => o.CognitoSub == callerSub)
            .ToListAsync();
        return orders.Select(Map).ToList();
    }

    private static OrderDto Map(Domain.Entities.Order o) => new(
        o.Id, o.UserId, o.CognitoSub, o.SubtotalCents, o.TaxCents, o.TotalCents, o.CreatedAt,
        o.Details.Select(d => new OrderLineDto(d.ProductId, d.Quantity, d.SubtotalCents, d.TaxCents, d.TotalCents)).ToList());
}
