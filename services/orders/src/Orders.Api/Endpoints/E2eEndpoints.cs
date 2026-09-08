using Microsoft.EntityFrameworkCore;
using Orders.Application.Abstractions;
using Orders.Domain.Entities;
using Orders.Infrastructure.Caching;
using Orders.Infrastructure.Persistence;

namespace Orders.Api.Endpoints;

// Only mapped when E2E_TESTING_ENABLED. Mirrors the Users e2e-cleanup pattern.
public static class E2eEndpoints
{
    // Candidate for MySQL's JSON_CONTAINS: a JSON scalar, so the quotes are part of
    // the value. `JSON_CONTAINS(tags, '"E2E Source"')` is true when the array holds
    // that element. Serialized rather than hand-quoted so a tag that ever needs
    // escaping stays correct.
    private static readonly string E2eSourceCandidate =
        System.Text.Json.JsonSerializer.Serialize(Order.E2eSourceTag);

    public static void MapE2eEndpoints(this WebApplication app)
    {
        app.MapDelete("/v1/orders/e2e-cleanup", async (
            OrdersWriteDbContext db,
            ICacheInvalidator cache) =>
        {
            var now = DateTime.UtcNow;

            // CONTRACT: Delete BY TAG, not by caller — the teardown runs with no identity and
            // an E2E run creates orders under several users.
            // CONTRACT: Details FIRST, then orders. The detail predicate is a subquery over
            // the tagged orders, so orders soft-deleted first are hidden from it by their own
            // query filter, leaving every detail row live under a deleted parent.
            var deletedDetails = await db.OrderDetails
                .Where(d => db.Orders
                    .Where(o => EF.Functions.JsonContains(o.Tags, E2eSourceCandidate))
                    .Select(o => o.Id)
                    .Contains(d.OrderId))
                .ExecuteUpdateAsync(s => s
                    .SetProperty(d => d.DeletedAt, now)
                    .SetProperty(d => d.DeletedBy, AuditActor.E2eCleanup));

            // CONTRACT: Stamp DeletedBy explicitly. ExecuteUpdate bypasses SaveChanges, so
            // the AuditInterceptor never runs for it. See [[audit-fields]]
            var deleted = await db.Orders
                .Where(o => EF.Functions.JsonContains(o.Tags, E2eSourceCandidate))
                .ExecuteUpdateAsync(s => s
                    .SetProperty(o => o.DeletedAt, now)
                    .SetProperty(o => o.DeletedBy, AuditActor.E2eCleanup));

            // CONTRACT: Restock. A soft-delete does not return the stock the orders
            // consumed, and the seed only plants rows when the table is EMPTY, so without
            // this every run leaves the catalogue poorer until products reach 0 and the whole
            // suite fails with "no product with stock". Restore to the SEED's quantities, not
            // the amount consumed: idempotent, and no arithmetic over soft-deleted lines.
            var restocked = 0;
            foreach (var (name, units) in ProductSeed.SeedStock)
            {
                restocked += await db.Products
                    .Where(p => p.Name == name && p.UnitsInStock < units)
                    .ExecuteUpdateAsync(s => s
                        .SetProperty(p => p.UnitsInStock, units)
                        .SetProperty(p => p.UpdatedAt, now)
                        .SetProperty(p => p.UpdatedBy, AuditActor.E2eCleanup));
            }

            // CONTRACT: Invalidate the catalogue here. The ExecuteUpdate calls above bypass
            // SaveChanges and every interceptor, so nothing else tells the cache the stock
            // moved and the next E2E run reads the drained figures for a full 10 minutes.
            // Only the catalogue: this endpoint has no caller identity to sweep per-user
            // entries by, and those expire on their own 2-minute TTL. Use
            // CancellationToken.None — a client hanging up must not leave the entry stale.
            // See [[x-cache-response-header]]
            await cache.InvalidateProductsAsync(CancellationToken.None);

            return Results.Ok(new E2eCleanupResponse(deleted, deletedDetails, restocked));
        })
            // Tagged "e2e", not "Orders": a flag-guarded, test-only surface that a
            // reader must be able to spot as such in the spec without inferring it
            // from the summary. Users and Tracking group their cleanup routes the
            // same way.
            .WithTags("e2e")
            .WithName("E2eCleanup")
            .WithSummary("Soft-delete every order tagged \"E2E Source\" and restore seed stock (only mapped when E2E_TESTING_ENABLED).")
            .Produces<E2eCleanupResponse>(StatusCodes.Status200OK);
    }
}

/// <summary>
/// How many rows the cleanup soft-deleted, and how many products it restocked.
/// Returned so a failing teardown can be diagnosed from the response instead of the
/// database.
/// </summary>
public record E2eCleanupResponse(int Deleted, int DeletedDetails, int Restocked);
