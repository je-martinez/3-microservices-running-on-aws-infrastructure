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

    public decimal Subtotal => SubtotalCents / 100m;
    public decimal Tax => TaxCents / 100m;
    public decimal Total => TotalCents / 100m;
}
