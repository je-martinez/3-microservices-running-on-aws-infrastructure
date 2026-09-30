using System.Diagnostics;
using System.Text;
using Microsoft.AspNetCore.Mvc;
using Microsoft.OpenApi;
using Orders.Api.Payments;
using Orders.Infrastructure.Payments;

namespace Orders.Api.Endpoints;

/// <summary>
/// Stripe's payment-reconciliation webhook. Mapped only with <c>STRIPE_ENABLED</c>.
/// </summary>
/// <remarks>
/// CONTRACT: PUBLIC — Stripe has no Cognito JWT and sends no x-user-id. Three guards run in
/// order, all before the body is read: source-IP allowlist, URL token, then the
/// <c>Stripe-Signature</c> over the raw body. See [[2026-09-19-stripe-payments-design]]
/// </remarks>
public static class StripeWebhookEndpoints
{
    public const string RoutePrefix = "/v1/orders/stripe/webhook";

    public const string Route = RoutePrefix + "/{token}";

    private const string SignatureHeader = "Stripe-Signature";

    public static void MapStripeWebhookEndpoints(this WebApplication app)
    {
        app.MapPost(Route, async (
            HttpRequest request,
            string token,
            [FromHeader(Name = SignatureHeader)] string? signature,
            StripeWebhookAccess access,
            StripeWebhookService webhooks,
            ILogger<StripeWebhookAccess> logger,
            CancellationToken ct) =>
        {
            if (!access.AllowlistConfigured)
            {
                return Unavailable();
            }

            var clientIp = access.ResolveClientIp(
                request.HttpContext.Connection.RemoteIpAddress, request.Headers["X-Forwarded-For"]);
            if (clientIp is null || !access.IsAllowed(clientIp))
            {
                LogForbiddenSource(logger, clientIp?.ToString());
                return Results.Json(new { error = "forbidden_source" }, statusCode: StatusCodes.Status403Forbidden);
            }

            if (!access.TokenConfigured)
            {
                return Unavailable();
            }

            // CONTRACT: A wrong token answers the framework's bodiless 404 and logs NOTHING — the
            // token is a secret, and a scan must not tell a wrong token from a missing route.
            if (!access.TokenMatches(token))
            {
                return Results.NotFound();
            }

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
                _ => Unavailable(),
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
                    else if (parameter.Name == "token")
                    {
                        parameter.Description =
                            "STRIPE_WEBHOOK_URL_TOKEN, a secret embedded in the URL registered with Stripe.";
                    }
                }

                return Task.CompletedTask;
            })
            .Produces<StripeWebhookResponse>(StatusCodes.Status200OK)
            .Produces(StatusCodes.Status400BadRequest)
            .Produces(StatusCodes.Status403Forbidden)
            .Produces(StatusCodes.Status404NotFound)
            .Produces(StatusCodes.Status409Conflict)
            .Produces(StatusCodes.Status503ServiceUnavailable);
    }

    /// <summary>
    /// <see cref="Route"/> for any path under <see cref="RoutePrefix"/> that carries a further
    /// segment, else <paramref name="path"/> unchanged.
    /// </summary>
    /// <remarks>
    /// CONTRACT: Every log field and span attribute recording a request path goes through this.
    /// Matching the PREFIX, not the endpoint, covers unmatched paths that still hold the token.
    /// See [[2026-09-19-stripe-payments-design]]
    /// </remarks>
    public static string? RedactPath(string? path) =>
        path is not null
        && new PathString(path).StartsWithSegments(RoutePrefix, StringComparison.OrdinalIgnoreCase, out var rest)
        && rest.HasValue
            ? Route
            : path;

    /// <summary>Rewrites every span attribute that holds the concrete webhook path.</summary>
    public static void RedactSpan(Activity activity, HttpRequest request)
    {
        var path = request.Path.Value;
        if (path is null || RedactPath(path) == path)
        {
            return;
        }

        foreach (var (key, value) in activity.TagObjects.ToList())
        {
            if (value is string text && text.Contains(path, StringComparison.Ordinal))
            {
                activity.SetTag(key, text.Replace(path, Route, StringComparison.Ordinal));
            }
        }
    }

    private static IResult Unavailable() =>
        Results.Json(new { error = "stripe_unavailable" }, statusCode: StatusCodes.Status503ServiceUnavailable);

    private static void LogForbiddenSource(ILogger logger, string? sourceIp)
    {
        // WHY: An unparseable source is omitted, never logged as null or as the raw header text.
        if (sourceIp is null)
        {
            logger.LogWarning(
                "Stripe webhook rejected: source IP not allowed {app_event} {reason}",
                "stripe_webhook_received", "source_ip_not_allowed");
            return;
        }

        logger.LogWarning(
            "Stripe webhook rejected: source IP not allowed {app_event} {reason} {source_ip}",
            "stripe_webhook_received", "source_ip_not_allowed", sourceIp);
    }
}

/// <summary>The acknowledgement Stripe receives for a handled or ignored event.</summary>
public record StripeWebhookResponse(bool Received);
