using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Orders.Api.Identity;
using Orders.Application.Abstractions;
using Orders.Infrastructure.Caching;
using Orders.Infrastructure.Carts;
using Orders.Infrastructure.Observability;
using Orders.Infrastructure.Persistence;

namespace Orders.Api.Endpoints;

/// <summary>
/// Service-to-service routes. Not published on the API Gateway; authenticated with
/// the shared internal key, never a user JWT.
/// </summary>
public static class InternalEndpoints
{
    /// <summary>
    /// Binary collation pinned on the cascade's ownership predicates. Taken from
    /// <see cref="CartWriteService"/> rather than spelled out again here, so the API and
    /// Infrastructure halves of the same cascade cannot drift onto different collations.
    /// </summary>
    private const string BinaryCollation = CartWriteService.BinaryCollation;

    public static void MapInternalEndpoints(this WebApplication app)
    {
        app.MapDelete("/v1/orders/by-user", async (
            // CONTRACT: [FromBody] is REQUIRED on DELETE — Minimal APIs refuse inferred body params and
            // throw at endpoint build time, which breaks `dotnet build` when OpenAPI walks every route.
            // WHY: Identity stays in the body, not the URL — access logs must not carry it.
            [FromBody] InternalDeleteByUserRequest body,
            HttpRequest http,
            IConfiguration config,
            OrdersWriteDbContext db,
            IWorkflowTracer tracer,
            // The INTERFACE, never ICacheGateway: with CACHE_ENABLED=false no gateway is
            // registered at all, and resolving one directly would make the kill switch
            // take this route down. NoopCacheInvalidator satisfies this in that branch.
            ICacheInvalidator cache,
            // Injected rather than loggerFactory.CreateLogger("…literal…"): every other
            // logging site in Orders takes ILogger<T>, and a hand-typed category string
            // silently diverges from reality the moment this file is renamed or moved,
            // with nothing to fail on it.
            ILogger<InternalEndpointsCategory> logger,
            CancellationToken ct) =>
        {
            var provided = http.Headers[InternalApiKey.HeaderName].FirstOrDefault();

            if (!InternalApiKey.Matches(provided, config["GRPC_API_KEY"]!))
            {
                // WARNING: Never log the API key — log client IP only on rejected attempts.
                logger.LogWarning(
                    "Rejected internal delete {app_event} {reason} {client}",
                    "internal_delete_by_user_failed",
                    "invalid_api_key",
                    http.HttpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown");
                return Results.Unauthorized();
            }

            return await tracer.TraceWorkflowAsync(
                "internal_delete_by_user",
                new Dictionary<string, object?>
                {
                    ["app_event"] = "internal_delete_by_user_started",
                },
                async () =>
                {
                    // WHY: Write triad — cascade spans four statements across three tables.
                    logger.LogInformation(
                        "Starting internal delete by user {app_event}",
                        "internal_delete_by_user_started");

                    // CONTRACT: Reject empty cognitoSub or userId — the OR predicate below matches empty
                    // strings and would soft-delete every row with a blank identity column.
                    if (string.IsNullOrWhiteSpace(body.CognitoSub))
                    {
                        logger.LogWarning(
                            "Internal delete rejected {app_event} {reason}",
                            "internal_delete_by_user_failed", "cognito_sub_required");
                        tracer.SetReason("cognito_sub_required");
                        return Results.BadRequest(new { error = "cognito_sub_required" });
                    }

                    // WHY: Distinct reason codes tell Users which field it failed to send.
                    if (string.IsNullOrWhiteSpace(body.UserId))
                    {
                        logger.LogWarning(
                            "Internal delete rejected {app_event} {reason}",
                            "internal_delete_by_user_failed", "user_id_required");
                        tracer.SetReason("user_id_required");
                        return Results.BadRequest(new { error = "user_id_required" });
                    }

                    var now = DateTime.UtcNow;

                    int deletedDetails;
                    int deleted;
                    var deletedCarts = 0;

                    try
                    {
                        // CONTRACT: Soft-delete order_details BEFORE orders — the detail predicate subqueries
                        // parent orders; parents deleted first are hidden by the global filter and orphan lines.
                        // WHY: Key on order_id — order_details has no index on cognito_sub or user_id.
                        deletedDetails = await db.OrderDetails
                            .Where(d => db.Orders
                                .Where(o => EF.Functions.Collate(o.CognitoSub, BinaryCollation)
                                        == EF.Functions.Collate(body.CognitoSub, BinaryCollation)
                                    || EF.Functions.Collate(o.UserId, BinaryCollation)
                                        == EF.Functions.Collate(body.UserId, BinaryCollation))
                                .Select(o => o.Id)
                                .Contains(d.OrderId) && d.DeletedAt == null)
                            .ExecuteUpdateAsync(s => s
                                .SetProperty(d => d.DeletedAt, now)
                                .SetProperty(d => d.DeletedBy, AuditActor.DeleteByUser), ct);

                        // CONTRACT: Collate BOTH sides with utf8mb4_bin on erasure predicates — columns are
                        // case-insensitive (utf8mb4_0900_ai_ci) but ids use mixed-case NanoId; without binary
                        // collation one user's erasure sweeps a neighbour's rows and returns 200 with a count.
                        // See [[orders-service-design]]
                        deleted = await db.Orders
                            .Where(o => (EF.Functions.Collate(o.CognitoSub, BinaryCollation)
                                        == EF.Functions.Collate(body.CognitoSub, BinaryCollation)
                                    || EF.Functions.Collate(o.UserId, BinaryCollation)
                                        == EF.Functions.Collate(body.UserId, BinaryCollation))
                                && o.DeletedAt == null)
                            .ExecuteUpdateAsync(s => s
                                .SetProperty(o => o.DeletedAt, now)
                                .SetProperty(o => o.DeletedBy, AuditActor.DeleteByUser), ct);

                        // WHY: Three-arg DeleteForUserAsync ORs both identities for erasure; the two-arg
                        // overload used by live cart routes must not widen to an older sub on shared usr_ id.
                        await AmbientActor.RunAsync(AuditActor.DeleteByUser, async () =>
                        {
                            var before = await db.Carts
                                .CountAsync(c => EF.Functions.Collate(c.CognitoSub, BinaryCollation)
                                        == EF.Functions.Collate(body.CognitoSub, BinaryCollation)
                                    || EF.Functions.Collate(c.UserId, BinaryCollation)
                                        == EF.Functions.Collate(body.UserId, BinaryCollation), ct);
                            await CartWriteService.DeleteForUserAsync(
                                db, body.CognitoSub, body.UserId, ct);
                            await db.SaveChangesAsync(ct);
                            deletedCarts = before;
                        });
                    }
                    catch (Exception ex)
                    {
                        // WARNING: Log app_event and reason on DB faults — otherwise 500s are invisible to queries.
                        logger.LogError(
                            ex,
                            "Internal delete failed {app_event} {reason}",
                            "internal_delete_by_user_failed", "db_error");
                        tracer.SetReason("db_error");
                        throw;
                    }

                    // CONTRACT: Invalidate AFTER commit — earlier invalidation lets a concurrent read
                    // repopulate stale entries for their full TTL (up to an hour for identity).
                    // FAIL-OPEN: rows are gone; a Redis fault must not turn a succeeded cascade into 500.
                    // Pass BOTH identities — see ICacheInvalidator.InvalidateDeletedUserAsync.
                    await cache.InvalidateDeletedUserAsync(body.CognitoSub, body.UserId, ct);

                    // WHY: Log both subjects and all counts — enricher has no end-user identity here.
                    logger.LogInformation(
                        "Deleted orders for user {app_event} {cognito_sub} {user_id} " +
                        "{deleted_count} {deleted_details} {deleted_carts}",
                        "internal_delete_by_user_succeeded",
                        body.CognitoSub,
                        body.UserId,
                        deleted,
                        deletedDetails,
                        deletedCarts);

                    return Results.Ok(
                        new InternalDeleteResponse(deleted, deletedDetails, deletedCarts));
                });
        })
            .Accepts<InternalDeleteByUserRequest>("application/json")
            .WithTags("internal")
            .WithName("InternalDeleteByUser")
            .WithSummary("[Internal] Soft-delete every order, line and cart belonging to a user.")
            .Produces<InternalDeleteResponse>(StatusCodes.Status200OK)
            .Produces(StatusCodes.Status400BadRequest)
            .Produces(StatusCodes.Status401Unauthorized);
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
