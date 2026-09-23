using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Orders.Application.Abstractions;
using Orders.Application.Payments;
using Orders.Domain.Payments;
using Orders.Infrastructure.Observability;
using Orders.Infrastructure.Persistence;
using Stripe;

namespace Orders.Infrastructure.Payments;

/// <summary>What the webhook endpoint answers Stripe.</summary>
public enum StripeWebhookOutcome
{
    /// <summary>2xx — handled, a no-op, or an event type this webhook does not reconcile.</summary>
    Acknowledged,

    /// <summary>503 <c>stripe_unavailable</c> — no webhook secret or no API key configured.</summary>
    Unavailable,

    /// <summary>400 <c>invalid_signature</c> — nothing was dispatched.</summary>
    InvalidSignature,

    /// <summary>409 — a charge with no order, still inside the grace period; Stripe redelivers.</summary>
    OrderNotYetCommitted,

    /// <summary>503 — the orphan refund failed; Stripe redelivers and the refund is retried.</summary>
    RefundFailed,
}

/// <summary>
/// Orders' Stripe webhook: payment RECONCILIATION — orphan charges, refunds made outside the
/// app, and disputes. Never fulfillment; orders are written only by POST /v1/orders.
/// </summary>
/// <remarks>
/// CONTRACT: Every handler is idempotent on its own terms, because Stripe redelivers and
/// reorders events and there is no processed-event table. Do NOT add a handler that is not.
/// See [[2026-09-19-stripe-payments-design]]
/// </remarks>
public class StripeWebhookService
{
    private readonly OrdersWriteDbContext _db;
    private readonly StripePaymentCharger _charger;
    private readonly bool _stripeConfigured;
    private readonly StripeWebhookSettings _settings;
    private readonly IWorkflowTracer _tracer;
    private readonly ILogger<StripeWebhookService> _logger;

    /// <param name="stripeConfigured">Whether an <see cref="IStripeClient"/> exists (a key is set).</param>
    public StripeWebhookService(
        OrdersWriteDbContext db,
        StripePaymentCharger charger,
        bool stripeConfigured,
        StripeWebhookSettings settings,
        IWorkflowTracer tracer,
        ILogger<StripeWebhookService> logger)
    {
        _db = db;
        _charger = charger;
        _stripeConfigured = stripeConfigured;
        _settings = settings;
        _tracer = tracer;
        _logger = logger;
    }

    /// <param name="rawBody">The request body exactly as received — the signature covers its bytes.</param>
    /// <param name="signature">The <c>Stripe-Signature</c> header, if any.</param>
    public Task<StripeWebhookOutcome> HandleAsync(string rawBody, string? signature, CancellationToken ct) =>
        _tracer.TraceWorkflowAsync(
            "stripe_webhook",
            new Dictionary<string, object?> { ["app_event"] = "stripe_webhook_received" },
            () => HandleInternalAsync(rawBody, signature, ct));

    private async Task<StripeWebhookOutcome> HandleInternalAsync(string rawBody, string? signature, CancellationToken ct)
    {
        if (!_stripeConfigured || _settings.Secret is null)
        {
            _tracer.SetReason("stripe_unavailable");
            return StripeWebhookOutcome.Unavailable;
        }

        Event stripeEvent;
        try
        {
            // WHY: throwOnApiVersionMismatch off — the endpoint's API version is set in Stripe, not
            // here, and a mismatch would reject every delivery. Only stable fields are read below.
            stripeEvent = EventUtility.ConstructEvent(
                rawBody, signature ?? string.Empty, _settings.Secret, throwOnApiVersionMismatch: false);
        }
        catch (StripeException)
        {
            // CONTRACT: Verify BEFORE dispatching anything. Never log the signature header, the
            // raw body or Stripe's message — any of them helps forge a future delivery.
            _logger.LogWarning(
                "Stripe webhook signature verification failed {app_event} {reason}",
                "stripe_webhook_received", "signature_verification_failed");
            _tracer.SetReason("signature_verification_failed");
            return StripeWebhookOutcome.InvalidSignature;
        }

        _tracer.SetAttribute("event_type", stripeEvent.Type);
        _tracer.SetAttribute("event_id", stripeEvent.Id);
        _logger.LogInformation(
            "Stripe webhook received {app_event} {event_type} {event_id}",
            "stripe_webhook_received", stripeEvent.Type, stripeEvent.Id);

        switch (stripeEvent.Type)
        {
            case EventTypes.PaymentIntentSucceeded:
                return await ReconcileSucceededIntentAsync((PaymentIntent)stripeEvent.Data.Object, ct);
            case EventTypes.ChargeRefunded:
                var charge = (Charge)stripeEvent.Data.Object;
                return await ReconcileStatusAsync(charge.PaymentIntentId, RefundTransition(charge), ct);
            case EventTypes.ChargeDisputeCreated:
                var opened = (Dispute)stripeEvent.Data.Object;
                return await ReconcileStatusAsync(opened.PaymentIntentId, DisputeCreatedTransition, ct);
            case EventTypes.ChargeDisputeClosed:
                var closed = (Dispute)stripeEvent.Data.Object;
                return await ReconcileStatusAsync(closed.PaymentIntentId, DisputeClosedTransition(closed.Status), ct);
            default:
                return StripeWebhookOutcome.Acknowledged;
        }
    }

    // Orphan charges: a succeeded PaymentIntent carrying metadata.order_id with no order row.
    private async Task<StripeWebhookOutcome> ReconcileSucceededIntentAsync(PaymentIntent intent, CancellationToken ct)
    {
        // WHY: No order_id means Orders did not create this PaymentIntent.
        if (intent.Metadata?.GetValueOrDefault("order_id") is not { Length: > 0 } orderId)
        {
            return StripeWebhookOutcome.Acknowledged;
        }

        _tracer.SetAttribute("order_id", orderId);
        _tracer.SetAttribute("payment_intent_id", intent.Id);

        // CONTRACT: Read the WRITE database and include soft-deleted rows. A replica lagging
        // behind a just-committed order, or an order deleted since, would refund a charge that
        // does have an order.
        var hasOrder = await _db.Orders
            .IgnoreQueryFilters()
            .AsNoTracking()
            .AnyAsync(o => o.Id == orderId || o.PaymentIntentId == intent.Id, ct);
        if (hasOrder)
        {
            return StripeWebhookOutcome.Acknowledged;
        }

        // CONTRACT: Do NOT refund inside the grace period — POST /v1/orders may still be about to
        // commit this order, and refunding under it is a real double-refund race.
        if (DateTime.UtcNow - intent.Created < _settings.OrphanGracePeriod)
        {
            _tracer.SetReason("order_not_committed");
            return StripeWebhookOutcome.OrderNotYetCommitted;
        }

        if (await _charger.RefundOrphanAsync(orderId, intent.Id))
        {
            return StripeWebhookOutcome.Acknowledged;
        }

        _tracer.SetReason("refund_call_failed");
        return StripeWebhookOutcome.RefundFailed;
    }

    // Each transition returns the status to write given the current one, or null to leave it.
    // WHY: A refunded amount only grows, so a partial refund arriving after the full one is stale.
    private static Func<string?, string?> RefundTransition(Charge charge) =>
        current => charge.AmountRefunded >= charge.Amount
            ? PaymentStatuses.Refunded
            : current == PaymentStatuses.Refunded ? null : PaymentStatuses.PartiallyRefunded;

    // WHY: A charge has at most one dispute, so a created arriving after a lost close is stale.
    private static string? DisputeCreatedTransition(string? current) =>
        current == PaymentStatuses.DisputeLost ? null : PaymentStatuses.Disputed;

    // WHY: warning_closed is an inquiry that closed with no chargeback — the money stayed, as on a win.
    private static Func<string?, string?> DisputeClosedTransition(string outcome) =>
        current => outcome switch
        {
            "lost" => PaymentStatuses.DisputeLost,
            "won" or "warning_closed" when current == PaymentStatuses.Disputed => PaymentStatuses.Succeeded,
            _ => null,
        };

    private async Task<StripeWebhookOutcome> ReconcileStatusAsync(
        string? paymentIntentId, Func<string?, string?> transition, CancellationToken ct)
    {
        if (paymentIntentId is null)
        {
            return StripeWebhookOutcome.Acknowledged;
        }

        _tracer.SetAttribute("payment_intent_id", paymentIntentId);

        var order = await _db.Orders
            .IgnoreQueryFilters()
            .FirstOrDefaultAsync(o => o.PaymentIntentId == paymentIntentId, ct);
        var next = order is null ? null : transition(order.PaymentStatus);
        if (order is null || next is null || next == order.PaymentStatus)
        {
            return StripeWebhookOutcome.Acknowledged;
        }

        order.PaymentStatus = next;
        await AmbientActor.RunAsync(AuditActor.StripeWebhook, () => _db.SaveChangesAsync(ct));

        _tracer.SetAttribute("order_id", order.Id);
        _tracer.SetAttribute("payment_status", next);

        // WHY: A dispute is never routine traffic, so its transitions log at WARNING.
        var level = next is PaymentStatuses.Refunded or PaymentStatuses.PartiallyRefunded
            ? LogLevel.Information
            : LogLevel.Warning;
        _logger.Log(
            level,
            "Order payment status reconciled from Stripe {app_event} {order_id} {payment_intent_id} {payment_status}",
            "payment_status_reconciled", order.Id, paymentIntentId, next);
        return StripeWebhookOutcome.Acknowledged;
    }
}
