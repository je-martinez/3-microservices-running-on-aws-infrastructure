namespace Orders.Application.Tracking;

/// <summary>
/// Port for initiating a delivery tracking record, called after an order is created.
/// CONTRACT: Never throw for a downstream failure — every outcome is returned as a
/// <see cref="TrackingInitResult"/>, so a tracking hiccup cannot escape as an exception and
/// fail an order that already committed. See [[orders-service-design]]
/// </summary>
public interface ITrackingInitiator
{
    /// <summary>
    /// Asks Tracking to create a tracking record for a just-created order.
    /// CONTRACT: <paramref name="shippingAddressJson"/> is the RAW JSON persisted on
    /// <c>Order.ShippingAddress</c>, not a typed address, so the two copies cannot diverge.
    /// It is PII and is never logged. <paramref name="cognitoSub"/> travels as a header, not
    /// in the body — Tracking resolves the internal id itself.
    /// CONTRACT: <paramref name="orderNumber"/> is the CANONICAL form; Tracking stores it so
    /// its own status emails can print it. See [[friendly-order-number]]
    /// CONTRACT: The CALLER owns the <c>E2E_TESTING_ENABLED</c> guard for
    /// <paramref name="testMode"/> and <paramref name="e2eSource"/>; this client only
    /// transmits them as <c>x-test-mode</c> and <c>x-e2e-source</c>. See [[testing]]
    /// </summary>
    Task<TrackingInitResult> InitTrackingAsync(
        string orderId,
        string? orderNumber,
        string? shippingAddressJson,
        string cognitoSub,
        bool testMode,
        bool e2eSource = false,
        CancellationToken ct = default);
}
