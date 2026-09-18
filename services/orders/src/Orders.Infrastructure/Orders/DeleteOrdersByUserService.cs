using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Orders.Application.Abstractions;
using Orders.Infrastructure.Caching;
using Orders.Infrastructure.Carts;
using Orders.Infrastructure.Observability;
using Orders.Infrastructure.Persistence;

namespace Orders.Infrastructure.Orders;

/// <summary>
/// Outcome of the account-erasure cascade. <paramref name="Reason"/> is null on success and
/// names the rejected field otherwise, which the API maps onto a 400.
/// </summary>
public record DeleteOrdersByUserResult(
    int Deleted,
    int DeletedDetails,
    int DeletedCarts,
    string? Reason)
{
    public static DeleteOrdersByUserResult Rejected(string reason) => new(0, 0, 0, reason);
}

/// <summary>
/// Soft-deletes every order, line and cart belonging to one user, for
/// <c>DELETE /v1/orders/by-user</c>. Idempotent: a second call matches no live row and
/// reports zero counts. See [[soft-delete]]
/// </summary>
public class DeleteOrdersByUserService
{
    /// <summary>
    /// Binary collation pinned on the cascade's ownership predicates. Taken from
    /// <see cref="CartWriteService"/> rather than spelled out again here, so both halves of
    /// the same cascade cannot drift onto different collations.
    /// </summary>
    private const string BinaryCollation = CartWriteService.BinaryCollation;

    private readonly OrdersWriteDbContext _db;
    private readonly IWorkflowTracer _tracer;
    // The INTERFACE, never ICacheGateway: with CACHE_ENABLED=false no gateway is registered
    // at all, and resolving one directly would make the kill switch take this route down.
    // NoopCacheInvalidator satisfies this in that branch.
    private readonly ICacheInvalidator _cache;
    private readonly ILogger<DeleteOrdersByUserService> _logger;

    public DeleteOrdersByUserService(
        OrdersWriteDbContext db,
        IWorkflowTracer tracer,
        ICacheInvalidator cache,
        ILogger<DeleteOrdersByUserService> logger)
    {
        _db = db;
        _tracer = tracer;
        _cache = cache;
        _logger = logger;
    }

    public Task<DeleteOrdersByUserResult> DeleteAsync(
        string? cognitoSub,
        string? userId,
        CancellationToken ct = default) =>
        _tracer.TraceWorkflowAsync(
            "internal_delete_by_user",
            new Dictionary<string, object?>
            {
                ["app_event"] = "internal_delete_by_user_started",
            },
            async () =>
            {
                // WHY: Write triad — cascade spans four statements across three tables.
                _logger.LogInformation(
                    "Starting internal delete by user {app_event}",
                    "internal_delete_by_user_started");

                // CONTRACT: Reject empty cognitoSub or userId — the OR predicate below matches empty
                // strings and would soft-delete every row with a blank identity column.
                if (string.IsNullOrWhiteSpace(cognitoSub))
                {
                    return Reject("cognito_sub_required");
                }

                // WHY: Distinct reason codes tell Users which field it failed to send.
                if (string.IsNullOrWhiteSpace(userId))
                {
                    return Reject("user_id_required");
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
                    deletedDetails = await _db.OrderDetails
                        .Where(d => _db.Orders
                            .Where(o => EF.Functions.Collate(o.CognitoSub, BinaryCollation)
                                    == EF.Functions.Collate(cognitoSub, BinaryCollation)
                                || EF.Functions.Collate(o.UserId, BinaryCollation)
                                    == EF.Functions.Collate(userId, BinaryCollation))
                            .Select(o => o.Id)
                            .Contains(d.OrderId) && d.DeletedAt == null)
                        .ExecuteUpdateAsync(s => s
                            .SetProperty(d => d.DeletedAt, now)
                            .SetProperty(d => d.DeletedBy, AuditActor.DeleteByUser), ct);

                    // CONTRACT: Collate BOTH sides with utf8mb4_bin on erasure predicates — columns are
                    // case-insensitive (utf8mb4_0900_ai_ci) but ids use mixed-case NanoId; without binary
                    // collation one user's erasure sweeps a neighbour's rows and returns 200 with a count.
                    // See [[orders-service-design]]
                    deleted = await _db.Orders
                        .Where(o => (EF.Functions.Collate(o.CognitoSub, BinaryCollation)
                                    == EF.Functions.Collate(cognitoSub, BinaryCollation)
                                || EF.Functions.Collate(o.UserId, BinaryCollation)
                                    == EF.Functions.Collate(userId, BinaryCollation))
                            && o.DeletedAt == null)
                        .ExecuteUpdateAsync(s => s
                            .SetProperty(o => o.DeletedAt, now)
                            .SetProperty(o => o.DeletedBy, AuditActor.DeleteByUser), ct);

                    // WHY: Three-arg DeleteForUserAsync ORs both identities for erasure; the two-arg
                    // overload used by live cart routes must not widen to an older sub on shared usr_ id.
                    await AmbientActor.RunAsync(AuditActor.DeleteByUser, async () =>
                    {
                        var before = await _db.Carts
                            .CountAsync(c => EF.Functions.Collate(c.CognitoSub, BinaryCollation)
                                    == EF.Functions.Collate(cognitoSub, BinaryCollation)
                                || EF.Functions.Collate(c.UserId, BinaryCollation)
                                    == EF.Functions.Collate(userId, BinaryCollation), ct);
                        await CartWriteService.DeleteForUserAsync(_db, cognitoSub, userId, ct);
                        await _db.SaveChangesAsync(ct);
                        deletedCarts = before;
                    });
                }
                catch (Exception ex)
                {
                    // WARNING: Log app_event and reason on DB faults — otherwise 500s are invisible to queries.
                    _logger.LogError(
                        ex,
                        "Internal delete failed {app_event} {reason}",
                        "internal_delete_by_user_failed", "db_error");
                    _tracer.SetReason("db_error");
                    throw;
                }

                // CONTRACT: Invalidate AFTER commit — earlier invalidation lets a concurrent read
                // repopulate stale entries for their full TTL (up to an hour for identity).
                // FAIL-OPEN: rows are gone; a Redis fault must not turn a succeeded cascade into 500.
                // Pass BOTH identities — see ICacheInvalidator.InvalidateDeletedUserAsync.
                await _cache.InvalidateDeletedUserAsync(cognitoSub, userId, ct);

                // WHY: Log both subjects and all counts — enricher has no end-user identity here.
                _logger.LogInformation(
                    "Deleted orders for user {app_event} {cognito_sub} {user_id} " +
                    "{deleted_count} {deleted_details} {deleted_carts}",
                    "internal_delete_by_user_succeeded",
                    cognitoSub,
                    userId,
                    deleted,
                    deletedDetails,
                    deletedCarts);

                return new DeleteOrdersByUserResult(deleted, deletedDetails, deletedCarts, null);
            });

    private DeleteOrdersByUserResult Reject(string reason)
    {
        _logger.LogWarning(
            "Internal delete rejected {app_event} {reason}",
            "internal_delete_by_user_failed", reason);
        _tracer.SetReason(reason);
        return DeleteOrdersByUserResult.Rejected(reason);
    }
}
