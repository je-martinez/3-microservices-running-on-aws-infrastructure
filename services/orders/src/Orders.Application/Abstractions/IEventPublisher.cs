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
    /// <param name="cognitoSub">
    /// The buyer's Cognito <c>sub</c> — the identity the request arrived with, and the same
    /// value stamped onto the order row. It travels in the envelope's <c>author</c> block,
    /// which records WHO ORIGINATED the event as opposed to the root <c>user_id</c>, which
    /// records who it is ABOUT. On this event they are the same person (the buyer places
    /// their own order); on TRACKING_STATUS_CHANGED there is no human author at all, which
    /// is why the two are separate fields.
    /// <para>
    /// Nullable so the author can OMIT it rather than send <c>null</c>: an absent sub must
    /// not appear in the JSON at all. Every current call site supplies one — order creation
    /// cannot happen without an authenticated caller — so in practice it is always present.
    /// </para>
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
        string? cognitoSub = null,
        CancellationToken ct = default);
}
