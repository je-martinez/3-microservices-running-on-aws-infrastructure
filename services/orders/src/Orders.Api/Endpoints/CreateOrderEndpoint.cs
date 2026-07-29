using Orders.Api.Identity;
using Orders.Application.Abstractions;
using Orders.Application.Orders;
using Orders.Infrastructure.Orders;

namespace Orders.Api.Endpoints;

public record CreateOrderRequest(IReadOnlyList<CreateOrderLine> Lines);

public static class CreateOrderEndpoint
{
    // The header that opts an order's tracking into TestMode. Only the exact
    // lowercase string "true" activates it: the value is a wire contract shared
    // with Tracking, not free-form input, and a case-insensitive match would
    // quietly accept "True" here while the same value means nothing elsewhere.
    private const string TestModeHeader = "x-test-mode";

    // POST /v1/orders: 401 no x-user-id (enforced by CallerContextMiddleware
    // before this handler runs), 404 unknown user, 409 insufficient stock, 201
    // Created with the full OrderDto on success.
    public static async Task<IResult> Handle(
        ICurrentCaller caller,
        CreateOrderRequest body,
        CreateOrderService service,
        HttpContext http,
        IConfiguration config)
    {
        try
        {
            var sub = caller.CognitoSub!; // guaranteed non-null past the middleware

            // Guarded by E2E_TESTING_ENABLED, the same flag gating the e2e-cleanup
            // route, so production ignores the header outright rather than trusting
            // a client not to send it. With the flag off this is always false.
            var testMode = config.GetValue<bool>("E2E_TESTING_ENABLED")
                && http.Request.Headers[TestModeHeader] == "true";

            var dto = await service.CreateAsync(new CreateOrderCommand(body.Lines), sub, testMode);
            return Results.Created($"/v1/orders/{dto.Id}", dto);
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
