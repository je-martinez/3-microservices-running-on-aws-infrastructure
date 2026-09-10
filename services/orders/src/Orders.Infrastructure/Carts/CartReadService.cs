using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Orders.Application.Abstractions;
using Orders.Application.Carts;
using Orders.Application.Orders;
using Orders.Domain;
using Orders.Domain.Entities;
using Orders.Infrastructure.Observability;
using Orders.Infrastructure.Persistence;

namespace Orders.Infrastructure.Carts;

/// <summary>
/// Reads the caller's active cart and renders it fully calculated.
/// CONTRACT: Enforce ownership IN the query (WHERE cognito_sub = caller), as
/// OrderReadService does — someone else's cart must simply not be found.
/// </summary>
public class CartReadService
{
    private readonly OrdersReadDbContext _db;
    private readonly IConfigurationReader _config;
    private readonly IWorkflowTracer _tracer;
    private readonly ILogger<CartReadService> _logger;
    private readonly string _assetsBaseUrl;

    public CartReadService(
        OrdersReadDbContext db,
        IConfigurationReader config,
        IWorkflowTracer tracer,
        ILogger<CartReadService> logger,
        string assetsBaseUrl)
    {
        _db = db;
        _config = config;
        _tracer = tracer;
        _logger = logger;
        // WHY: Trimmed once, so composing a URL below cannot produce a double slash.
        _assetsBaseUrl = assetsBaseUrl.TrimEnd('/');
    }

    /// <summary>The caller's cart, or an EMPTY cart when they have none.</summary>
    /// <remarks>
    /// CONTRACT: Instrument HERE, not in <see cref="BuildAsync"/> — the write path calls
    /// BuildAsync to render its own response, so a span there emits a spurious nested read
    /// inside every update_cart. See [[logging-context]]
    /// </remarks>
    public async Task<CartDto> GetMyCartAsync(string callerSub, CancellationToken ct = default) =>
        await _tracer.TraceWorkflowAsync(
            "read_cart",
            new Dictionary<string, object?>(),
            async () =>
            {
                // The soft-delete query filter makes "the active cart" simply "the cart":
                // deleted rows are already invisible to every query on this context.
                var cart = await _db.Carts.AsNoTracking()
                    .Include(c => c.Items)
                    .FirstOrDefaultAsync(c => c.CognitoSub == callerSub, ct);

                var dto = await BuildAsync(cart, ct);

                // WHY: Set from inside, so it reflects what was actually returned.
                _tracer.SetAttribute("item_count", dto.Items.Count);

                // CONTRACT: One _succeeded line, no _started twin and no _failed branch — a
                // read has no intermediate step and names no failure of its own. Emit it
                // INSIDE the activity so it carries this span's span_id, and pass item_count
                // only: LogContextEnricher already puts the identity on every line.
                // See [[logging-context]]
                _logger.LogInformation(
                    "Read the caller's cart {app_event} {item_count}",
                    "read_cart_succeeded", dto.Items.Count);

                return dto;
            });

    /// <summary>
    /// Renders a cart entity (or null, for "no cart") into its fully-calculated DTO. Public
    /// so the write path renders its response from the entity it just saved.
    /// </summary>
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
