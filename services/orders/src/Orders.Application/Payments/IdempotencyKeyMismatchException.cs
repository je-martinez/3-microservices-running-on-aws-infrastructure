namespace Orders.Application.Payments;

/// <summary>
/// The client's <c>Idempotency-Key</c> was first used with a different request body; the
/// endpoint answers 422.
/// </summary>
public class IdempotencyKeyMismatchException : Exception
{
    public IdempotencyKeyMismatchException()
        : base("This Idempotency-Key was already used with a different request body.") { }
}
