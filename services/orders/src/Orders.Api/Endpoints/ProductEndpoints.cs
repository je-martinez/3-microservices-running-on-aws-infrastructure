using Orders.Api.Caching;
using Orders.Application.Orders;
using Orders.Infrastructure.Caching;
using Orders.Infrastructure.Orders;

namespace Orders.Api.Endpoints;

public static class ProductEndpoints
{
    public static void MapProductEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/v1/products").WithTags("Products");

        // No ICurrentCaller parameter: products have no owner, so the handler
        // doesn't need the caller. The route is still gated by
        // CallerContextMiddleware (401 without x-user-id) because it's not in
        // PublicRoutes.IsPublic.
        group.MapGet("", async (ProductReadService reads) =>
            Results.Ok(await reads.GetProductsAsync()))
            .WithName("GetProducts")
            .WithSummary("List the active product catalog.")
            .Produces<IReadOnlyList<ProductDto>>(StatusCodes.Status200OK)
            .Produces(StatusCodes.Status401Unauthorized)
            .WithCache(
                // The catalogue belongs to no user: one key for everyone, and the only
                // response key in this service with neither cognito_sub nor user_id. That
                // is also why it is excluded from the per-user key index — there is no
                // user whose write could invalidate it.
                (_, _) => Task.FromResult<string?>(CacheKeys.Products),
                CacheKeys.ProductsTtl);
    }
}
