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

    // The header that marks an order as produced by an end-to-end test run, so
    // e2e-cleanup can find it by tag. Same exact-"true" wire contract as the header
    // above, and shared with Users and Tracking.
    private const string E2eSourceHeader = "x-e2e-source";

    // POST /v1/orders: 400 malformed body, 401 no x-user-id (enforced by
    // CallerContextMiddleware before this handler runs), 404 unknown user, 409
    // insufficient stock, 201 Created with the full OrderDto on success.
    public static async Task<IResult> Handle(
        ICurrentCaller caller,
        CreateOrderRequest body,
        CreateOrderService service,
        HttpContext http,
        IConfiguration config)
    {
        // Validate the body BEFORE anything else runs. `Lines` is declared as a
        // non-nullable IReadOnlyList, but that is a compile-time annotation only —
        // System.Text.Json does not enforce it, so a body that omits the key (or
        // spells it wrong, or sends an explicit null) binds it to null and every
        // nullable-reference warning stays silent.
        //
        // Without this guard the first use downstream was `command.Lines.Count` in
        // CreateOrderService, which threw NullReferenceException out of the handler
        // and became a 500. That is the wrong answer twice over: it reports a server
        // fault for what is entirely a caller mistake, and it gives the caller
        // nothing to act on. It is also how the bug surfaced — a client posting
        // `items` instead of `lines` got an opaque 500.
        //
        // An EMPTY list is rejected here too, and deliberately: it is well-formed
        // JSON, so it would sail past this method and open a write transaction plus
        // a gRPC caller lookup only to commit an order with no lines and a zero
        // total. An order with nothing in it is not a request this service should
        // satisfy.
        //
        // 400 is NOT in the group's .Produces list by accident — OrderEndpoints.cs
        // declares it alongside the others, so the generated openapi.yaml documents
        // it (see CLAUDE.md §2a: a route's declared statuses must match what the
        // handler really returns).
        if (body?.Lines is null || body.Lines.Count == 0)
        {
            return Results.BadRequest(new
            {
                error = "invalid_request",
                detail = "The 'lines' array is required and must contain at least one line.",
            });
        }

        try
        {
            var sub = caller.CognitoSub!; // guaranteed non-null past the middleware

            // Guarded by E2E_TESTING_ENABLED, the same flag gating the e2e-cleanup
            // route, so production ignores the header outright rather than trusting
            // a client not to send it. With the flag off this is always false.
            var e2eTestingEnabled = config.GetValue<bool>("E2E_TESTING_ENABLED");

            var testMode = e2eTestingEnabled
                && http.Request.Headers[TestModeHeader] == "true";

            // Same double condition, and it is a security guard rather than a
            // convenience: without the flag a client could tag its own orders in
            // production and hand itself rows that e2e-cleanup would then delete.
            var e2eSource = e2eTestingEnabled
                && http.Request.Headers[E2eSourceHeader] == "true";

            var dto = await service.CreateAsync(new CreateOrderCommand(body.Lines), sub, testMode, e2eSource);
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
