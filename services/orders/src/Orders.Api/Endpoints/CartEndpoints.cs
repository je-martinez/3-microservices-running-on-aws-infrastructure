using Orders.Api.Caching;
using Orders.Api.Identity;
using Orders.Application.Abstractions;
using Orders.Application.Carts;
using Orders.Infrastructure.Caching;
using Orders.Infrastructure.Carts;

namespace Orders.Api.Endpoints;

/// <param name="Quantity">
/// Bound as int, NOT uint, deliberately: a negative value must come back as the
/// documented 400 `invalid_request` body, and uint would make the JSON binder fail
/// first with a generic framework error the caller cannot act on.
/// </param>
public record UpdateCartItemRequest(string? ProductId, int Quantity);

public record UpdateCartRequest(IReadOnlyList<UpdateCartItemRequest>? Items);

public static class CartEndpoints
{
    public static void MapCartEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/v1/cart").WithTags("Cart");

        group.MapGet("", async (
            ICurrentCaller caller,
            CartReadService reads,
            CancellationToken ct) =>
        {
            // x-user-id absence already 401'd by CallerContextMiddleware.
            // Always 200: a user with no cart gets an empty one, never a 404, so the
            // frontend has a single shape to render.
            return Results.Ok(await reads.GetMyCartAsync(caller.CognitoSub!, ct));
        })
            .WithName("GetMyCart")
            .WithSummary("Read the caller's active cart, fully priced and calculated.")
            .Produces<CartDto>(StatusCodes.Status200OK)
            .Produces(StatusCodes.Status401Unauthorized)
            // The 60s TTL is only the safety net; correctness comes from the invalidation
            // on every cart PUT/DELETE and on order creation.
            //
            // No type argument: CachedReadFilter is non-generic and stores the serialized
            // body, so the call site never names the DTO. .Produces<CartDto> above still
            // documents the shape for OpenAPI — that is unrelated to the cache.
            .WithCache(UserCacheKeyBuilders.Cart, CacheKeys.CartTtl);

        group.MapPut("", Handle)
            .WithName("UpdateCart")
            .WithSummary("Replace the caller's cart lines; an empty set deletes the cart.")
            .Accepts<UpdateCartRequest>("application/json")
            .Produces<CartDto>(StatusCodes.Status200OK)
            .Produces(StatusCodes.Status400BadRequest)
            .Produces(StatusCodes.Status401Unauthorized)
            .Produces(StatusCodes.Status404NotFound);

        group.MapDelete("", async (
            ICurrentCaller caller,
            CartWriteService writes,
            CancellationToken ct) =>
        {
            await writes.DeleteAsync(caller.CognitoSub!, ct);
            // Idempotent: 204 whether or not there was a cart. A 404 for "already gone"
            // would make a retry after a dropped response look like a failure.
            return Results.NoContent();
        })
            .WithName("DeleteCart")
            .WithSummary("Delete the caller's active cart and all its lines.")
            .Produces(StatusCodes.Status204NoContent)
            .Produces(StatusCodes.Status401Unauthorized);
    }

    private static async Task<IResult> Handle(
        ICurrentCaller caller,
        UpdateCartRequest body,
        CartWriteService writes,
        CancellationToken ct)
    {
        // Validate BEFORE anything else. `Items` is declared nullable precisely because
        // System.Text.Json does not enforce non-nullable annotations: a body that omits
        // the key, misspells it, or sends an explicit null binds it to null. Without
        // this guard the first dereference downstream becomes a 500 — a server fault
        // reported for what is entirely a caller mistake. This is the same bug that
        // POST /v1/orders had to be guarded against.
        //
        // An EMPTY array is NOT rejected here: it is the documented way to empty (and
        // therefore delete) the cart.
        if (body?.Items is null)
        {
            return Results.BadRequest(new
            {
                error = "invalid_request",
                detail = "The 'items' array is required.",
            });
        }

        if (body.Items.Any(i => string.IsNullOrWhiteSpace(i.ProductId)))
        {
            return Results.BadRequest(new
            {
                error = "invalid_request",
                detail = "Every item requires a non-empty 'productId'.",
            });
        }

        // Zero is valid — it means "remove this line". Only negatives are an error.
        if (body.Items.Any(i => i.Quantity < 0))
        {
            return Results.BadRequest(new
            {
                error = "invalid_request",
                detail = "'quantity' cannot be negative; send 0 to remove a line.",
            });
        }

        // Under full-replacement semantics two entries for one product is ambiguity on
        // the caller's side, not an intent to sum. Rejecting is the honest answer.
        if (body.Items.Select(i => i.ProductId).Distinct().Count() != body.Items.Count)
        {
            return Results.BadRequest(new
            {
                error = "invalid_request",
                detail = "Each 'productId' may appear at most once.",
            });
        }

        try
        {
            var command = new UpdateCartCommand(
                body.Items.Select(i => new CartLineInput(i.ProductId!, (uint)i.Quantity)).ToList());

            return Results.Ok(await writes.ReplaceAsync(command, caller.CognitoSub!, ct));
        }
        catch (UnknownUserException)
        {
            return Results.NotFound(new { error = "unknown_user" });
        }
    }
}
