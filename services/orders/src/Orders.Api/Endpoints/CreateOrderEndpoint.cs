using Orders.Api.Identity;
using Orders.Application.Abstractions;
using Orders.Application.Orders;
using Orders.Application.Payments;
using Orders.Domain.Payments;
using Orders.Infrastructure.Orders;
using Orders.Infrastructure.Persistence.Configurations;

namespace Orders.Api.Endpoints;

/// <param name="Lines">The order lines; at least one.</param>
/// <param name="PaymentMethodId">The saved <c>pm_</c> to charge; required only with Stripe on.</param>
/// <param name="Card">Optional plain-checkout card metadata; validated only with Stripe off.</param>
public record CreateOrderRequest(
    IReadOnlyList<CreateOrderLine> Lines,
    string? PaymentMethodId = null,
    CardMetadataRequest? Card = null);

/// <summary>
/// Card metadata from the plain checkout.
/// CONTRACT: Never add the card number or the CVC — they never leave the browser.
/// See [[2026-09-19-stripe-payments-design]]
/// </summary>
public record CardMetadataRequest(string? Brand, string? Last4, int? ExpMonth, int? ExpYear);

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

    // POST /v1/orders: 201 Created with the full OrderDto, or 200 with the order an
    // Idempotency-Key already produced. 400 malformed body or key, 401 no x-user-id (enforced
    // by CallerContextMiddleware), 402 payment declined, 404 unknown user/product, 409
    // insufficient stock or a refunded key, 422 key reused with another body, 503 payments
    // unavailable (with Retry-After: 1 while the same key is in flight). 200, 402, 422 and 503
    // only occur with STRIPE_ENABLED on.
    public static async Task<IResult> Handle(
        ICurrentCaller caller,
        CreateOrderRequest body,
        CreateOrderService service,
        HttpContext http,
        IConfiguration config,
        StripeSettings stripe,
        [Microsoft.AspNetCore.Mvc.FromHeader(Name = "Idempotency-Key")] string? idempotencyKey = null)
    {
        // CONTRACT: Validate the body BEFORE anything else. The non-nullable annotation on
        // `Lines` is compile-time only, so a client posting `items` instead of `lines` binds
        // null and gets an opaque 500 for its own mistake. Reject an EMPTY list too: it is
        // well-formed JSON that would otherwise open a write transaction and a gRPC lookup
        // to commit an order with no lines. The 400 is declared in OrderEndpoints' .Produces
        // so openapi.yaml documents it.
        if (body?.Lines is null || body.Lines.Count == 0)
        {
            return Results.BadRequest(new
            {
                error = "invalid_request",
                detail = "The 'lines' array is required and must contain at least one line.",
            });
        }

        if (stripe.Enabled && string.IsNullOrWhiteSpace(body.PaymentMethodId))
        {
            return Results.BadRequest(new
            {
                error = "invalid_request",
                detail = "The 'paymentMethodId' field is required.",
            });
        }

        if (stripe.Enabled && !IsValidIdempotencyKey(idempotencyKey))
        {
            return Results.BadRequest(new
            {
                error = "idempotency_key_required",
                detail = "An 'Idempotency-Key' header of 1-64 printable ASCII characters is required.",
            });
        }

        if (!stripe.Enabled
            && body.Card is { } card
            && !CardMetadataValidator.IsValid(
                card.Brand, card.Last4, card.ExpMonth, card.ExpYear, DateOnly.FromDateTime(DateTime.UtcNow)))
        {
            return Results.BadRequest(new
            {
                error = "invalid_request",
                detail = "The 'card' needs a known brand, a 4-digit last4, and an expiry that has not passed.",
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

            var command = new CreateOrderCommand(
                body.Lines,
                stripe.Enabled ? body.PaymentMethodId : null,
                stripe.Enabled ? idempotencyKey : null);
            var result = await service.CreateOrReplayAsync(command, sub, testMode, e2eSource);
            return result.Created
                ? Results.Created($"/v1/orders/{result.Order.Id}", result.Order)
                : Results.Ok(result.Order);
        }
        catch (IdempotencyKeyReusedException ex)
        {
            return Results.Conflict(new { error = "idempotency_key_reused", detail = ex.Message });
        }
        catch (IdempotencyKeyMismatchException ex)
        {
            return Results.UnprocessableEntity(new { error = "idempotency_key_mismatch", detail = ex.Message });
        }
        catch (PaymentDeclinedException ex)
        {
            // WHY: A decline is the buyer's to fix, not a server fault — the frontend reads
            // `code` to ask for another card. No order row exists on this path.
            return Results.Json(
                new { error = "payment_declined", detail = ex.Message, code = ex.Code },
                statusCode: StatusCodes.Status402PaymentRequired);
        }
        catch (IdempotencyKeyInFlightException ex)
        {
            http.Response.Headers.RetryAfter = "1";
            return Results.Json(
                new { error = "payment_unavailable", detail = ex.Message },
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }
        catch (PaymentUnavailableException ex)
        {
            return Results.Json(
                new { error = "payment_unavailable", detail = ex.Message },
                statusCode: StatusCodes.Status503ServiceUnavailable);
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

    // CONTRACT: 1-64 printable ASCII characters. The key is part of the Stripe idempotency key
    // and a varchar(64) column, so a longer or non-ASCII value must never reach either.
    private static bool IsValidIdempotencyKey(string? key) =>
        key is { Length: > 0 and <= OrderConfiguration.IdempotencyKeyMaxLength }
        && key.All(c => c is >= '!' and <= '~');
}
