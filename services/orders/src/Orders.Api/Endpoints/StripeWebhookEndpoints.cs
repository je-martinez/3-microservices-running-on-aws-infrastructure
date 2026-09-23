using System.Text;
using Microsoft.AspNetCore.Mvc;
using Microsoft.OpenApi;
using Orders.Infrastructure.Payments;

namespace Orders.Api.Endpoints;

/// <summary>
/// Stripe's payment-reconciliation webhook. Mapped only with <c>STRIPE_ENABLED</c>.
/// </summary>
/// <remarks>
/// CONTRACT: PUBLIC — Stripe has no Cognito JWT and sends no x-user-id. The
/// <c>Stripe-Signature</c> header, verified against the raw body before any dispatch, is the
/// only guard. See [[2026-09-19-stripe-payments-design]]
/// </remarks>
public static class StripeWebhookEndpoints
{
    public const string Route = "/v1/orders/stripe/webhook";

    private const string SignatureHeader = "Stripe-Signature";

    public static void MapStripeWebhookEndpoints(this WebApplication app)
    {
        app.MapPost(Route, async (
            HttpRequest request,
            [FromHeader(Name = SignatureHeader)] string? signature,
            StripeWebhookService webhooks,
            CancellationToken ct) =>
        {
            // CONTRACT: Read the body as a raw string and NEVER bind it to a model — the
            // signature covers the exact bytes, and a re-serialized body never verifies.
            using var reader = new StreamReader(request.Body, Encoding.UTF8);
            var rawBody = await reader.ReadToEndAsync(ct);

            return await webhooks.HandleAsync(rawBody, signature, ct) switch
            {
                StripeWebhookOutcome.Acknowledged => Results.Ok(new StripeWebhookResponse(Received: true)),
                StripeWebhookOutcome.InvalidSignature => Results.BadRequest(new { error = "invalid_signature" }),
                StripeWebhookOutcome.OrderNotYetCommitted => Results.Conflict(new { error = "order_not_committed" }),
                StripeWebhookOutcome.RefundFailed => Results.Json(
                    new { error = "refund_failed" }, statusCode: StatusCodes.Status503ServiceUnavailable),
                _ => Results.Json(
                    new { error = "stripe_unavailable" }, statusCode: StatusCodes.Status503ServiceUnavailable),
            };
        })
            .WithTags("webhooks")
            .WithName("StripeWebhook")
            .WithSummary("Stripe payment-reconciliation webhook: orphan charges, refunds and disputes (only mapped when STRIPE_ENABLED).")
            .AddOpenApiOperationTransformer((operation, _, _) =>
            {
                foreach (var parameter in operation.Parameters?.OfType<OpenApiParameter>() ?? [])
                {
                    if (parameter.Name == SignatureHeader)
                    {
                        parameter.Required = true;
                        parameter.Description = "HMAC signature Stripe computes over the raw request body.";
                    }
                }

                return Task.CompletedTask;
            })
            .Produces<StripeWebhookResponse>(StatusCodes.Status200OK)
            .Produces(StatusCodes.Status400BadRequest)
            .Produces(StatusCodes.Status409Conflict)
            .Produces(StatusCodes.Status503ServiceUnavailable);
    }
}

/// <summary>The acknowledgement Stripe receives for a handled or ignored event.</summary>
public record StripeWebhookResponse(bool Received);
