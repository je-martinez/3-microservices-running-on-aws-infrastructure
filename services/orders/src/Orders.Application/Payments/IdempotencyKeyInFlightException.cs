namespace Orders.Application.Payments;

/// <summary>
/// Stripe answered 409 <c>idempotency_error</c>: another request with the same charge key is
/// still in flight. The endpoint answers 503 with <c>Retry-After</c> unless that request's order
/// appears first.
/// </summary>
public class IdempotencyKeyInFlightException : PaymentUnavailableException
{
    public const string InFlightReason = "idempotency_key_in_flight";

    public IdempotencyKeyInFlightException()
        : base(InFlightReason) { }
}
