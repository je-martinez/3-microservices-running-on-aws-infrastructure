using Orders.Application.Orders;
using Orders.Domain;

namespace Orders.Application.Carts;

/// <summary>Why a cart line cannot currently be bought.</summary>
/// <remarks>
/// Serialized as the snake_case strings the API contract names. Absent — never null —
/// when the line IS available, per the omit-unknown-fields convention.
/// </remarks>
public static class UnavailableReason
{
    /// <summary>The product no longer exists in the catalogue (or was deleted).</summary>
    public const string UnknownProduct = "unknown_product";

    /// <summary>The product exists but has no units at all.</summary>
    public const string OutOfStock = "out_of_stock";

    /// <summary>Some units remain, but fewer than the line asks for.</summary>
    public const string InsufficientStock = "insufficient_stock";
}

/// <summary>One line of the cart, priced live from the catalogue.</summary>
/// <param name="UnitPrice">
/// Null only for <see cref="UnavailableReason.UnknownProduct"/> — there is no catalogue
/// row left to read a price from.
/// </param>
/// <param name="Subtotal">
/// What this line WOULD cost (unit price × quantity). Always reported, even when the line
/// is unavailable, so the frontend can render it normally with an unavailable badge. An
/// unavailable line is excluded from the CART totals, not from its own.
/// </param>
/// <param name="UnavailableReason">Omitted when <paramref name="Available"/> is true.</param>
public record CartLineDto(
    string ProductId,
    string? Name,
    uint Quantity,
    uint UnitsInStock,
    bool Available,
    Money? UnitPrice,
    Money? Subtotal,
    ProductImageDto? Image,
    string? UnavailableReason);

/// <summary>The whole cart, fully calculated so the frontend computes nothing.</summary>
/// <param name="Id">Null when the user has no cart — an empty cart is a 200, not a 404.</param>
/// <param name="CanCheckout">
/// True only when there is at least one line and EVERY line is available. A hint for
/// enabling the checkout button — NOT a guarantee: another buyer may take the last unit
/// between this read and POST /v1/orders, which is why order creation still locks stock
/// with SELECT ... FOR UPDATE and may return 409.
/// </param>
public record CartDto(
    string? Id,
    IReadOnlyList<CartLineDto> Items,
    Money Subtotal,
    Money Tax,
    Money Shipping,
    Money Total,
    bool CanCheckout);
