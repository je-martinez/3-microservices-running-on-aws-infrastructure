using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Orders.Application.Orders;
using Orders.Domain;
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
    private readonly ILogger<OrderReadService> _logger;

    public OrderReadService(OrdersReadDbContext db, IWorkflowTracer tracer, ILogger<OrderReadService> logger)
    {
        _db = db;
        _tracer = tracer;
        _logger = logger;
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
                // Set from inside so it reflects what was actually returned.
                _tracer.SetAttribute("order_count", dtos.Count);

                // ONE line, and only a _succeeded one — no _started twin. This is
                // a read, not create_order: the convention reserves the full
                // started/succeeded/failed triad for flows with real diagnostic
                // value, and doubling the volume of the most frequent route in the
                // service buys nothing here. A single SELECT has no intermediate
                // step at which a _started line could be the last thing seen, so
                // _started would only ever be the line immediately above its own
                // _succeeded.
                //
                // Nor is there a _failed branch to write: this method has no
                // failure of its own to name. A DB fault throws straight out of
                // TraceWorkflowAsync, which already records the exception on the
                // span and sets ERROR status, and the request log already reports
                // it as a 500. A catch here would have to invent a `reason` for a
                // branch the code does not have — the convention asks for one
                // reason per failure mode that actually exists, not a speculative
                // list.
                //
                // What the line does buy is that the span stops being mute: it is
                // emitted INSIDE TraceWorkflowAsync's activity, so it carries this
                // span's own span_id, and a span-scoped log lookup in OpenObserve
                // resolves to it. The `request completed` line cannot serve that
                // purpose — it is written by the outermost middleware under the
                // AspNetCore server span, i.e. a different span_id.
                //
                // order_count only. No cognito_sub or user_id at the call site:
                // both already ride on every line via LogContextEnricher, and
                // re-passing them here is how a PII field ends up duplicated in a
                // place nobody audits.
                _logger.LogInformation(
                    "Listed the caller's orders {app_event} {order_count}",
                    "list_my_orders_succeeded", dtos.Count);
                return (IReadOnlyList<OrderDto>)dtos;
            });

    private static OrderDto Map(Domain.Entities.Order o) => new(
        o.Id, o.UserId, o.CognitoSub,
        Money.FromCents(o.SubtotalCents), Money.FromCents(o.TaxCents), Money.FromCents(o.ShippingCents), Money.FromCents(o.TotalCents),
        o.CreatedAt,
        o.Details.Select(d => new OrderLineDto(
            d.ProductId, d.Quantity,
            Money.FromCents(d.SubtotalCents), Money.FromCents(d.TaxCents), Money.FromCents(d.TotalCents)))
            .ToList());
}
