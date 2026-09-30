using Orders.Domain.Payments;

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

    /// <summary>
    /// The client's <c>Idempotency-Key</c> for the request that created this order.
    /// CONTRACT: Unique per <see cref="UserId"/>; null on orders placed with Stripe off. A second
    /// request with the same pair returns this order instead of charging again.
    /// See [[2026-09-19-stripe-payments-design]]
    /// </summary>
    public string? IdempotencyKey { get; set; }

    /// <summary>
    /// SHA-256 hex of the canonical purchase behind <see cref="IdempotencyKey"/>.
    /// CONTRACT: A replay whose hash differs answers 422, never this order. Null on orders
    /// without a key and on rows older than the column, which replay unchecked.
    /// See [[2026-09-19-stripe-payments-design]]
    /// </summary>
    public string? IdempotencyRequestHash { get; set; }

    // Payment snapshot (see PaymentSnapshot). All null on an order placed with Stripe off,
    // and on every order predating the columns.
    public string? PaymentIntentId { get; set; }
    public string? PaymentStatus { get; set; }
    public long? AmountCents { get; set; }
    public string? Currency { get; set; }
    public string? PaymentMethodId { get; set; }
    public string? CardBrand { get; set; }
    public string? CardLast4 { get; set; }
    public int? CardExpMonth { get; set; }
    public int? CardExpYear { get; set; }
    public string? PaymentRawPayload { get; set; }

    public void ApplyPaymentSnapshot(PaymentSnapshot payment)
    {
        PaymentIntentId = payment.PaymentIntentId;
        PaymentStatus = payment.PaymentStatus;
        AmountCents = payment.AmountCents;
        Currency = payment.Currency;
        PaymentMethodId = payment.PaymentMethodId;
        CardBrand = payment.CardBrand;
        CardLast4 = payment.CardLast4;
        CardExpMonth = payment.CardExpMonth;
        CardExpYear = payment.CardExpYear;
        PaymentRawPayload = payment.PaymentRawPayload;
    }

    public decimal Subtotal => SubtotalCents / 100m;
    public decimal Tax => TaxCents / 100m;
    public decimal Shipping => ShippingCents / 100m;
    public decimal Total => TotalCents / 100m;
}
