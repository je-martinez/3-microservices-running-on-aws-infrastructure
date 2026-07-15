using Orders.Api.Identity;
using Orders.Infrastructure.Orders;

namespace Orders.Api.Endpoints;

public static class OrderEndpoints
{
    public static void MapOrderEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/v1/orders");

        group.MapPost("", CreateOrderEndpoint.Handle);

        group.MapGet("/my-orders", async (HttpContext ctx, OrderReadService reads) =>
        {
            var sub = CallerIdentity.CognitoSub(ctx);
            if (sub is null) return Results.Unauthorized();
            return Results.Ok(await reads.GetMyOrdersAsync(sub));
        });

        group.MapGet("/{orderId}", async (string orderId, HttpContext ctx, OrderReadService reads) =>
        {
            var sub = CallerIdentity.CognitoSub(ctx);
            if (sub is null) return Results.Unauthorized();
            var order = await reads.GetByIdAsync(orderId, sub);
            return order is null ? Results.NotFound() : Results.Ok(order);
        });

        app.MapGet("/v1/health", () => Results.Ok(new { status = "ok" }));
    }
}
