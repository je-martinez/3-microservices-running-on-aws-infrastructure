namespace Orders.Infrastructure.Payments;

/// <summary>
/// The metadata Orders writes on every Stripe object it creates: the order, and who paid for it.
/// </summary>
/// <remarks>
/// CONTRACT: Every refund of a PaymentIntent builds its metadata from THAT intent's values
/// through <see cref="ToStripe"/>, in one fixed key order. The inline and the webhook refund
/// share one idempotency key, and Stripe answers a repeat with different parameters with 400
/// <c>idempotency_error</c> — the orphan refund then fails on every delivery.
/// WARNING: An unknown identity is OMITTED, never sent as <c>""</c>. See [[logging-context]]
/// </remarks>
public sealed record PaymentMetadata(string OrderId, string? UserId, string? CognitoSub)
{
    public const string OrderIdKey = "order_id";
    public const string UserIdKey = "user_id";
    public const string CognitoSubKey = "cognito_sub";

    /// <summary>
    /// The identity a PaymentIntent carries, read back from Stripe. Keys it never had (a
    /// PaymentIntent created before they existed) stay absent; unrelated keys are ignored.
    /// </summary>
    public static PaymentMetadata FromStripe(string orderId, IReadOnlyDictionary<string, string>? metadata) =>
        new(orderId, metadata?.GetValueOrDefault(UserIdKey), metadata?.GetValueOrDefault(CognitoSubKey));

    public Dictionary<string, string> ToStripe()
    {
        var metadata = new Dictionary<string, string> { [OrderIdKey] = OrderId };
        if (!string.IsNullOrWhiteSpace(UserId))
        {
            metadata[UserIdKey] = UserId;
        }

        if (!string.IsNullOrWhiteSpace(CognitoSub))
        {
            metadata[CognitoSubKey] = CognitoSub;
        }

        return metadata;
    }
}
