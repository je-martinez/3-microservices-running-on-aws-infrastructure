using Orders.Api.Identity;
using Orders.Application.Abstractions;
using Orders.Application.Orders;
using Orders.Infrastructure.Orders;

namespace Orders.Api.Endpoints;

public record CreateOrderRequest(IReadOnlyList<CreateOrderLine> Lines);

public static class CreateOrderEndpoint
{
    // POST /v1/orders: 401 no x-user-id (enforced by CallerContextMiddleware
    // before this handler runs), 404 unknown user, 409 insufficient stock, 201
    // Created with the new ord_ id on success.
    public static async Task<IResult> Handle(ICurrentCaller caller, CreateOrderRequest body, CreateOrderService service)
    {
        try
        {
            var sub = caller.CognitoSub!; // guaranteed non-null past the middleware
            var orderId = await service.CreateAsync(new CreateOrderCommand(body.Lines), sub);
            return Results.Created($"/v1/orders/{orderId}", new { id = orderId });
        }
        catch (UnknownUserException)
        {
            return Results.NotFound(new { error = "unknown_user" });
        }
        catch (UnknownProductException ex)
        {
            return Results.NotFound(new { error = "unknown_product", detail = ex.Message });
        }
        catch (InsufficientStockException ex)
        {
            return Results.Conflict(new { error = "insufficient_stock", detail = ex.Message });
        }
    }
}
