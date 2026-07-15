using Orders.Api.Identity;
using Orders.Application.Orders;
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
            .Produces(StatusCodes.Status201Created)
            .Produces(StatusCodes.Status401Unauthorized)
            .Produces(StatusCodes.Status404NotFound)
            .Produces(StatusCodes.Status409Conflict);

        group.MapGet("/my-orders", async (HttpContext ctx, OrderReadService reads) =>
        {
            var sub = CallerIdentity.CognitoSub(ctx);
            if (sub is null) return Results.Unauthorized();
            return Results.Ok(await reads.GetMyOrdersAsync(sub));
        })
            .WithName("GetMyOrders")
            .WithSummary("List the caller's orders (ownership by cognito_sub).")
            .Produces<IReadOnlyList<OrderDto>>(StatusCodes.Status200OK)
            .Produces(StatusCodes.Status401Unauthorized);

        group.MapGet("/{orderId}", async (string orderId, HttpContext ctx, OrderReadService reads) =>
        {
            var sub = CallerIdentity.CognitoSub(ctx);
            if (sub is null) return Results.Unauthorized();
            var order = await reads.GetByIdAsync(orderId, sub);
            return order is null ? Results.NotFound() : Results.Ok(order);
        })
            .WithName("GetOrderById")
            .WithSummary("Get one of the caller's orders by id; another user's order returns 404.")
            .Produces<OrderDto>(StatusCodes.Status200OK)
            .Produces(StatusCodes.Status401Unauthorized)
            .Produces(StatusCodes.Status404NotFound);

        app.MapGet("/v1/health", () => Results.Ok(new { status = "ok" }))
            .WithTags("Orders")
            .WithName("Health")
            .WithSummary("Liveness probe.")
            .Produces(StatusCodes.Status200OK);
    }
}
