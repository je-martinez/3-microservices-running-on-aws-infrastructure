namespace Orders.Domain.Entities;

public class Order : AuditableEntity
{
    public string UserId { get; set; } = string.Empty;      // internal usr_ id
    public string CognitoSub { get; set; } = string.Empty;  // from the gateway
    public long SubtotalCents { get; set; }
    public long TaxCents { get; set; }
    public long TotalCents { get; set; }

    public List<OrderDetail> Details { get; set; } = new();

    public decimal Subtotal => SubtotalCents / 100m;
    public decimal Tax => TaxCents / 100m;
    public decimal Total => TotalCents / 100m;
}
