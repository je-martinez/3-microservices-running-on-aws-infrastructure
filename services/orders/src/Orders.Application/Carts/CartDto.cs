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

/// <summary>
/// One line of the cart, priced live from the catalogue. <c>UnitPrice</c> is null only for
/// an unknown product, <c>UnavailableReason</c> only when unavailable, and <c>Subtotal</c> is
/// always reported — an unavailable line is excluded from the CART totals, not its own.
/// </summary>
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

/// <summary>
/// The whole cart, fully calculated so the frontend computes nothing. <c>Id</c> is null when
/// the user has no cart — an empty cart is a 200, not a 404.
/// CONTRACT: <c>CanCheckout</c> is a hint, NOT a guarantee — another buyer may take the last
/// unit before POST /v1/orders, which is why order creation still locks stock and may 409.
/// See [[orders-service-design]]
/// </summary>
public record CartDto(
    string? Id,
    IReadOnlyList<CartLineDto> Items,
    Money Subtotal,
    Money Tax,
    Money Shipping,
    Money Total,
    bool CanCheckout);
