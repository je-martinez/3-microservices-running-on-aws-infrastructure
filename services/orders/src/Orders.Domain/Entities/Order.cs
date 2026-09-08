namespace Orders.Domain.Entities;

public class Order : AuditableEntity
{
    /// <summary>
    /// The tag stamped on orders from an E2E run, and the one cleanup selects on.
    /// CONTRACT: Byte-identical to the value Users writes — the space and capitalization
    /// included. A drift leaves rows behind after a teardown that reported success.
    /// See [[testing]]
    /// </summary>
    public const string E2eSourceTag = "E2E Source";

    /// <summary>
    /// Customer-facing order number, canonical form: <c>2609078KJ4M2</c>.
    /// CONTRACT: A LABEL, not an identifier — never join on it or log it. Null only on rows
    /// predating the backfill. See [[friendly-order-number]]
    /// </summary>
    public string? OrderNumber { get; set; }

    public string UserId { get; set; } = string.Empty;      // internal usr_ id
    public string CognitoSub { get; set; } = string.Empty;  // from the gateway
    public long SubtotalCents { get; set; }
    public long TaxCents { get; set; }

    /// <summary>
    /// The delivery cost on this order, in cents; part of <see cref="TotalCents"/>.
    /// CONTRACT: An ORDER-level cost, charged once per shipment. Keep it out of
    /// <c>OrderDetail</c> and <c>OrderPricing.PriceLine</c> — spread across lines, a line's
    /// total stops being explainable from its unit price and quantity.
    /// See [[money-representation]]
    /// </summary>
    public long ShippingCents { get; set; }

    public long TotalCents { get; set; }

    /// <summary>
    /// Point-in-time snapshot of the delivery address, as raw JSON.
    /// CONTRACT: Do NOT "clean this up" into a live reference to the profile address — a
    /// later edit would silently rewrite where past shipments were sent. PII: never log it,
    /// and never let a request/response dump carry it. See [[logging-context]]
    /// </summary>
    public string? ShippingAddress { get; set; }

    /// <summary>
    /// Free-form labels; today only the E2E marker, so cleanup can find those rows.
    /// CONTRACT: Never null — an empty list, so a reader never distinguishes "no tags" from
    /// "unknown". A MySQL <c>json</c> array mapped by a converter in
    /// <c>OrderConfiguration</c>. See [[testing]]
    /// </summary>
    public List<string> Tags { get; set; } = new();

    public List<OrderDetail> Details { get; set; } = new();

    public decimal Subtotal => SubtotalCents / 100m;
    public decimal Tax => TaxCents / 100m;
    public decimal Shipping => ShippingCents / 100m;
    public decimal Total => TotalCents / 100m;
}
