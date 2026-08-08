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
    /// <param name="fullName">
    /// The buyer's display name — who the confirmation email greets, and the name its
    /// receipt is billed to. Like <paramref name="email"/> it rides on the <c>GetUserById</c>
    /// response order creation already makes (<c>CallerProfile.FullName</c>), so it costs no
    /// round trip; it travels rather than being looked up by the consumer because the
    /// pipeline has no access to Users' database and no identity to call it with.
    /// <para>
    /// Not nullable, and <c>""</c> is a legitimate value: proto3 gives no null for a user
    /// with no name on file. The key is always emitted so the payload's shape never varies —
    /// a template that greets no one is a cosmetic loss, whereas a missing key would fail
    /// the consumer's schema and cost the buyer the whole email.
    /// </para>
    /// PII: implementations must never log it, exactly like <paramref name="email"/>.
    /// </param>
    /// <param name="subtotalCents">
    /// The order's pre-tax, pre-shipping line total. Sent alongside
    /// <paramref name="taxCents"/>, <paramref name="shippingCents"/> and
    /// <paramref name="totalCents"/> because the email is now an itemised RECEIPT rather
    /// than a bare confirmation: it prints Subtotal / Shipping / Tax / Total, and a reader
    /// checks that arithmetic. The consumer must never derive one of the four from the
    /// others — the split is computed once, here, by the code that priced the order.
    /// </param>
    /// <param name="taxCents">
    /// The tax charged on the order, summed across its lines at the rate in force when it
    /// was placed. Part of the same receipt breakdown as <paramref name="subtotalCents"/>.
    /// </param>
    /// <param name="shippingCents">
    /// The flat delivery charge, applied once per shipment. It travels as its own figure
    /// because the receipt shows it as its own row, and because it is the component that
    /// makes <paramref name="totalCents"/> exceed <c>subtotal + tax</c> — omitting it would
    /// leave the email showing a total its own visible rows do not add up to.
    /// </param>
    /// <param name="shippingAddress">
    /// Where the shipment is going, as the JSON snapshot persisted on the order, or
    /// <c>null</c> when the buyer has no address on file.
    /// <para>
    /// Nullable so implementations OMIT the key rather than send <c>null</c> — the same rule
    /// the <c>author</c> block's optional identities follow. An absent address must not
    /// appear in the JSON at all.
    /// </para>
    /// PII: never log it, and never let it reach a log line through an exception.
    /// </param>
    /// <param name="items">
    /// The receipt's line items — one per product on the order, after duplicate lines are
    /// consolidated.
    /// <para>
    /// This is the only argument that is not a field copy, and the reason it exists at all is
    /// that <c>OrderDetail</c> stores <c>ProductId</c>, NOT the product's name. The consumer
    /// cannot resolve one into the other: it holds no connection to the Orders database, so
    /// an id it received would render on the customer's receipt verbatim. The NAME therefore
    /// has to be carried by the event itself.
    /// </para>
    /// <para>
    /// The caller assembles it from the <c>Product</c> entities its pricing loop has already
    /// loaded, which is what keeps this free: no extra query, and no denormalized name column
    /// on <c>OrderDetail</c> to keep in sync with the catalogue.
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
        string fullName,
        long subtotalCents,
        long taxCents,
        long shippingCents,
        long totalCents,
        string? shippingAddress,
        IReadOnlyList<OrderCreatedItem> items,
        DateTime createdAt,
        string? cognitoSub = null,
        CancellationToken ct = default);
}
