namespace Orders.Domain.Entities;

public class OrderDetail : AuditableEntity
{
    public string OrderId { get; set; } = string.Empty;
    public string ProductId { get; set; } = string.Empty;
    public string UserId { get; set; } = string.Empty;      // denormalized internal usr_ id
    public string CognitoSub { get; set; } = string.Empty;  // denormalized
    public uint Quantity { get; set; }
    public long SubtotalCents { get; set; }
    public long TaxCents { get; set; }
    public long TotalCents { get; set; }

    /// <summary>Product name as it was at purchase time; null on rows predating this column.</summary>
    /// <remarks>
    /// CONTRACT: An order is a receipt, so this is captured at creation and NEVER re-read
    /// from the catalogue — a later rename must not rewrite what a past order said.
    /// See [[orders-service-design]]
    /// </remarks>
    public string? ProductName { get; set; }

    /// <summary>
    /// Artwork snapshot; null for a product with no image and on rows predating this column.
    /// </summary>
    /// <remarks>
    /// CONTRACT: <c>Uri</c> stays RELATIVE to the assets base URL, exactly as on Product —
    /// the absolute form is composed on read. A persisted absolute URL is dead data once
    /// the bucket is re-minted. See [[orders-service-design]]
    /// </remarks>
    public ProductImage? ProductImage { get; set; }

    public decimal Subtotal => SubtotalCents / 100m;
    public decimal Tax => TaxCents / 100m;
    public decimal Total => TotalCents / 100m;
}
