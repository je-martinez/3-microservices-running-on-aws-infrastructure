using Orders.Application.Orders;
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
            .Produces(StatusCodes.Status401Unauthorized);
    }
}
