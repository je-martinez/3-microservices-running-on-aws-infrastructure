using Microsoft.EntityFrameworkCore;
using Orders.Infrastructure.Persistence;

namespace Orders.Api.Endpoints;

// Only mapped when E2E_TESTING_ENABLED. Mirrors the Users e2e-cleanup pattern.
public static class E2eEndpoints
{
    public static void MapE2eEndpoints(this WebApplication app)
    {
        app.MapDelete("/v1/orders/e2e-cleanup", async (HttpContext ctx, OrdersWriteDbContext db) =>
        {
            var sub = ctx.Request.Headers["x-user-id"].FirstOrDefault();
            if (sub is null) return Results.Unauthorized();
            var now = DateTime.UtcNow;
            // Soft-delete this caller's orders (never physical DELETE).
            await db.Orders.Where(o => o.CognitoSub == sub)
                .ExecuteUpdateAsync(s => s
                    .SetProperty(o => o.DeletedAt, now)
                    .SetProperty(o => o.DeletedBy, "e2e"));
            return Results.NoContent();
        })
            .WithTags("Orders")
            .WithName("E2eCleanup")
            .WithSummary("Soft-delete the caller's orders (only mapped when E2E_TESTING_ENABLED).")
            .Produces(StatusCodes.Status204NoContent)
            .Produces(StatusCodes.Status401Unauthorized);
    }
}
