using Microsoft.EntityFrameworkCore;
using Orders.Application.Abstractions;
using Orders.Application.Carts;
using Orders.Application.Orders;
using Orders.Domain;
using Orders.Domain.Entities;
using Orders.Infrastructure.Persistence;

namespace Orders.Infrastructure.Carts;

/// <summary>
/// Reads the caller's active cart and renders it fully calculated.
/// </summary>
/// <remarks>
/// <para>
/// Ownership is enforced IN the query (WHERE cognito_sub = caller), the same way
/// OrderReadService does it — a cart belonging to someone else simply is not found.
/// </para>
/// <para>
/// Lives in Infrastructure because it depends on OrdersReadDbContext; Application must
/// not reference EF Core.
/// </para>
/// </remarks>
public class CartReadService
{
    private readonly OrdersReadDbContext _db;
    private readonly IConfigurationReader _config;
    private readonly string _assetsBaseUrl;

    public CartReadService(OrdersReadDbContext db, IConfigurationReader config, string assetsBaseUrl)
    {
        _db = db;
        _config = config;
        // Trimmed once here so composing a URL below is a plain concatenation and can
        // never produce a double slash — same treatment as ProductReadService.
        _assetsBaseUrl = assetsBaseUrl.TrimEnd('/');
    }

    /// <summary>The caller's cart, or an EMPTY cart when they have none.</summary>
    public async Task<CartDto> GetMyCartAsync(string callerSub, CancellationToken ct = default)
    {
        // The soft-delete query filter makes "the active cart" simply "the cart":
        // deleted rows are already invisible to every query on this context.
        var cart = await _db.Carts.AsNoTracking()
            .Include(c => c.Items)
            .FirstOrDefaultAsync(c => c.CognitoSub == callerSub, ct);

        return await BuildAsync(cart, ct);
    }

    /// <summary>
    /// Renders a cart entity (or null, for "no cart") into its fully-calculated DTO.
    /// </summary>
    /// <remarks>
    /// Public so the write path can render its own response from the entity it just
    /// saved, instead of issuing a second read for state it already holds.
    /// </remarks>
    public async Task<CartDto> BuildAsync(Cart? cart, CancellationToken ct = default)
    {
        var taxRate = await _config.GetTaxRateAsync(ct);
        var shippingCents = await _config.GetShippingCentsAsync(ct);

        // `.Where(i => !i.IsDeleted)` is NOT redundant with the soft-delete query filter.
        // The filter applies to rows LOADED from the database; the write path calls this
        // with an entity it is still tracking, whose removed lines are in memory with
        // DeletedAt already set. Without this, a PUT that dropped a line would answer
        // with that line still in the cart — the deletion would look like it failed.
        var items = cart?.Items.Where(i => !i.IsDeleted).ToList() ?? [];

        // ONE catalogue query for every product in the cart. A per-line lookup here
        // would turn a ten-item cart into eleven round trips on a hot read path.
        // A List, not an array: EF Core's parameter funcletizer mis-compiles a captured
        // string[]'s Contains closure on this runtime (throws inside the LINQ
        // expression interpreter before any SQL is generated) — List<string>.Contains
        // takes a different, working translation path.
        var productIds = items.Select(i => i.ProductId).Distinct().ToList();
        var products = productIds.Count == 0
            ? new Dictionary<string, Product>()
            : await _db.Products.AsNoTracking()
                .Where(p => productIds.Contains(p.Id))
                .ToDictionaryAsync(p => p.Id, ct);

        var lines = items.Select(item => BuildLine(item, products)).ToList();

        var totals = CartPricing.Totalize(lines, taxRate, shippingCents);

        return new CartDto(
            cart?.Id,
            lines,
            totals.Subtotal,
            totals.Tax,
            totals.Shipping,
            totals.Total,
            totals.CanCheckout);
    }

    private CartLineDto BuildLine(CartItem item, IReadOnlyDictionary<string, Product> products)
    {
        // The product is gone (deleted, or never existed). Nothing to price and nothing
        // to show but the id and the quantity the user asked for.
        if (!products.TryGetValue(item.ProductId, out var product))
        {
            return new CartLineDto(
                item.ProductId,
                Name: null,
                item.Quantity,
                UnitsInStock: 0,
                Available: false,
                UnitPrice: null,
                Subtotal: null,
                Image: null,
                UnavailableReason: UnavailableReason.UnknownProduct);
        }

        // Ordered most-specific-first: zero stock is "out of stock", not "insufficient".
        // Reversing these would report every empty product as insufficient_stock and the
        // frontend could not distinguish "gone for now" from "you asked for too many".
        string? reason = product.UnitsInStock == 0
            ? UnavailableReason.OutOfStock
            : product.UnitsInStock < item.Quantity
                ? UnavailableReason.InsufficientStock
                : null;

        return new CartLineDto(
            item.ProductId,
            product.Name,
            item.Quantity,
            product.UnitsInStock,
            Available: reason is null,
            // Priced even when unavailable: the line still reports what it WOULD cost so
            // the frontend renders it normally with a badge. Exclusion happens at the
            // CART level, in CartPricing.
            Money.FromCents(product.UnitPriceCents),
            Money.FromCents(product.UnitPriceCents * item.Quantity),
            product.Image is null
                ? null
                // Absolute URL composed on read from ASSETS_BASE_URL. Rows store a bucket
                // key relative to it — Floci re-mints the bucket on every apply, so a
                // persisted absolute URL would be dead data after the next rebuild.
                : new ProductImageDto(
                    $"{_assetsBaseUrl}/{product.Image.Uri}",
                    product.Image.Width,
                    product.Image.Height,
                    product.Image.Blurhash),
            reason);
    }
}
