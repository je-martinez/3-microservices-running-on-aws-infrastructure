namespace Orders.Application.Payments;

/// <summary>
/// Configuration for Orders' Stripe webhook.
/// </summary>
/// <param name="Secret">
/// <c>STRIPE_WEBHOOK_SECRET</c>; null when unset or blank, and the webhook then answers 503.
/// CONTRACT: Never log it or put it on a span. See [[2026-09-19-stripe-payments-design]]
/// </param>
/// <param name="OrphanGracePeriod">
/// <c>STRIPE_ORPHAN_GRACE_PERIOD_SECONDS</c> (default 600). A charge with no order younger
/// than this is left for Stripe to redeliver, not refunded.
/// </param>
public sealed record StripeWebhookSettings(string? Secret, TimeSpan OrphanGracePeriod)
{
    public const int DefaultOrphanGracePeriodSeconds = 600;
}
