using Orders.Api.Caching;
using Orders.Api.Identity;
using Orders.Application.Orders;
using Orders.Application.Tracking;
using Orders.Infrastructure.Caching;
using Orders.Infrastructure.Orders;

namespace Orders.Api.Endpoints;

public static class OrderEndpoints
{
    public static void MapOrderEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/v1/orders").WithTags("Orders");

        group.MapPost("", CreateOrderEndpoint.Handle)
            .WithName("CreateOrder")
            .WithSummary("Create an order for the caller, decrementing product stock.")
            .Accepts<CreateOrderRequest>("application/json")
            .Produces<OrderDto>(StatusCodes.Status201Created)
            .Produces(StatusCodes.Status400BadRequest)
            .Produces(StatusCodes.Status401Unauthorized)
            .Produces(StatusCodes.Status404NotFound)
            .Produces(StatusCodes.Status409Conflict);

        group.MapGet("/my-orders", async (
            ICurrentCaller caller,
            OrderReadService reads,
            ITrackingReader trackingReader,
            bool includeTracking = false,
            CancellationToken ct = default) =>
        {
            // x-user-id absence already 401'd by CallerContextMiddleware.
            var orders = await reads.GetMyOrdersAsync(caller.CognitoSub!);

            // Default false keeps this response byte-identical to what every existing
            // caller already receives — no tracking key, no extra round trip.
            if (!includeTracking)
            {
                return Results.Ok(orders);
            }

            // ONE batch call for N orders. Tracking's csv-shaped read exists so a list
            // does not fan out into a call per order.
            var trackings = await trackingReader.GetTrackingsAsync(
                orders.Select(o => o.Id).ToArray(), caller.CognitoSub!, ct);

            return Results.Ok(orders
                .Select(o => new OrderWithTrackingDto(
                    o, trackings.GetValueOrDefault(o.Id)))
                .ToArray());
        })
            .WithName("GetMyOrders")
            .WithSummary("List the caller's orders (ownership by cognito_sub); optionally with each order's tracking.")
            // Two shapes behind one route: a bare OrderDto list by default, and the
            // wrapped form when includeTracking=true. OpenAPI cannot express "this
            // status returns either of two schemas" cleanly, so the wrapped shape is
            // declared — it is the one a reader needs the schema for, and the bare one
            // is OrderDto, already documented on the sibling route.
            .Produces<IReadOnlyList<OrderWithTrackingDto>>(StatusCodes.Status200OK)
            .Produces(StatusCodes.Status401Unauthorized)
            // No type argument — CachedReadFilter is non-generic, and THIS route is why.
            // It returns two shapes behind one URL: Ok<IReadOnlyList<OrderDto>> when
            // includeTracking is false and Ok<OrderWithTrackingDto[]> when it is true. A
            // generic filter could not have matched both, and could not have matched
            // either via <object>: IValueHttpResult<T> is not covariant in T, so the
            // object variant matches neither concrete result type and the route would
            // silently never cache — no error, no header, a permanent MISS.
            //
            // What keeps the two shapes in SEPARATE entries is the KEY, not the filter:
            // CacheKeys.MyOrders' t0/t1 segment, driven by UserCacheKeyBuilders reading
            // the query string.
            //
            // The t1 variant additionally declines to store a list in which ANY order is
            // still missing its tracking: tracking is created after the order commits, so
            // a null there is a momentary absence, not a fact worth freezing for 2
            // minutes. See TrackingCacheRules.AllOrdersHaveTracking for why "every"
            // rather than "any". The t0 variant is unaffected — its value is not an
            // OrderWithTrackingDto, so the predicate passes it straight through.
            .WithCache(
                UserCacheKeyBuilders.MyOrders,
                CacheKeys.OrdersTtl,
                TrackingCacheRules.AllOrdersHaveTracking);

        group.MapGet("/{orderId}", async (
            string orderId,
            ICurrentCaller caller,
            OrderReadService reads,
            ITrackingReader trackingReader,
            bool includeTracking = false,
            CancellationToken ct = default) =>
        {
            var order = await reads.GetByIdAsync(orderId, caller.CognitoSub!);
            if (order is null)
            {
                return Results.NotFound();
            }

            if (!includeTracking)
            {
                return Results.Ok(order);
            }

            var trackings = await trackingReader.GetTrackingsAsync(
                new[] { order.Id }, caller.CognitoSub!, ct);

            return Results.Ok(new OrderWithTrackingDto(
                order, trackings.GetValueOrDefault(order.Id)));
        })
            .WithName("GetOrderById")
            .WithSummary("Get one of the caller's orders by id; another user's order returns 404. Optionally includes its tracking.")
            // As on my-orders: the wrapped shape is declared because it is the one
            // carrying a schema a reader cannot guess.
            .Produces<OrderWithTrackingDto>(StatusCodes.Status200OK)
            .Produces(StatusCodes.Status401Unauthorized)
            .Produces(StatusCodes.Status404NotFound)
            // Same two-shapes reason as my-orders above, and the same non-generic filter
            // handles it. The 404 branch needs no special handling: the filter requires
            // IStatusCodeHttpResult { StatusCode: 200 } before it stores anything, so
            // "no such order" is re-evaluated on every request rather than cached —
            // which is what you want, since a 404 is also what another user's order
            // returns, and what a not-yet-visible order returns.
            //
            // And, as on my-orders, a t1 response whose tracking has not appeared yet is
            // served but NOT stored — the same reasoning CachedUserDirectory applies to a
            // null identity resolution.
            .WithCache(
                UserCacheKeyBuilders.OrderById,
                CacheKeys.OrdersTtl,
                TrackingCacheRules.SingleOrderHasTracking);

        // Tagged "health", not "Orders": it is mapped here only because this is
        // where the top-level routes live, but it is not an order operation — it
        // is the ALB/Fargate liveness probe, unauthenticated, and it files under
        // its own tag in the spec exactly as it does in Users and Tracking.
        app.MapGet("/v1/health", () => Results.Ok(new { status = "ok" }))
            .WithTags("health")
            .WithName("Health")
            .WithSummary("Liveness probe.")
            .Produces(StatusCodes.Status200OK);
    }
}
