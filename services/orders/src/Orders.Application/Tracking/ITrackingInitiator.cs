namespace Orders.Application.Tracking;

/// <summary>
/// Port for initiating a delivery tracking record on the Tracking service, called
/// after an order has been created.
/// </summary>
/// <remarks>
/// <para>
/// Application owns this interface; the HTTP implementation lives in
/// Orders.Infrastructure (mirrors <c>IUserDirectory</c> / <c>UserDirectoryGrpcClient</c>).
/// </para>
/// <para>
/// <b>This port never throws for a downstream failure.</b> Every outcome — success,
/// already-tracked, unresolvable caller, transport error — is returned as a
/// <see cref="TrackingInitResult"/> value so the caller decides what it means rather
/// than using exceptions for control flow. See <see cref="TrackingInitOutcome"/> for
/// the rationale behind treating a tracking failure as non-fatal to the order.
/// </para>
/// </remarks>
public interface ITrackingInitiator
{
    /// <summary>
    /// Asks Tracking to create a tracking record for a just-created order.
    /// </summary>
    /// <param name="orderId">The <c>ord_</c> id of the order being tracked.</param>
    /// <param name="shippingAddressJson">
    /// The order's point-in-time address snapshot, already serialized as JSON exactly as
    /// it is persisted on <c>Order.ShippingAddress</c>, or <c>null</c> when the user has
    /// no address on file. Taking the raw JSON (rather than a typed address) keeps this
    /// seam identical to what the entity stores, so the caller passes the column value
    /// straight through with no re-shaping and no risk of the two copies diverging.
    /// PII — never logged.
    /// </param>
    /// <param name="cognitoSub">
    /// The caller's Cognito sub, exactly as Orders received it from the gateway in
    /// <c>x-user-id</c>. It is forwarded as a header, never placed in the body: Tracking
    /// resolves the internal user id itself.
    /// </param>
    /// <param name="testMode">
    /// Forwarded as the <c>x-test-mode</c> header. The caller is responsible for the
    /// <c>E2E_TESTING_ENABLED</c> guard; this client just transmits the boolean.
    /// </param>
    /// <param name="e2eSource">
    /// Forwarded as the <c>x-e2e-source</c> header, so Tracking tags its own record the way
    /// Orders tags the order and each service's cleanup can find its rows by tag. Same
    /// guard responsibility as <paramref name="testMode"/>: the caller applies
    /// <c>E2E_TESTING_ENABLED</c>, this client only transmits.
    /// </param>
    Task<TrackingInitResult> InitTrackingAsync(
        string orderId,
        string? shippingAddressJson,
        string cognitoSub,
        bool testMode,
        bool e2eSource = false,
        CancellationToken ct = default);
}
