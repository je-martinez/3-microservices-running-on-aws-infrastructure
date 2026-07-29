namespace Orders.Domain.Entities;

public class Order : AuditableEntity
{
    public string UserId { get; set; } = string.Empty;      // internal usr_ id
    public string CognitoSub { get; set; } = string.Empty;  // from the gateway
    public long SubtotalCents { get; set; }
    public long TaxCents { get; set; }
    public long TotalCents { get; set; }

    /// <summary>
    /// Point-in-time snapshot of the delivery address, as raw JSON, resolved from
    /// Users at order-creation time.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Deliberately a snapshot, NOT a live reference to the user's profile address.
    /// If the user later edits their address, this order must still show where the
    /// shipment was actually sent — that is only possible if the order keeps its own
    /// copy taken at the moment it was created. A future reader should not "clean
    /// this up" into a shared reference: that would silently rewrite delivery
    /// history. Tracking keeps its own copy for the same reason.
    /// </para>
    /// <para>
    /// Nullable because a user may have no address on file.
    /// </para>
    /// <para>
    /// PII — never log it, and never let it reach a log line through a request/response
    /// dump. See the logging-context convention.
    /// </para>
    /// <para>
    /// Held as a JSON string rather than a typed object so Domain keeps its
    /// zero-dependency rule; the column is a real MySQL <c>json</c> column.
    /// </para>
    /// </remarks>
    public string? ShippingAddress { get; set; }

    public List<OrderDetail> Details { get; set; } = new();

    public decimal Subtotal => SubtotalCents / 100m;
    public decimal Tax => TaxCents / 100m;
    public decimal Total => TotalCents / 100m;
}
