using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Orders.Application.Orders;
using Orders.Domain;
using Orders.Infrastructure.Observability;
using Orders.Infrastructure.Persistence;

namespace Orders.Infrastructure.Orders;

// CONTRACT: Enforce ownership IN the query (WHERE cognito_sub = caller). Another user's
// order returns nothing, which the API maps to 404.
public class OrderReadService
{
    private readonly OrdersReadDbContext _db;
    private readonly IWorkflowTracer _tracer;
    private readonly string _assetsBaseUrl;
    private readonly ILogger<OrderReadService> _logger;

    /// <param name="assetsBaseUrl">
    /// Assets base URL for composing line image URLs from the bucket-relative key stored
    /// on the row. A trailing slash is tolerated. See ProductReadService.
    /// </param>
    public OrderReadService(
        OrdersReadDbContext db,
        IWorkflowTracer tracer,
        string assetsBaseUrl,
        ILogger<OrderReadService> logger)
    {
        _db = db;
        _tracer = tracer;
        _assetsBaseUrl = assetsBaseUrl.TrimEnd('/');
        _logger = logger;
    }

    public async Task<OrderDto?> GetByIdAsync(string orderId, string callerSub)
    {
        var order = await _db.Orders.AsNoTracking()
            .Include(o => o.Details)
            .FirstOrDefaultAsync(o => o.Id == orderId && o.CognitoSub == callerSub);
        return order is null ? null : Map(order);
    }

    // CONTRACT: No http.method/route tags — the AspNetCore span above and the EF Core spans
    // below already carry those; this adds only the flow's business name and its count. No
    // caller identity either: it is PII-adjacent and already on every log line.
    // See [[logging-context]]
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
                // WHY: Set from inside, so it reflects what was actually returned.
                _tracer.SetAttribute("order_count", dtos.Count);

                // CONTRACT: One _succeeded line, no _started twin and no _failed branch — a
                // single SELECT has no intermediate step, and a DB fault throws out of
                // TraceWorkflowAsync, which already records it. Emit it INSIDE the activity
                // so it carries this span's span_id; the outer `request completed` line runs
                // under the AspNetCore span. Pass order_count only — LogContextEnricher
                // already puts the identity on every line. See [[logging-context]]
                _logger.LogInformation(
                    "Listed the caller's orders {app_event} {order_count}",
                    "list_my_orders_succeeded", dtos.Count);
                return (IReadOnlyList<OrderDto>)dtos;
            });

    private OrderDto Map(Domain.Entities.Order o) => new(
        o.Id, o.UserId, o.CognitoSub,
        Money.FromCents(o.SubtotalCents), Money.FromCents(o.TaxCents), Money.FromCents(o.ShippingCents), Money.FromCents(o.TotalCents),
        o.CreatedAt,
        o.Details.Select(d => OrderLineMapper.Map(d, _assetsBaseUrl)).ToList());
}
