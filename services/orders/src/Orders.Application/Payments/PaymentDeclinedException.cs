namespace Orders.Application.Payments;

/// <summary>
/// The buyer's payment method did not pay for the order; the endpoint answers 402.
/// CONTRACT: <see cref="Exception.Message"/> reaches the buyer verbatim, so it is Stripe's
/// card-error message or a fixed sentence — never the message of any other Stripe error type.
/// </summary>
public class PaymentDeclinedException : Exception
{
    public PaymentDeclinedException(string message, string code, string reason)
        : base(message)
    {
        Code = code;
        Reason = reason;
    }

    /// <summary>Stripe's error <c>code</c> (e.g. <c>card_declined</c>), or a local one.</summary>
    public string Code { get; }

    /// <summary>
    /// The telemetry <c>reason</c>: Stripe's <c>decline_code</c> when present, else <see cref="Code"/>.
    /// CONTRACT: Logs and spans only — never the response. Some decline codes
    /// (<c>stolen_card</c>, <c>fraudulent</c>) must not be shown to the buyer.
    /// </summary>
    public string Reason { get; }
}
