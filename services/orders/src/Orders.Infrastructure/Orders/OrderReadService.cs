using Microsoft.EntityFrameworkCore;
using Orders.Application.Orders;
using Orders.Infrastructure.Observability;
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
    private readonly IWorkflowTracer _tracer;

    public OrderReadService(OrdersReadDbContext db, IWorkflowTracer tracer)
    {
        _db = db;
        _tracer = tracer;
    }

    public async Task<OrderDto?> GetByIdAsync(string orderId, string callerSub)
    {
        var order = await _db.Orders.AsNoTracking()
            .Include(o => o.Details)
            .FirstOrDefaultAsync(o => o.Id == orderId && o.CognitoSub == callerSub);
        return order is null ? null : Map(order);
    }

    // Wrapped in the list_my_orders workflow span. Deliberately carries NO
    // http.method / route tags: the AspNetCore span above it already says the
    // request was GET /v1/orders/my-orders, and the EF Core spans below it
    // already say what SQL ran. What neither of them says is the business name
    // of the flow and how many orders it answered with, so that is all this
    // adds. No caller identity in tags either — cognito_sub is PII-adjacent and
    // already rides on every log line via the shared log context.
    public async Task<IReadOnlyList<OrderDto>> GetMyOrdersAsync(string callerSub) =>
        await _tracer.TraceWorkflowAsync(
            "list_my_orders",
            new Dictionary<string, object?>(),
            async () =>
            {
                var orders = await _db.Orders.AsNoTracking()
                    .Include(o => o.Details)
                    .Where(o => o.CognitoSub == callerSub)
                    .ToListAsync();

                var dtos = orders.Select(Map).ToList();
                // Set from inside so it reflects what was actually returned; a
                // read has no *_succeeded flow log to mirror, so the count is
                // the one business fact worth attaching.
                _tracer.SetAttribute("order_count", dtos.Count);
                return (IReadOnlyList<OrderDto>)dtos;
            });

    private static OrderDto Map(Domain.Entities.Order o) => new(
        o.Id, o.UserId, o.CognitoSub, o.SubtotalCents, o.TaxCents, o.ShippingCents, o.TotalCents, o.CreatedAt,
        o.Details.Select(d => new OrderLineDto(d.ProductId, d.Quantity, d.SubtotalCents, d.TaxCents, d.TotalCents)).ToList());
}
