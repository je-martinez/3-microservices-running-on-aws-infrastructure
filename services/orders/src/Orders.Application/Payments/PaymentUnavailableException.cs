namespace Orders.Application.Payments;

/// <summary>
/// Stripe cannot be used right now — no key configured, or a Stripe failure that is not a card
/// error; the endpoint answers 503.
/// CONTRACT: Never wrap the StripeException as InnerException — an authentication error's
/// message carries a masked key, and the workflow span records the whole exception chain.
/// </summary>
public class PaymentUnavailableException : Exception
{
    public PaymentUnavailableException(string reason)
        : base("Payments are temporarily unavailable.") => Reason = reason;

    /// <summary>A stable, non-sensitive cause: <c>stripe_not_configured</c> or a Stripe error type.</summary>
    public string Reason { get; }
}
