namespace Orders.Application.Abstractions;

public interface IEventPublisher
{
    /// <summary>
    /// Emits <c>ORDER_CREATED</c> for a freshly persisted order.
    /// </summary>
    /// <param name="email">
    /// The buyer's email address — who the confirmation email goes to. REQUIRED by the
    /// events-pipeline's ORDER_CREATED payload schema
    /// (<c>functions/events-pipeline/src/handlers/order-created.ts</c>): an envelope without
    /// it is rejected as a PermanentError, recorded FAILED, and no email is ever sent. It
    /// costs nothing to supply — it rides on the same <c>GetUserById</c> response that
    /// already resolves the caller's internal id (see <c>CallerProfile.Email</c>), so this
    /// parameter adds no round trip and no new dependency.
    /// PII: implementations must never log it in plaintext (hash it instead).
    /// </param>
    /// <remarks>
    /// There is deliberately NO <c>eventId</c> parameter. The idempotency key backing the
    /// pipeline's unique index is minted INSIDE the publisher, so no call site can reuse
    /// one by accident and a retry at this layer stays a genuinely new event.
    /// </remarks>
    Task PublishOrderCreatedAsync(
        string orderId,
        string userId,
        string email,
        long totalCents,
        DateTime createdAt,
        CancellationToken ct = default);
}
