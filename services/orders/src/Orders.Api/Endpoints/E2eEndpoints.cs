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

            // Deletes BY TAG, not by caller. The global teardown runs with no identity
            // at all, and scoping to the caller's sub could only ever remove the rows
            // of whichever user happened to call — an E2E run creates orders under
            // several users. The tag is what marks a row as test-created, so it is what
            // selects it here.
            //
            // Details first, then orders. The order matters: the detail predicate is a
            // subquery over the tagged ORDERS, and orders soft-deleted first would be
            // hidden from it by their own query filter, leaving every detail row behind
            // as a live child of a deleted parent. OrderDetail carries no tag of its own
            // — it is deleted through its parent (see the report/entity notes).
            var deletedDetails = await db.OrderDetails
                .Where(d => db.Orders
                    .Where(o => EF.Functions.JsonContains(o.Tags, E2eSourceCandidate))
                    .Select(o => o.Id)
                    .Contains(d.OrderId))
                .ExecuteUpdateAsync(s => s
                    .SetProperty(d => d.DeletedAt, now)
                    .SetProperty(d => d.DeletedBy, AuditActor.E2eCleanup));

            // Soft-delete (never physical DELETE). ExecuteUpdate issues a single SQL
            // UPDATE and BYPASSES SaveChanges, so the AuditInterceptor never runs for it
            // — DeletedBy is stamped explicitly here (mirrors the semantic actor the
            // interceptor would set).
            var deleted = await db.Orders
                .Where(o => EF.Functions.JsonContains(o.Tags, E2eSourceCandidate))
                .ExecuteUpdateAsync(s => s
                    .SetProperty(o => o.DeletedAt, now)
                    .SetProperty(o => o.DeletedBy, AuditActor.E2eCleanup));

            // Put the stock back. Deleting the orders is not enough: stock was
            // decremented when they were placed, and a soft-delete does not give it
            // back, so every run left the catalogue permanently poorer. The seed only
            // plants rows when the table is EMPTY, so nothing ever replenished them —
            // all three products reached 0 and the suite began failing with "no product
            // with stock in the catalogue", including tests about ownership and carrier
            // auth whose fixtures merely need to place an order first.
            //
            // Restoring to the seed's own quantities (rather than adding back exactly
            // what these orders consumed) is deliberate: it is idempotent, needs no
            // arithmetic over soft-deleted lines, and leaves the catalogue in the same
            // state a fresh database would have. The E2E specs never assert an exact
            // quantity — they pick "any product with stock" and the over-stock test asks
            // for `unitsInStock + 1_000_000` — so the concrete numbers are free to be
            // whatever the seed says.
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

            // The count of ORDERS removed, matching Users' `{ deleted: N }` shape. The
            // detail count is reported alongside it rather than folded in, so a teardown
            // that removed nothing is distinguishable from one that removed orders whose
            // lines were already gone.
            // The ExecuteUpdateAsync calls above bypass SaveChanges and therefore every
            // interceptor and write service in this codebase — nothing else in the request
            // would ever tell the cache the catalogue moved. Without this line the
            // restocked stock is invisible for the catalogue entry's full 10-minute TTL,
            // which is longer than an E2E suite runs: the next run reads the drained
            // figures and fails on fixtures that only need to place an order.
            //
            // Only the catalogue. Per-user entries are keyed by sub, and this endpoint
            // deletes BY TAG across every user an E2E run touched — it has no caller
            // identity at all to sweep by, and the orders it soft-deletes are E2E rows no
            // real session is reading. Their entries expire on their own 2-minute TTL.
            //
            // CancellationToken.None, not the request's: the restock has already
            // committed, and a client that hung up mid-teardown must not leave the
            // catalogue entry stale for the next run.
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
