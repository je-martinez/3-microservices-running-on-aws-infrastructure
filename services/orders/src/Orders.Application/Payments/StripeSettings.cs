namespace Orders.Application.Payments;

/// <summary>
/// Whether order creation charges through Stripe (<c>STRIPE_ENABLED</c>).
/// CONTRACT: Off is the default, and off means today's behaviour exactly — no Stripe call and
/// <c>paymentMethodId</c> ignored. See [[2026-09-19-stripe-payments-design]]
/// </summary>
public sealed record StripeSettings(bool Enabled);
