namespace Orders.Domain.Payments;

/// <summary>
/// The values <c>Order.PaymentStatus</c> takes. <see cref="Succeeded"/> is written by order
/// creation (Stripe's own PaymentIntent status); the rest only by the Stripe webhook.
/// See [[2026-09-19-stripe-payments-design]]
/// </summary>
public static class PaymentStatuses
{
    public const string Succeeded = "succeeded";
    public const string PartiallyRefunded = "partially_refunded";
    public const string Refunded = "refunded";
    public const string Disputed = "disputed";
    public const string DisputeLost = "dispute_lost";
}
