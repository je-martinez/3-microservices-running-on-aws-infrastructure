namespace Orders.Domain.Payments;

/// <summary>
/// The charge behind an order, frozen at the moment it was taken.
/// CONTRACT: Denormalized on purpose — an order is a historical document and never joins
/// against the buyer's live saved cards. <see cref="PaymentRawPayload"/> is the PaymentIntent
/// JSON minus its <c>client_secret</c>. See [[2026-09-19-stripe-payments-design]]
/// </summary>
public sealed record PaymentSnapshot(
    string PaymentIntentId,
    string PaymentStatus,
    long AmountCents,
    string Currency,
    string PaymentMethodId,
    string? CardBrand,
    string? CardLast4,
    int? CardExpMonth,
    int? CardExpYear,
    string PaymentRawPayload);
