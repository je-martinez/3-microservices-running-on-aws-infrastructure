using Orders.Application.Orders;
using Orders.Domain;
using Orders.Domain.Entities;

namespace Orders.Infrastructure.Orders;

/// <summary>Maps a persisted order line to its wire shape.</summary>
/// <remarks>
/// CONTRACT: The ONE mapping used by both CreateOrderService and OrderReadService. Do
/// not inline it back: two hand-written copies let a created order and the same order
/// re-read disagree. See [[orders-service-design]]
/// </remarks>
internal static class OrderLineMapper
{
    /// <param name="assetsBaseUrl">
    /// Assets base URL, already trimmed of a trailing slash. Rows store a bucket key
    /// relative to it, so the absolute URL is composed here and never persisted.
    /// </param>
    internal static OrderLineDto Map(OrderDetail d, string assetsBaseUrl) => new(
        d.ProductId,
        d.ProductName,
        d.Quantity,
        Money.FromCents(d.SubtotalCents),
        Money.FromCents(d.TaxCents),
        Money.FromCents(d.TotalCents),
        d.ProductImage is null
            ? null
            : new ProductImageDto(
                $"{assetsBaseUrl}/{d.ProductImage.Uri}",
                d.ProductImage.Width,
                d.ProductImage.Height,
                d.ProductImage.Blurhash));
}
