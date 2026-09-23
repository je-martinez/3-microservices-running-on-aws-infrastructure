namespace Orders.Application.Payments;

/// <summary>
/// The client's <c>Idempotency-Key</c> belongs to a charge that was already refunded, so no order
/// can be created under it; the endpoint answers 409 and the client must retry with a new key.
/// </summary>
public class IdempotencyKeyReusedException : Exception
{
    public IdempotencyKeyReusedException()
        : base("This Idempotency-Key belongs to a payment that was refunded. Retry with a new key.") { }
}
