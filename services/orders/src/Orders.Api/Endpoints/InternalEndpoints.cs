using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Orders.Api.Identity;
using Orders.Application.Abstractions;
using Orders.Infrastructure.Carts;
using Orders.Infrastructure.Persistence;

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
            // [FromBody] is REQUIRED, not decorative. Minimal APIs refuse to INFER a
            // body parameter on DELETE (as on GET/HEAD), which the spec treats as
            // body-less: without the attribute the route throws
            // "Body was inferred but the method does not allow inferred body
            // parameters" while the endpoint is being built — which is at build time
            // here, since the OpenAPI generator walks every endpoint, so the whole
            // `dotnet build` fails rather than just this route.
            //
            // The subject stays in the body regardless: it is an identity, and an
            // identity does not belong in a URL that lands in access logs.
            [FromBody] InternalDeleteByUserRequest body,
            HttpRequest http,
            IConfiguration config,
            OrdersWriteDbContext db,
            ILoggerFactory loggerFactory,
            CancellationToken ct) =>
        {
            var logger = loggerFactory.CreateLogger("Orders.Api.Endpoints.InternalEndpoints");
            var provided = http.Headers[InternalApiKey.HeaderName].FirstOrDefault();

            if (!InternalApiKey.Matches(provided, config["GRPC_API_KEY"]!))
            {
                // A mass soft-delete surface is the widest blast radius in this
                // service; failed attempts are worth seeing. NEVER log the key.
                logger.LogWarning(
                    "Rejected internal delete {app_event} {reason}",
                    "internal_delete_by_user_failed", "invalid_api_key");
                return Results.Unauthorized();
            }

            if (string.IsNullOrWhiteSpace(body.CognitoSub))
            {
                return Results.BadRequest(new { error = "cognito_sub_required" });
            }

            var now = DateTime.UtcNow;

            // Details FIRST, then orders — the same ordering the E2E cleanup uses and
            // for the same reason: the detail predicate is a subquery over the parent
            // orders, and orders soft-deleted first would be hidden from it by their
            // own global query filter, orphaning every line as a live child of a
            // deleted parent.
            //
            // Selected through order_id rather than by cognito_sub directly:
            // order_details carries the denormalized column but has NO index on it
            // (only order_id, product_id, deleted_at), so keying on it would table-scan.
            var deletedDetails = await db.OrderDetails
                .Where(d => db.Orders
                    .Where(o => o.CognitoSub == body.CognitoSub)
                    .Select(o => o.Id)
                    .Contains(d.OrderId) && d.DeletedAt == null)
                .ExecuteUpdateAsync(s => s
                    .SetProperty(d => d.DeletedAt, now)
                    .SetProperty(d => d.DeletedBy, AuditActor.DeleteByUser), ct);

            // `DeletedAt == null` guards keep this idempotent: a retry after a partial
            // cascade failure re-runs harmlessly and reports 0.
            //
            // ExecuteUpdate issues one SQL UPDATE and BYPASSES SaveChanges, so the
            // AuditInterceptor never runs — DeletedBy is stamped explicitly here.
            var deleted = await db.Orders
                .Where(o => o.CognitoSub == body.CognitoSub && o.DeletedAt == null)
                .ExecuteUpdateAsync(s => s
                    .SetProperty(o => o.DeletedAt, now)
                    .SetProperty(o => o.DeletedBy, AuditActor.DeleteByUser), ct);

            // The cart goes through the shared primitive rather than a fourth bespoke
            // UPDATE: it must remove the LINES too, or the cart_item unique index stays
            // occupied. AmbientActor drives the interceptor, since this path DOES use
            // SaveChanges.
            var deletedCarts = 0;
            await AmbientActor.RunAsync(AuditActor.DeleteByUser, async () =>
            {
                var before = await db.Carts.CountAsync(c => c.CognitoSub == body.CognitoSub, ct);
                await CartWriteService.DeleteForUserAsync(db, body.CognitoSub, ct);
                await db.SaveChangesAsync(ct);
                deletedCarts = before;
            });

            logger.LogInformation(
                "Deleted orders for user {app_event} {deleted_count}",
                "internal_delete_by_user_succeeded", deleted);

            return Results.Ok(new InternalDeleteResponse(deleted, deletedDetails, deletedCarts));
        })
            .Accepts<InternalDeleteByUserRequest>("application/json")
            .WithTags("internal")
            .WithName("InternalDeleteByUser")
            .WithSummary("[Internal] Soft-delete every order, line and cart belonging to a user.")
            .Produces<InternalDeleteResponse>(StatusCodes.Status200OK)
            .Produces(StatusCodes.Status401Unauthorized);
    }
}

/// <summary>The subject to erase. Identity travels in the body, not a header, because
/// the caller is Users acting on the user's behalf — there is no end-user request here.</summary>
public record InternalDeleteByUserRequest(string CognitoSub);

/// <summary>What the cascade removed, reported per table so a partial failure is diagnosable
/// from the response instead of the database.</summary>
public record InternalDeleteResponse(int Deleted, int DeletedDetails, int DeletedCarts);
