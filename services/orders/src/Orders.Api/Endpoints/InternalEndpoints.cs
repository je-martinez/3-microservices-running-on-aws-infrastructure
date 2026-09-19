using Microsoft.AspNetCore.Mvc;
using Orders.Api.Identity;
using Orders.Application.Messaging;
using Orders.Infrastructure.Orders;
using Wolverine;

namespace Orders.Api.Endpoints;

/// <summary>
/// Service-to-service routes. Not published on the API Gateway; authenticated with
/// the shared internal key, never a user JWT.
/// </summary>
public static class InternalEndpoints
{
    public static void MapInternalEndpoints(this WebApplication app)
    {
        app.MapDelete("/v1/orders/by-user", async (
            // CONTRACT: [FromBody] is REQUIRED on DELETE — Minimal APIs refuse inferred body params and
            // throw at endpoint build time, which breaks `dotnet build` when OpenAPI walks every route.
            // WHY: Identity stays in the body, not the URL — access logs must not carry it.
            [FromBody] InternalDeleteByUserRequest body,
            HttpRequest http,
            IConfiguration config,
            DeleteOrdersByUserService deletions,
            ILogger<InternalEndpointsCategory> logger,
            CancellationToken ct) =>
        {
            var provided = http.Headers[InternalApiKey.HeaderName].FirstOrDefault();

            // CONTRACT: Reject before reaching the service — 401 takes precedence over the
            // body's own 400, so an unauthenticated caller never learns which field it got
            // wrong and never costs a DB read.
            if (!InternalApiKey.Matches(provided, config["INTERNAL_API_KEY"]!))
            {
                // WARNING: Never log the API key — log client IP only on rejected attempts.
                logger.LogWarning(
                    "Rejected internal delete {app_event} {reason} {client}",
                    "internal_delete_by_user_failed",
                    "invalid_api_key",
                    http.HttpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown");
                return Results.Unauthorized();
            }

            var result = await deletions.DeleteAsync(body.CognitoSub, body.UserId, ct);

            return result.Reason is not null
                ? Results.BadRequest(new { error = result.Reason })
                : Results.Ok(new InternalDeleteResponse(
                    result.Deleted, result.DeletedDetails, result.DeletedCarts));
        })
            .Accepts<InternalDeleteByUserRequest>("application/json")
            .WithTags("internal")
            .WithName("InternalDeleteByUser")
            .WithSummary("[Internal] Soft-delete every order, line and cart belonging to a user.")
            .Produces<InternalDeleteResponse>(StatusCodes.Status200OK)
            .Produces(StatusCodes.Status400BadRequest)
            .Produces(StatusCodes.Status401Unauthorized);

        // CONTRACT: Dispatch through the bus, never by resolving the handler and calling it.
        // The span, the app_event and both flow log lines come from the pipeline wrapped around
        // the handler, so a direct call sweeps the cache UNINSTRUMENTED. See [[cqrs]]
        app.MapPost("/v1/orders/{orderId}/cache-invalidation", async (
            string orderId,
            HttpRequest http,
            IConfiguration config,
            IMessageBus bus,
            ILogger<InternalEndpointsCategory> logger,
            CancellationToken ct) =>
        {
            var provided = http.Headers[InternalApiKey.HeaderName].FirstOrDefault();

            // CONTRACT: Reject before reaching the service — an unauthenticated caller must
            // not even cost the owner a DB read, which on a route needing no user identity
            // would strip the cache off any order whose id an attacker can guess.
            if (!InternalApiKey.Matches(provided, config["INTERNAL_API_KEY"]!))
            {
                // WARNING: Never log the API key — log client IP only on rejected attempts.
                logger.LogWarning(
                    "Rejected order cache invalidation {app_event} {reason} {client}",
                    "internal_invalidate_order_cache_failed",
                    "invalid_api_key",
                    http.HttpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown");
                return Results.Unauthorized();
            }

            var result = await bus.InvokeAsync<InvalidateOrderCacheResult>(
                new InvalidateOrderCache(orderId), ct);

            // CONTRACT: Map the RETURNED reason, do not catch for it. "No such order" reaches
            // here as a value, which is what keeps its span OK while its log line still says
            // _failed. See [[logging-context]]
            return result.Invalidated
                ? Results.Ok(new InternalInvalidateOrderCacheResponse(orderId))
                : Results.NotFound(new { error = result.FailureReason });
        })
            .WithTags("internal")
            .WithName("InternalInvalidateOrderCache")
            .WithSummary("[Internal] Forget the cached order responses for one order.")
            .Produces<InternalInvalidateOrderCacheResponse>(StatusCodes.Status200OK)
            .Produces(StatusCodes.Status401Unauthorized)
            .Produces(StatusCodes.Status404NotFound);
    }
}

/// <summary>Logging category derived from namespace — survives file renames.</summary>
public sealed class InternalEndpointsCategory;

/// <summary>Erasure subject — identity in the body, not the URL (access logs).</summary>
/// <remarks>
/// CONTRACT: Both CognitoSub and UserId are required — the cascade ORs on either; an empty
/// string matches every row with a blank identity column.
/// See [[orders-service-design]]
/// </remarks>
public record InternalDeleteByUserRequest(string CognitoSub, string UserId);

/// <summary>Per-table deletion counts for diagnosing partial cascade failures.</summary>
public record InternalDeleteResponse(int Deleted, int DeletedDetails, int DeletedCarts);

/// <summary>Echoes the order whose cached responses were forgotten.</summary>
/// <remarks>
/// CONTRACT: No key list and no count. What was swept is Orders' own business, and a caller
/// that learns the key shape starts depending on it — the coupling this route exists to
/// prevent. See [[x-cache-response-header]]
/// </remarks>
public record InternalInvalidateOrderCacheResponse(string OrderId);
