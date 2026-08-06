namespace Orders.Domain.Entities;

public class Order : AuditableEntity
{
    /// <summary>
    /// The tag stamped on orders created by an end-to-end test run, and the one the
    /// cleanup endpoint selects on.
    /// </summary>
    /// <remarks>
    /// Byte-identical to the value the Users service writes — the space and the
    /// capitalization are part of the contract. Each service's cleanup looks for this
    /// same literal, so a drift here would leave Orders rows behind after a teardown
    /// that reported success. Lives on the entity that owns the column, so the write
    /// path (Infrastructure) and the cleanup (Api) cannot disagree about its value.
    /// </remarks>
    public const string E2eSourceTag = "E2E Source";

    public string UserId { get; set; } = string.Empty;      // internal usr_ id
    public string CognitoSub { get; set; } = string.Empty;  // from the gateway
    public long SubtotalCents { get; set; }
    public long TaxCents { get; set; }

    /// <summary>
    /// The delivery cost charged on this order, in cents. Part of
    /// <see cref="TotalCents"/> (<c>subtotal + tax + shipping</c>).
    /// </summary>
    /// <remarks>
    /// <para>
    /// An ORDER-level cost, not a per-line one: it is charged once for the shipment,
    /// not once per product. Deliberately absent from <c>OrderDetail</c> and from
    /// <c>OrderPricing.PriceLine</c> — spreading it across the lines would make each
    /// line's own total unexplainable from its unit price and quantity.
    /// </para>
    /// <para>
    /// Point-in-time, like <see cref="ShippingAddress"/>: the rate is read from the
    /// <c>configuration</c> table (key <c>shipping_cents</c>) when the order is created
    /// and then frozen onto the row, so a later rate change never rewrites what a past
    /// order actually cost.
    /// </para>
    /// </remarks>
    public long ShippingCents { get; set; }

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

    /// <summary>
    /// Free-form labels on the order. Currently only ever holds the E2E marker
    /// (<c>"E2E Source"</c>), stamped when the order is created by an end-to-end
    /// test run so the cleanup endpoint can find exactly those rows.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Never null — an order with no labels carries an empty list, so a reader never
    /// has to distinguish "no tags" from "unknown". The column is a real MySQL
    /// <c>json</c> array (MySQL 8 has no native array type the way Postgres does),
    /// mapped by a value converter in <c>OrderConfiguration</c>.
    /// </para>
    /// <para>
    /// Mirrors the Users service's <c>tags</c> column, including the literal tag value,
    /// so cleanup works identically across services.
    /// </para>
    /// </remarks>
    public List<string> Tags { get; set; } = new();

    public List<OrderDetail> Details { get; set; } = new();

    public decimal Subtotal => SubtotalCents / 100m;
    public decimal Tax => TaxCents / 100m;
    public decimal Shipping => ShippingCents / 100m;
    public decimal Total => TotalCents / 100m;
}
