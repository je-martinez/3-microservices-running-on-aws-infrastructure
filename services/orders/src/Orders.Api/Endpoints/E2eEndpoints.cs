using Microsoft.EntityFrameworkCore;
using Orders.Api.Identity;
using Orders.Application.Abstractions;
using Orders.Infrastructure.Persistence;

namespace Orders.Api.Endpoints;

// Only mapped when E2E_TESTING_ENABLED. Mirrors the Users e2e-cleanup pattern.
public static class E2eEndpoints
{
    public static void MapE2eEndpoints(this WebApplication app)
    {
        app.MapDelete("/v1/orders/e2e-cleanup", async (ICurrentCaller caller, OrdersWriteDbContext db) =>
        {
            // x-user-id absence already 401'd by CallerContextMiddleware (this
            // route is not on the public allowlist), so CognitoSub is guaranteed
            // non-null here.
            var sub = caller.CognitoSub!;
            var now = DateTime.UtcNow;
            // Soft-delete this caller's orders (never physical DELETE).
            // ExecuteUpdate issues a single SQL UPDATE and BYPASSES SaveChanges, so
            // the AuditInterceptor never runs for it — DeletedBy is stamped
            // explicitly here (mirrors the semantic actor the interceptor would set).
            await db.Orders.Where(o => o.CognitoSub == sub)
                .ExecuteUpdateAsync(s => s
                    .SetProperty(o => o.DeletedAt, now)
                    .SetProperty(o => o.DeletedBy, AuditActor.E2eCleanup));
            return Results.NoContent();
        })
            .WithTags("Orders")
            .WithName("E2eCleanup")
            .WithSummary("Soft-delete the caller's orders (only mapped when E2E_TESTING_ENABLED).")
            .Produces(StatusCodes.Status204NoContent)
            .Produces(StatusCodes.Status401Unauthorized);
    }
}
