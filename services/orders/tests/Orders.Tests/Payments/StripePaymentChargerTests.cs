using System.Diagnostics;
using Microsoft.Extensions.Logging;
using Orders.Application.Payments;
using Orders.Infrastructure.Id;
using Orders.Infrastructure.Observability;
using Orders.Infrastructure.Payments;
using Orders.Tests.Observability;

namespace Orders.Tests.Payments;

/// <summary>
/// The Stripe charge's CLIENT span and its flow logs.
/// CONTRACT: Spans are matched by this test's own idempotency key — the listener is
/// process-wide and API tests running in parallel emit orders-stripe spans too.
/// See [[2026-09-19-stripe-payments-design]]
/// </summary>
public sealed class StripePaymentChargerTests : IDisposable
{
    private const string CustomerId = "cus_test";
    private const long AmountCents = 4250;
    private const string UserId = "usr_test";
    private const string CognitoSub = "sub-test";

    private readonly List<Activity> _stopped = new();
    private readonly ActivityListener _listener;
    private readonly SpanScopedLogger<StripePaymentCharger> _logger = new();
    private readonly string _orderId = NanoId.NewId(NanoId.OrderPrefix);

    public StripePaymentChargerTests()
    {
        _listener = new ActivityListener
        {
            ShouldListenTo = s => s.Name == StripeActivitySource.Name,
            Sample = (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllData,
            ActivityStopped = a => { lock (_stopped) { _stopped.Add(a); } },
        };
        ActivitySource.AddActivityListener(_listener);
    }

    public void Dispose() => _listener.Dispose();

    [Fact]
    public async Task A_successful_charge_opens_a_client_span_and_logs_payment_charged_inside_it()
    {
        var charger = ChargerOver(FakeStripeHandler.Succeeding());

        var snapshot = await ChargeAsync(charger);

        var span = ThisChargesSpan();
        Assert.Equal("stripe.payment_intent.create", span.DisplayName);
        Assert.Equal(ActivityKind.Client, span.Kind);
        Assert.Equal(ActivityStatusCode.Ok, span.Status);
        Assert.Equal("stripe.payment_intent.create", span.GetTagItem("stripe.operation"));
        Assert.Equal("payment_intent", span.GetTagItem("stripe.resource_type"));
        Assert.Equal(FakeStripeHandler.PaymentIntentId, span.GetTagItem("stripe.payment_intent_id"));

        var line = Assert.Single(_logger.Entries);
        Assert.Equal(LogLevel.Information, line.Level);
        Assert.Equal("payment_charged", line.Values["app_event"]);
        Assert.Equal(_orderId, line.Values["order_id"]);
        Assert.Equal(snapshot.PaymentIntentId, line.Values["payment_intent_id"]);
        Assert.Same(span, line.Activity);
    }

    [Fact]
    public async Task The_snapshot_takes_its_card_fields_from_the_latest_charge()
    {
        var snapshot = await ChargeAsync(ChargerOver(FakeStripeHandler.Succeeding()));

        Assert.Equal(FakeStripeHandler.PaymentMethodId, snapshot.PaymentMethodId);
        Assert.Equal(FakeStripeHandler.ChargeCardBrand, snapshot.CardBrand);
        Assert.Equal(FakeStripeHandler.ChargeCardLast4, snapshot.CardLast4);
        Assert.Equal(FakeStripeHandler.ChargeCardExpMonth, snapshot.CardExpMonth);
        Assert.Equal(FakeStripeHandler.ChargeCardExpYear, snapshot.CardExpYear);
        Assert.Contains(FakeStripeHandler.ChargeId, snapshot.PaymentRawPayload);
        Assert.DoesNotContain("client_secret", snapshot.PaymentRawPayload);
    }

    [Fact]
    public async Task Without_a_latest_charge_the_card_fields_stay_null()
    {
        var snapshot = await ChargeAsync(ChargerOver(FakeStripeHandler.Succeeding(withLatestCharge: false)));

        Assert.Equal(FakeStripeHandler.PaymentIntentId, snapshot.PaymentIntentId);
        Assert.Null(snapshot.CardBrand);
        Assert.Null(snapshot.CardLast4);
        Assert.Null(snapshot.CardExpMonth);
        Assert.Null(snapshot.CardExpYear);
    }

    [Fact]
    public async Task No_span_tag_or_log_value_carries_the_client_secret_or_the_raw_payload()
    {
        var charger = ChargerOver(FakeStripeHandler.Succeeding());

        await ChargeAsync(charger);

        var span = ThisChargesSpan();
        Assert.DoesNotContain(span.Tags, t => t.Key.Contains("client_secret") || t.Key.Contains("raw_payload"));
        Assert.DoesNotContain(span.Tags, t => t.Value?.Contains(FakeStripeHandler.ClientSecret) == true);
        Assert.DoesNotContain(
            _logger.Entries.SelectMany(e => e.Values.Values),
            v => v?.ToString()?.Contains(FakeStripeHandler.ClientSecret) == true);
    }

    [Fact]
    public async Task A_decline_logs_payment_declined_at_warning_with_the_decline_code_as_reason()
    {
        var charger = ChargerOver(FakeStripeHandler.Declining("insufficient_funds"));

        var declined = await Assert.ThrowsAsync<PaymentDeclinedException>(() => ChargeAsync(charger));

        Assert.Equal("insufficient_funds", declined.Reason);
        var line = Assert.Single(_logger.Entries);
        Assert.Equal(LogLevel.Warning, line.Level);
        Assert.Equal("payment_declined", line.Values["app_event"]);
        Assert.Equal("insufficient_funds", line.Values["reason"]);
        Assert.Equal(_orderId, line.Values["order_id"]);
        Assert.DoesNotContain(_logger.Entries, e => e.Level >= LogLevel.Error);

        // WHY: The CLIENT call itself failed, so its span is ERROR; only the log is downgraded.
        var span = ThisChargesSpan();
        Assert.Equal(ActivityStatusCode.Error, span.Status);
        Assert.Same(span, line.Activity);
    }

    [Fact]
    public async Task A_decline_without_a_decline_code_uses_the_error_code_as_reason()
    {
        var charger = ChargerOver(FakeStripeHandler.Declining(declineCode: null));

        await Assert.ThrowsAsync<PaymentDeclinedException>(() => ChargeAsync(charger));

        Assert.Equal("card_declined", Assert.Single(_logger.Entries).Values["reason"]);
    }

    [Fact]
    public async Task An_intent_that_did_not_succeed_logs_payment_declined_and_never_payment_charged()
    {
        var charger = ChargerOver(FakeStripeHandler.Succeeding(status: "requires_action"));

        await Assert.ThrowsAsync<PaymentDeclinedException>(() => ChargeAsync(charger));

        var line = Assert.Single(_logger.Entries);
        Assert.Equal("payment_declined", line.Values["app_event"]);
        Assert.Equal("payment_not_completed", line.Values["reason"]);
    }

    [Fact]
    public async Task A_caller_without_a_stripe_customer_is_declined_without_calling_stripe()
    {
        var stripe = FakeStripeHandler.Succeeding();
        var charger = ChargerOver(stripe);

        await Assert.ThrowsAsync<PaymentDeclinedException>(() =>
            charger.ChargeAsync(Metadata, AmountCents, stripeCustomerId: null, FakeStripeHandler.PaymentMethodId, ChargeKey, default));

        Assert.Empty(stripe.Requests);
        var line = Assert.Single(_logger.Entries);
        Assert.Equal(LogLevel.Warning, line.Level);
        Assert.Equal("no_saved_payment_method", line.Values["reason"]);
    }

    [Fact]
    public async Task A_rejected_key_never_reaches_the_span_or_the_logs()
    {
        var charger = ChargerOver(FakeStripeHandler.RejectingTheKey());

        await Assert.ThrowsAsync<PaymentUnavailableException>(() => ChargeAsync(charger));

        var span = ThisChargesSpan();
        Assert.Equal(ActivityStatusCode.Error, span.Status);
        var spanText = string.Join('|',
            new[] { span.StatusDescription }
                .Concat(span.Tags.Select(t => t.Value))
                .Concat(span.Events.SelectMany(e => e.Tags.Select(t => t.Value?.ToString()))));
        Assert.DoesNotContain("rk_", spanText);
        Assert.DoesNotContain("API Key", spanText);
        Assert.DoesNotContain(_logger.Entries, e =>
            e.Rendered.Contains("rk_") || e.Values.Values.Any(v => v?.ToString()?.Contains("rk_") == true));
    }

    [Fact]
    public async Task A_charge_carries_the_order_and_the_callers_identity_as_metadata()
    {
        var stripe = FakeStripeHandler.Succeeding();

        await ChargeAsync(ChargerOver(stripe));

        var request = Assert.Single(stripe.Charges);
        Assert.Equal(
            new Dictionary<string, string> { ["order_id"] = _orderId, ["user_id"] = UserId, ["cognito_sub"] = CognitoSub },
            request.Metadata);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("  ")]
    public async Task An_unknown_identity_is_omitted_from_the_metadata_never_sent_empty(string? unknown)
    {
        var stripe = FakeStripeHandler.Succeeding();
        var charger = ChargerOver(stripe);
        var metadata = new PaymentMetadata(_orderId, unknown, unknown);

        await charger.ChargeAsync(metadata, AmountCents, CustomerId, FakeStripeHandler.PaymentMethodId, ChargeKey, default);
        await charger.RefundAsync(metadata, FakeStripeHandler.PaymentIntentId);

        Assert.All(
            stripe.Charges.Concat(stripe.Refunds),
            r => Assert.Equal(new Dictionary<string, string> { ["order_id"] = _orderId }, r.Metadata));
    }

    [Fact]
    public async Task A_refund_carries_the_same_metadata_as_the_charge_it_refunds()
    {
        var stripe = FakeStripeHandler.Succeeding();
        var charger = ChargerOver(stripe);

        await ChargeAsync(charger);
        await charger.RefundAsync(Metadata, FakeStripeHandler.PaymentIntentId);

        Assert.Equal(Assert.Single(stripe.Charges).Metadata, Assert.Single(stripe.Refunds).Metadata);
    }

    [Fact]
    public void Metadata_read_back_from_stripe_rebuilds_the_same_parameters_whatever_the_key_order()
    {
        var fromStripe = new Dictionary<string, string>
        {
            ["cognito_sub"] = CognitoSub,
            ["unrelated"] = "x",
            ["user_id"] = UserId,
            ["order_id"] = _orderId,
        };

        var rebuilt = PaymentMetadata.FromStripe(_orderId, fromStripe);

        Assert.Equal(Metadata, rebuilt);
        Assert.Equal(new[] { "order_id", "user_id", "cognito_sub" }, rebuilt.ToStripe().Keys);
    }

    [Fact]
    public void Metadata_from_an_older_payment_intent_without_identity_keys_omits_them()
    {
        var rebuilt = PaymentMetadata.FromStripe(_orderId, new Dictionary<string, string> { ["order_id"] = _orderId });

        Assert.Equal(new Dictionary<string, string> { ["order_id"] = _orderId }, rebuilt.ToStripe());
    }

    [Fact]
    public async Task A_refund_opens_its_own_client_span_and_logs_payment_refunded_with_both_ids()
    {
        var stripe = FakeStripeHandler.Succeeding();
        var charger = ChargerOver(stripe);

        var refunded = await charger.RefundAsync(Metadata, FakeStripeHandler.PaymentIntentId);

        Assert.True(refunded);
        var request = Assert.Single(stripe.Refunds);
        Assert.Equal(FakeStripeHandler.PaymentIntentId, request.Form["payment_intent"]);
        Assert.Equal(StripePaymentCharger.RefundIdempotencyKeyFor(FakeStripeHandler.PaymentIntentId), request.IdempotencyKey);

        var span = ThisRefundsSpan();
        Assert.Equal("stripe.refund.create", span.DisplayName);
        Assert.Equal(ActivityKind.Client, span.Kind);
        Assert.Equal(ActivityStatusCode.Ok, span.Status);
        Assert.Equal("stripe.refund.create", span.GetTagItem("stripe.operation"));
        Assert.Equal("refund", span.GetTagItem("stripe.resource_type"));
        Assert.Equal(FakeStripeHandler.PaymentIntentId, span.GetTagItem("stripe.payment_intent_id"));

        // CONTRACT: BOTH ids on ONE line — "was the dangling charge refunded?" must be answerable
        // from this line alone.
        var line = Assert.Single(_logger.Entries);
        Assert.Equal(LogLevel.Information, line.Level);
        Assert.Equal("payment_refunded", line.Values["app_event"]);
        Assert.Equal(_orderId, line.Values["order_id"]);
        Assert.Equal(FakeStripeHandler.PaymentIntentId, line.Values["payment_intent_id"]);
        Assert.Same(span, line.Activity);
    }

    [Fact]
    public async Task A_failed_refund_logs_payment_refunded_failed_at_error_without_stripes_text_and_does_not_throw()
    {
        var charger = ChargerOver(FakeStripeHandler.SucceedingWithFailingRefund());

        var refunded = await charger.RefundAsync(Metadata, FakeStripeHandler.PaymentIntentId);

        Assert.False(refunded);
        var line = Assert.Single(_logger.Entries);
        Assert.Equal(LogLevel.Error, line.Level);
        Assert.Equal("payment_refunded_failed", line.Values["app_event"]);
        Assert.Equal("refund_call_failed", line.Values["reason"]);
        Assert.Equal(_orderId, line.Values["order_id"]);
        Assert.Equal(FakeStripeHandler.PaymentIntentId, line.Values["payment_intent_id"]);
        Assert.DoesNotContain("rk_", line.Rendered);

        var span = ThisRefundsSpan();
        Assert.Equal(ActivityStatusCode.Error, span.Status);
        var spanText = string.Join('|',
            new[] { span.StatusDescription }
                .Concat(span.Tags.Select(t => t.Value))
                .Concat(span.Events.SelectMany(e => e.Tags.Select(t => t.Value?.ToString()))));
        Assert.DoesNotContain("rk_", spanText);
    }

    [Fact]
    public async Task A_retried_refund_for_the_same_payment_intent_refunds_only_once()
    {
        var stripe = FakeStripeHandler.Succeeding();
        var charger = ChargerOver(stripe);

        Assert.True(await charger.RefundAsync(Metadata, FakeStripeHandler.PaymentIntentId));
        Assert.True(await charger.RefundAsync(Metadata, FakeStripeHandler.PaymentIntentId));

        Assert.Equal(2, stripe.Refunds.Count());
        Assert.All(stripe.Refunds, r => Assert.Equal($"refund-{FakeStripeHandler.PaymentIntentId}", r.IdempotencyKey));
        Assert.Equal(1, stripe.RefundsExecuted);
    }

    [Fact]
    public async Task An_orphan_refund_shares_the_inline_refund_key_and_logs_payment_orphan_refunded()
    {
        var stripe = FakeStripeHandler.Succeeding();
        var charger = ChargerOver(stripe);

        Assert.True(await charger.RefundAsync(Metadata, FakeStripeHandler.PaymentIntentId));
        Assert.True(await charger.RefundOrphanAsync(Metadata, FakeStripeHandler.PaymentIntentId));

        Assert.All(stripe.Refunds, r => Assert.Equal($"refund-{FakeStripeHandler.PaymentIntentId}", r.IdempotencyKey));
        Assert.Equal(1, stripe.RefundsExecuted);
        var orphan = _logger.Entries.Last();
        Assert.Equal(LogLevel.Warning, orphan.Level);
        Assert.Equal("payment_orphan_refunded", orphan.Values["app_event"]);
        Assert.Equal(_orderId, orphan.Values["order_id"]);
        Assert.Equal(FakeStripeHandler.PaymentIntentId, orphan.Values["payment_intent_id"]);
        Assert.Same(ThisRefundsSpan(), orphan.Activity);
    }

    [Fact]
    public async Task A_refund_of_an_already_refunded_charge_counts_as_refunded()
    {
        var charger = ChargerOver(FakeStripeHandler.SucceedingWithAlreadyRefunded());

        var refunded = await charger.RefundOrphanAsync(Metadata, FakeStripeHandler.PaymentIntentId);

        Assert.True(refunded);
        Assert.Equal(ActivityStatusCode.Ok, ThisRefundsSpan().Status);
        Assert.DoesNotContain(_logger.Entries, e => e.Level == LogLevel.Error);
    }

    private Activity ThisRefundsSpan()
    {
        var key = StripePaymentCharger.RefundIdempotencyKeyFor(FakeStripeHandler.PaymentIntentId);
        lock (_stopped)
        {
            // WHY: The PaymentIntent id is shared by every test using the fake, so the span is
            // matched on this test's order id as well.
            return Assert.Single(_stopped, a =>
                a.DisplayName == "stripe.refund.create" && (string?)a.GetTagItem("stripe.idempotency_key") == key
                && ReferenceEquals(a, _logger.Entries.LastOrDefault()?.Activity));
        }
    }

    private StripePaymentCharger ChargerOver(FakeStripeHandler stripe) =>
        new(FakeStripeHandler.ClientFor(stripe), _logger);

    private Task<Orders.Domain.Payments.PaymentSnapshot> ChargeAsync(StripePaymentCharger charger) =>
        charger.ChargeAsync(Metadata, AmountCents, CustomerId, FakeStripeHandler.PaymentMethodId, ChargeKey, default);

    private PaymentMetadata Metadata => new(_orderId, UserId, CognitoSub);

    // WHY: Unique per test — the span listener is process-wide, and spans are matched on this key.
    private string ChargeKey => StripePaymentCharger.ChargeIdempotencyKeyFor("usr_test", _orderId);

    private Activity ThisChargesSpan()
    {
        lock (_stopped)
        {
            return Assert.Single(_stopped, a =>
                (string?)a.GetTagItem("stripe.idempotency_key") == ChargeKey);
        }
    }
}
