using System.Diagnostics;
using System.Net;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using Orders.Application.Payments;
using Orders.Domain.Payments;
using Orders.Infrastructure.Observability;
using Stripe;

namespace Orders.Infrastructure.Payments;

/// <summary>
/// Charges an order's total to the buyer's saved payment method, off-session, as one confirmed
/// PaymentIntent.
/// CONTRACT: Never pass PaymentMethodTypes (dynamic payment methods stay on), and never reach
/// for the Charges, Sources or Tokens APIs. See [[2026-09-19-stripe-payments-design]]
/// </summary>
public class StripePaymentCharger
{
    public const string Currency = "usd";

    private const string Operation = "stripe.payment_intent.create";

    private const string GenericDeclineMessage =
        "Your payment could not be completed. Choose another card and try again.";

    private readonly IStripeClient? _client;
    private readonly ILogger<StripePaymentCharger> _logger;

    /// <param name="client">Null when <c>STRIPE_SECRET_KEY</c> is unset; every charge then answers 503.</param>
    /// <param name="logger">Writes the <c>payment_charged</c> / <c>payment_declined</c> flow lines.</param>
    public StripePaymentCharger(IStripeClient? client, ILogger<StripePaymentCharger> logger)
    {
        _client = client;
        _logger = logger;
    }

    /// <summary>
    /// The Stripe idempotency key for an order's charge.
    /// CONTRACT: Derived from (user id, client Idempotency-Key), never from the server-minted
    /// order id — a client retry or a concurrent duplicate must reach the SAME PaymentIntent.
    /// See [[2026-09-19-stripe-payments-design]]
    /// </summary>
    public static string ChargeIdempotencyKeyFor(string userId, string clientKey) =>
        $"order-charge-{userId}-{clientKey}";

    /// <param name="chargeIdempotencyKey">From <see cref="ChargeIdempotencyKeyFor"/>.</param>
    /// <exception cref="PaymentDeclinedException">A card error, no Stripe customer, or an unpaid intent.</exception>
    /// <exception cref="IdempotencyKeyReusedException">A replayed charge that was since refunded.</exception>
    /// <exception cref="IdempotencyKeyMismatchException">The key was first used with other parameters.</exception>
    /// <exception cref="IdempotencyKeyInFlightException">Another request with the key is still in flight.</exception>
    /// <exception cref="PaymentUnavailableException">No key configured, or any other Stripe failure.</exception>
    public async Task<PaymentSnapshot> ChargeAsync(
        string orderId,
        long amountCents,
        string? stripeCustomerId,
        string paymentMethodId,
        string chargeIdempotencyKey,
        CancellationToken ct)
    {
        if (_client is null)
        {
            throw new PaymentUnavailableException("stripe_not_configured");
        }

        // WHY: No customer means no saved card can exist, so the pm_ cannot be the caller's.
        if (stripeCustomerId is null)
        {
            throw Declined(orderId, GenericDeclineMessage, "no_saved_payment_method", "no_saved_payment_method");
        }

        var idempotencyKey = chargeIdempotencyKey;

        // CONTRACT: Ends with the `using`, on the exception paths too — a span left open is never
        // exported. Tags carry ids only: never the key, the client_secret, or a Stripe object.
        // See [[logging-context]]
        using var activity = StripeActivitySource.Source.StartActivity(Operation, ActivityKind.Client);
        activity?.SetTag("stripe.operation", Operation);
        activity?.SetTag("stripe.resource_type", "payment_intent");
        activity?.SetTag("stripe.idempotency_key", idempotencyKey);

        PaymentIntent intent;
        try
        {
            intent = await new PaymentIntentService(_client).CreateAsync(
                new PaymentIntentCreateOptions
                {
                    Amount = amountCents,
                    Currency = Currency,
                    Customer = stripeCustomerId,
                    PaymentMethod = paymentMethodId,
                    OffSession = true,
                    Confirm = true,
                    Metadata = new Dictionary<string, string> { ["order_id"] = orderId },
                    // CONTRACT: Expand latest_charge, NEVER payment_method — that needs
                    // PaymentMethods read, and Orders' restricted key must not touch saved cards.
                    // The charge carries the same brand/last4/expiry. See [[stripe-sandbox-setup]]
                    Expand = new List<string> { "latest_charge" },
                },
                new RequestOptions { IdempotencyKey = idempotencyKey },
                ct);
        }
        catch (StripeException ex) when (ex.StripeError?.Type == "card_error")
        {
            // WHY: The CLIENT call failed, so the span is ERROR; the decline itself is a business
            // outcome, so the log is WARNING. A card error's text is buyer-facing, safe to record.
            activity?.AddException(ex);
            activity?.SetStatus(ActivityStatusCode.Error, ex.StripeError.Message);
            throw Declined(
                orderId,
                ex.StripeError.Message ?? GenericDeclineMessage,
                ex.StripeError.Code ?? "card_declined",
                ex.StripeError.DeclineCode ?? ex.StripeError.Code ?? "unknown");
        }
        catch (StripeException ex) when (
            ex.StripeError?.Type == "idempotency_error" && ex.HttpStatusCode == HttpStatusCode.Conflict)
        {
            // WHY: A 409 idempotency_error is the SAME key still in flight, not a body mismatch —
            // the caller waits for that request's order instead of answering 422.
            activity?.SetStatus(ActivityStatusCode.Error, IdempotencyKeyInFlightException.InFlightReason);
            throw new IdempotencyKeyInFlightException();
        }
        catch (StripeException ex) when (ex.StripeError?.Type == "idempotency_error")
        {
            activity?.SetStatus(ActivityStatusCode.Error, "idempotency_key_mismatch");
            throw new IdempotencyKeyMismatchException();
        }
        catch (StripeException ex)
        {
            // CONTRACT: Do NOT record, surface or wrap this exception or its message — an
            // authentication error's text carries the masked key (`Invalid API Key provided:
            // rk_test_****`). The span keeps the error type only.
            var reason = ex.StripeError?.Type ?? "stripe_unreachable";
            activity?.SetStatus(ActivityStatusCode.Error, reason);
            throw new PaymentUnavailableException(reason);
        }

        activity?.SetTag("stripe.payment_intent_id", intent.Id);
        activity?.SetStatus(ActivityStatusCode.Ok);

        // CONTRACT: A replay carries the FIRST response verbatim, so its status still reads
        // "succeeded" after a refund — only the refund list tells. Never build an order on a
        // refunded charge. See [[2026-09-19-stripe-payments-design]]
        var replayed = IsReplay(intent);
        if (replayed)
        {
            activity?.SetTag("stripe.idempotent_replayed", true);
            if (await HasBeenRefundedAsync(intent.Id, activity, ct))
            {
                activity?.SetStatus(ActivityStatusCode.Error, "idempotency_key_reused");
                throw new IdempotencyKeyReusedException();
            }
        }

        // WHY: off_session + confirm resolves a card synchronously; any other status means no
        // money moved, and an order must never exist without its payment.
        if (intent.Status != "succeeded")
        {
            throw Declined(orderId, GenericDeclineMessage, "payment_not_completed", "payment_not_completed");
        }

        // WHY: A replay moved no money, so it is not a second payment_charged.
        if (!replayed)
        {
            _logger.LogInformation(
                "PaymentIntent created and charged {app_event} {order_id} {payment_intent_id}",
                "payment_charged", orderId, intent.Id);
        }

        // WHY: Null when the intent has no charge or it was not paid by card.
        var card = intent.LatestCharge?.PaymentMethodDetails?.Card;
        return new PaymentSnapshot(
            intent.Id,
            intent.Status,
            intent.Amount,
            intent.Currency,
            intent.PaymentMethodId ?? paymentMethodId,
            card?.Brand,
            card?.Last4,
            (int?)card?.ExpMonth,
            (int?)card?.ExpYear,
            RawPayloadWithoutClientSecret(intent));
    }

    /// <summary>
    /// The Stripe idempotency key for refunding a PaymentIntent.
    /// CONTRACT: Derived from the PaymentIntent id, so a retried refund replays the first one
    /// instead of refunding twice.
    /// </summary>
    public static string RefundIdempotencyKeyFor(string paymentIntentId) => $"refund-{paymentIntentId}";

    /// <summary>
    /// Refunds, in full, a charge whose order never committed. Returns whether Stripe accepted it.
    /// </summary>
    /// <remarks>
    /// CONTRACT: Never throws. The caller is already unwinding the ORIGINAL failure, and a
    /// refund error thrown here would replace it. A failed refund leaves a real dangling charge,
    /// so it is logged at ERROR with both ids. See [[2026-09-19-stripe-payments-design]]
    /// </remarks>
    public Task<bool> RefundAsync(string orderId, string paymentIntentId) =>
        RefundCoreAsync(orderId, paymentIntentId, orphan: false);

    /// <summary>
    /// Refunds, in full, a succeeded charge the Stripe webhook found with no order behind it.
    /// Returns whether the charge is now refunded; never throws.
    /// </summary>
    /// <remarks>
    /// CONTRACT: Do NOT give this path its own idempotency key — it shares
    /// <see cref="RefundIdempotencyKeyFor"/> with <see cref="RefundAsync"/>, so the webhook and
    /// the inline refund can never both refund one charge. See [[2026-09-19-stripe-payments-design]]
    /// </remarks>
    public Task<bool> RefundOrphanAsync(string orderId, string paymentIntentId) =>
        RefundCoreAsync(orderId, paymentIntentId, orphan: true);

    private async Task<bool> RefundCoreAsync(string orderId, string paymentIntentId, bool orphan)
    {
        const string operation = "stripe.refund.create";
        var idempotencyKey = RefundIdempotencyKeyFor(paymentIntentId);

        using var activity = StripeActivitySource.Source.StartActivity(operation, ActivityKind.Client);
        activity?.SetTag("stripe.operation", operation);
        activity?.SetTag("stripe.resource_type", "refund");
        activity?.SetTag("stripe.payment_intent_id", paymentIntentId);
        activity?.SetTag("stripe.idempotency_key", idempotencyKey);

        try
        {
            // WHY: CancellationToken.None — a client that disconnects mid-order must not cancel
            // the refund of a charge it already paid.
            await new RefundService(_client!).CreateAsync(
                new RefundCreateOptions
                {
                    PaymentIntent = paymentIntentId,
                    Metadata = new Dictionary<string, string> { ["order_id"] = orderId },
                },
                new RequestOptions { IdempotencyKey = idempotencyKey },
                CancellationToken.None);
        }
        catch (StripeException ex) when (ex.StripeError?.Code == "charge_already_refunded")
        {
            // WHY: Stripe keeps an idempotency key for 24 hours and retries a webhook for 3 days,
            // so a late replay meets this error instead of the cached refund. The money is back.
            activity?.SetTag("stripe.already_refunded", true);
        }
        catch (Exception)
        {
            // CONTRACT: Do NOT record or log the exception — a Stripe error's text can carry the
            // masked key. The fixed reason and both ids are what an operator needs to refund.
            activity?.SetStatus(ActivityStatusCode.Error, "refund_call_failed");
            if (orphan)
            {
                _logger.LogError(
                    "Orphan charge refund failed; the charge is left dangling {app_event} {reason} {order_id} {payment_intent_id}",
                    "payment_orphan_refunded_failed", "refund_call_failed", orderId, paymentIntentId);
            }
            else
            {
                _logger.LogError(
                    "Refund failed after a post-charge failure; the charge is left dangling {app_event} {reason} {order_id} {payment_intent_id}",
                    "payment_refunded_failed", "refund_call_failed", orderId, paymentIntentId);
            }

            return false;
        }

        activity?.SetStatus(ActivityStatusCode.Ok);
        if (orphan)
        {
            // WHY: WARNING — money moved with no order behind it, which is never routine.
            _logger.LogWarning(
                "Orphan charge refunded: no order exists for it {app_event} {order_id} {payment_intent_id}",
                "payment_orphan_refunded", orderId, paymentIntentId);
        }
        else
        {
            _logger.LogInformation(
                "Charge refunded after a post-charge failure {app_event} {order_id} {payment_intent_id}",
                "payment_refunded", orderId, paymentIntentId);
        }

        return true;
    }

    // CONTRACT: WARNING, never ERROR — a decline is the buyer's to fix, and an ERROR puts an
    // ordinary declined card on the on-call dashboard. See [[logging-context]]
    private PaymentDeclinedException Declined(string orderId, string message, string code, string reason)
    {
        _logger.LogWarning(
            "Payment declined {app_event} {reason} {order_id}",
            "payment_declined", reason, orderId);
        return new PaymentDeclinedException(message, code, reason);
    }

    private static bool IsReplay(PaymentIntent intent) =>
        intent.StripeResponse?.Headers is { } headers
        && headers.TryGetValues("Idempotent-Replayed", out var values)
        && values.Contains("true", StringComparer.OrdinalIgnoreCase);

    private async Task<bool> HasBeenRefundedAsync(string paymentIntentId, Activity? activity, CancellationToken ct)
    {
        try
        {
            var refunds = await new RefundService(_client!).ListAsync(
                new RefundListOptions { PaymentIntent = paymentIntentId, Limit = 10 }, cancellationToken: ct);
            return refunds.Data.Any(r => r.Status is "succeeded" or "pending" or "requires_action");
        }
        catch (StripeException ex)
        {
            // CONTRACT: Same rule as the charge — never surface Stripe's text. Without the answer
            // the order cannot safely be built, so this is a retryable 503.
            var reason = ex.StripeError?.Type ?? "stripe_unreachable";
            activity?.SetStatus(ActivityStatusCode.Error, reason);
            throw new PaymentUnavailableException(reason);
        }
    }

    // CONTRACT: Strip client_secret before the payload is persisted — it authorizes client-side
    // confirmation of this intent and has no business in the orders table.
    private static string RawPayloadWithoutClientSecret(PaymentIntent intent)
    {
        var payload = JsonNode.Parse(intent.StripeResponse?.Content ?? intent.ToJson())!.AsObject();
        payload.Remove("client_secret");
        return payload.ToJsonString();
    }
}
