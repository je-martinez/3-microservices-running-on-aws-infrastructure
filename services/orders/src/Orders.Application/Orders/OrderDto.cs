using Orders.Domain;

namespace Orders.Application.Orders;

/// <param name="Name">Name AS PURCHASED; null on lines predating the capture.</param>
/// <param name="Image">
/// CONTRACT: Purchase-time artwork, ABSOLUTE Uri composed on read. Never re-read from
/// the catalogue — an order is a receipt. Null when the product had none.
/// See [[orders-service-design]]
/// </param>
public record OrderLineDto(
    string ProductId,
    string? Name,
    uint Quantity,
    Money Subtotal,
    Money Tax,
    Money Total,
    ProductImageDto? Image);

public record OrderDto(
    string Id,
    // CONTRACT: The customer-facing label, null on rows predating the backfill. `Id` remains
    // the identifier every other contract references — do NOT swap them, and do not build
    // the displayed form client-side. See [[friendly-order-number]]
    OrderNumberDto? OrderNumber,
    string UserId,
    string CognitoSub,
    Money Subtotal,
    Money Tax,
    // Order-level, not per-line: charged once per shipment, which is why
    // OrderLineDto has no counterpart. Exposed so a client can show the same
    // breakdown the confirmation email prints — without it, Total is
    // unexplainable from the other figures a caller can see.
    Money Shipping,
    Money Total,
    DateTime CreatedAt,
    IReadOnlyList<OrderLineDto> Lines);
