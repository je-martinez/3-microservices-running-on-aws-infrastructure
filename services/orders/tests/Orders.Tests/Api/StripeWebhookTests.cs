using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;
using Orders.Infrastructure.Observability;
using Orders.Infrastructure.Payments;
using Orders.Tests.Observability;
using Orders.Tests.Payments;
using Stripe;

namespace Orders.Tests.Api;

/// <summary>
/// POST /v1/orders/stripe/webhook — payment reconciliation, one test per branch.
/// CONTRACT: Every delivery is signed with Stripe's real scheme (HMAC-SHA256 over
/// <c>{t}.{body}</c>) and verified by the service, never bypassed. See
/// [[2026-09-19-stripe-payments-design]]
/// </summary>
[Collection(OrdersApiCollection.Name)]
public sealed class StripeWebhookTests : IDisposable
{
    private const string Route = "/v1/orders/stripe/webhook";
    private const string WebhookSecret = "whsec_test_orders";

    private readonly OrdersApiFactory _factory;
    private readonly SpanScopedLogger<StripeWebhookService> _webhookLog = new();
    private readonly SpanScopedLogger<StripePaymentCharger> _chargerLog = new();
    private readonly List<Activity> _stopped = new();
    private readonly ActivityListener _listener;

    // WHY: Unique per test — the refund key and the order lookups are keyed on these, and the
    // database and span listener are shared by the whole collection.
    private readonly string _paymentIntentId = $"pi_wh_{Guid.NewGuid():N}";
    private readonly string _orderId = NanoId.NewId(NanoId.OrderPrefix);

    public StripeWebhookTests(OrdersApiFactory factory)
    {
        _factory = factory;
        _listener = new ActivityListener
        {
            ShouldListenTo = s => s.Name == StripeActivitySource.Name,
            Sample = (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllData,
            ActivityStopped = a => { lock (_stopped) { _stopped.Add(a); } },
        };
        ActivitySource.AddActivityListener(_listener);
    }

    public void Dispose() => _listener.Dispose();

    // ---- guards -------------------------------------------------------------------------

    [Fact]
    public async Task An_invalid_signature_answers_400_and_dispatches_nothing()
    {
        var stripe = FakeStripeHandler.Succeeding();
        var client = ClientFor(stripe);
        var body = PaymentIntentSucceeded(createdAgo: TimeSpan.FromHours(1));
        var forged = Sign(body, "whsec_someone_else");

        var response = await PostAsync(client, body, forged);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("invalid_signature", (await ErrorOf(response)).Error);
        Assert.Empty(stripe.Requests);
        Assert.DoesNotContain(_webhookLog.Entries, e => e.Level == LogLevel.Information);
        var line = Assert.Single(_webhookLog.Entries);
        Assert.Equal(LogLevel.Warning, line.Level);
        Assert.Equal("stripe_webhook_received", line.Values["app_event"]);
        Assert.Equal("signature_verification_failed", line.Values["reason"]);
        AssertNothingLeaked(forged);
    }

    [Fact]
    public async Task A_missing_signature_header_answers_400_and_dispatches_nothing()
    {
        var stripe = FakeStripeHandler.Succeeding();
        var client = ClientFor(stripe);

        var response = await PostAsync(client, PaymentIntentSucceeded(createdAgo: TimeSpan.FromHours(1)), signature: null);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("invalid_signature", (await ErrorOf(response)).Error);
        Assert.Empty(stripe.Requests);
    }

    [Fact]
    public async Task With_no_webhook_secret_it_answers_503_before_verifying_anything()
    {
        var stripe = FakeStripeHandler.Succeeding();
        var client = ClientFor(stripe, webhookSecret: null);
        var body = PaymentIntentSucceeded(createdAgo: TimeSpan.FromHours(1));

        var response = await PostAsync(client, body, Sign(body, WebhookSecret));

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.Equal("stripe_unavailable", (await ErrorOf(response)).Error);
        Assert.Empty(stripe.Requests);
        Assert.DoesNotContain(_webhookLog.Entries, e => Equals(e.Values.GetValueOrDefault("reason"), "signature_verification_failed"));
    }

    [Fact]
    public async Task With_no_stripe_key_it_answers_503()
    {
        var client = ClientFor(stripe: null);
        var body = PaymentIntentSucceeded(createdAgo: TimeSpan.FromHours(1));

        var response = await PostAsync(client, body, Sign(body, WebhookSecret));

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.Equal("stripe_unavailable", (await ErrorOf(response)).Error);
    }

    [Fact]
    public async Task With_stripe_disabled_the_route_is_not_mapped()
    {
        var stripe = FakeStripeHandler.Succeeding();
        var client = ClientFor(stripe, stripeEnabled: false);
        var body = PaymentIntentSucceeded(createdAgo: TimeSpan.FromHours(1));

        var response = await PostAsync(client, body, Sign(body, WebhookSecret));

        // WHY: An unmapped path is not on the public allowlist, so the caller guard answers it
        // exactly as it answered before this route existed.
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Empty(stripe.Requests);
        Assert.Empty(_webhookLog.Entries);
    }

    [Fact]
    public async Task A_verified_delivery_logs_stripe_webhook_received_with_the_event_type_and_id()
    {
        var client = ClientFor(FakeStripeHandler.Succeeding());
        var body = Event("customer.created", new { id = "cus_x", @object = "customer" }, out var eventId);

        var response = await PostAsync(client, body, Sign(body, WebhookSecret));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var line = Assert.Single(_webhookLog.Entries);
        Assert.Equal(LogLevel.Information, line.Level);
        Assert.Equal("stripe_webhook_received", line.Values["app_event"]);
        Assert.Equal("customer.created", line.Values["event_type"]);
        Assert.Equal(eventId, line.Values["event_id"]);
    }

    // ---- payment_intent.succeeded: orphan charges ------------------------------------------

    [Fact]
    public async Task An_orphan_inside_the_grace_period_answers_non_2xx_and_does_not_refund()
    {
        var stripe = FakeStripeHandler.Succeeding();
        var client = ClientFor(stripe);
        var body = PaymentIntentSucceeded(createdAgo: TimeSpan.FromSeconds(5));

        var response = await PostAsync(client, body, Sign(body, WebhookSecret));

        Assert.False(response.IsSuccessStatusCode);
        Assert.True((int)response.StatusCode < 500, "a normal retry must not read as a server fault");
        Assert.Empty(stripe.Refunds);
    }

    [Fact]
    public async Task An_orphan_older_than_the_grace_period_is_refunded_with_the_inline_refund_key()
    {
        var stripe = FakeStripeHandler.Succeeding();
        var client = ClientFor(stripe);
        var body = PaymentIntentSucceeded(createdAgo: TimeSpan.FromHours(1));

        var response = await PostAsync(client, body, Sign(body, WebhookSecret));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var refund = Assert.Single(stripe.Refunds);
        Assert.Equal($"refund-{_paymentIntentId}", refund.IdempotencyKey);
        Assert.Equal(_paymentIntentId, refund.Form["payment_intent"]);
        Assert.False(refund.Form.ContainsKey("amount"));
        Assert.Equal(_orderId, refund.Form["metadata[order_id]"]);

        var line = Assert.Single(_chargerLog.Entries);
        Assert.Equal(LogLevel.Warning, line.Level);
        Assert.Equal("payment_orphan_refunded", line.Values["app_event"]);
        Assert.Equal(_orderId, line.Values["order_id"]);
        Assert.Equal(_paymentIntentId, line.Values["payment_intent_id"]);

        var span = ThisRefundSpan();
        Assert.Equal(ActivityKind.Client, span.Kind);
        Assert.Equal(ActivityStatusCode.Ok, span.Status);
        Assert.Same(span, line.Activity);
    }

    [Fact]
    public async Task The_grace_period_is_configurable()
    {
        var stripe = FakeStripeHandler.Succeeding();
        var client = ClientFor(stripe, graceSeconds: "0");
        var body = PaymentIntentSucceeded(createdAgo: TimeSpan.FromSeconds(5));

        var response = await PostAsync(client, body, Sign(body, WebhookSecret));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Single(stripe.Refunds);
    }

    [Fact]
    public async Task A_succeeded_intent_whose_order_exists_is_a_silent_no_op()
    {
        await InsertOrderAsync(status: "succeeded");
        var stripe = FakeStripeHandler.Succeeding();
        var client = ClientFor(stripe);
        var body = PaymentIntentSucceeded(createdAgo: TimeSpan.FromHours(1));

        var response = await PostAsync(client, body, Sign(body, WebhookSecret));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Empty(stripe.Requests);
        Assert.Empty(_chargerLog.Entries);
        Assert.DoesNotContain(_webhookLog.Entries, e => e.Level >= LogLevel.Warning);
    }

    [Fact]
    public async Task An_orphan_delivered_twice_is_refunded_once()
    {
        var stripe = FakeStripeHandler.Succeeding();
        var client = ClientFor(stripe);
        var body = PaymentIntentSucceeded(createdAgo: TimeSpan.FromHours(1));

        var first = await PostAsync(client, body, Sign(body, WebhookSecret));
        var second = await PostAsync(client, body, Sign(body, WebhookSecret));

        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        Assert.All(stripe.Refunds, r => Assert.Equal($"refund-{_paymentIntentId}", r.IdempotencyKey));
        Assert.Equal(1, stripe.RefundsExecuted);
    }

    [Fact]
    public async Task A_failed_orphan_refund_answers_non_2xx_so_stripe_retries_without_leaking_stripes_text()
    {
        var stripe = FakeStripeHandler.SucceedingWithFailingRefund();
        var client = ClientFor(stripe);
        var body = PaymentIntentSucceeded(createdAgo: TimeSpan.FromHours(1));

        var response = await PostAsync(client, body, Sign(body, WebhookSecret));

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.DoesNotContain("rk_", await response.Content.ReadAsStringAsync());
        var line = Assert.Single(_chargerLog.Entries);
        Assert.Equal(LogLevel.Error, line.Level);
        Assert.Equal("payment_orphan_refunded_failed", line.Values["app_event"]);
        Assert.Equal(_paymentIntentId, line.Values["payment_intent_id"]);
        Assert.DoesNotContain("rk_", line.Rendered);
    }

    [Fact]
    public async Task A_succeeded_intent_without_an_order_id_is_not_ours_and_is_ignored()
    {
        var stripe = FakeStripeHandler.Succeeding();
        var client = ClientFor(stripe);
        var body = PaymentIntentSucceeded(createdAgo: TimeSpan.FromHours(1), withOrderId: false);

        var response = await PostAsync(client, body, Sign(body, WebhookSecret));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Empty(stripe.Requests);
    }

    // ---- charge.refunded ----------------------------------------------------------------

    [Fact]
    public async Task A_full_refund_marks_the_order_refunded()
    {
        await InsertOrderAsync(status: "succeeded");
        var client = ClientFor(FakeStripeHandler.Succeeding());

        var response = await PostSignedAsync(client, ChargeRefunded(amount: 2500, amountRefunded: 2500));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var order = await LoadOrderAsync();
        Assert.Equal("refunded", order.PaymentStatus);
        Assert.Equal("orders_api:stripe_webhook", order.UpdatedBy);
    }

    [Fact]
    public async Task A_partial_refund_marks_the_order_partially_refunded()
    {
        await InsertOrderAsync(status: "succeeded");
        var client = ClientFor(FakeStripeHandler.Succeeding());

        var response = await PostSignedAsync(client, ChargeRefunded(amount: 2500, amountRefunded: 1000));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("partially_refunded", (await LoadOrderAsync()).PaymentStatus);
    }

    [Fact]
    public async Task A_stale_partial_refund_arriving_after_the_full_one_does_not_downgrade_the_status()
    {
        await InsertOrderAsync(status: "succeeded");
        var client = ClientFor(FakeStripeHandler.Succeeding());

        await PostSignedAsync(client, ChargeRefunded(amount: 2500, amountRefunded: 2500));
        var response = await PostSignedAsync(client, ChargeRefunded(amount: 2500, amountRefunded: 1000));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("refunded", (await LoadOrderAsync()).PaymentStatus);
    }

    [Fact]
    public async Task A_refund_for_a_charge_with_no_order_is_acknowledged()
    {
        var client = ClientFor(FakeStripeHandler.Succeeding());

        var response = await PostSignedAsync(client, ChargeRefunded(amount: 2500, amountRefunded: 2500));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    // ---- disputes -----------------------------------------------------------------------

    [Fact]
    public async Task A_dispute_created_marks_the_order_disputed_and_logs_a_warning()
    {
        await InsertOrderAsync(status: "succeeded");
        var client = ClientFor(FakeStripeHandler.Succeeding());

        var response = await PostSignedAsync(client, Dispute("charge.dispute.created", "needs_response"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("disputed", (await LoadOrderAsync()).PaymentStatus);
        var line = Assert.Single(_webhookLog.Entries, e => e.Level == LogLevel.Warning);
        Assert.Equal("payment_status_reconciled", line.Values["app_event"]);
        Assert.Equal("disputed", line.Values["payment_status"]);
        Assert.Equal(_orderId, line.Values["order_id"]);
        Assert.Equal(_paymentIntentId, line.Values["payment_intent_id"]);
    }

    [Fact]
    public async Task A_dispute_won_reverts_the_order_to_succeeded()
    {
        await InsertOrderAsync(status: "disputed");
        var client = ClientFor(FakeStripeHandler.Succeeding());

        var response = await PostSignedAsync(client, Dispute("charge.dispute.closed", "won"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("succeeded", (await LoadOrderAsync()).PaymentStatus);
        Assert.Single(_webhookLog.Entries, e => e.Level == LogLevel.Warning);
    }

    [Fact]
    public async Task A_dispute_lost_marks_the_order_dispute_lost()
    {
        await InsertOrderAsync(status: "disputed");
        var client = ClientFor(FakeStripeHandler.Succeeding());

        var response = await PostSignedAsync(client, Dispute("charge.dispute.closed", "lost"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("dispute_lost", (await LoadOrderAsync()).PaymentStatus);
    }

    [Fact]
    public async Task A_late_dispute_created_does_not_overwrite_a_lost_dispute()
    {
        await InsertOrderAsync(status: "dispute_lost");
        var client = ClientFor(FakeStripeHandler.Succeeding());

        var response = await PostSignedAsync(client, Dispute("charge.dispute.created", "needs_response"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("dispute_lost", (await LoadOrderAsync()).PaymentStatus);
    }

    // ---- everything else ----------------------------------------------------------------

    [Fact]
    public async Task An_unhandled_event_type_is_acknowledged_and_touches_nothing()
    {
        await InsertOrderAsync(status: "succeeded");
        var stripe = FakeStripeHandler.Succeeding();
        var client = ClientFor(stripe);

        var response = await PostSignedAsync(client, Event("customer.created", new { id = "cus_x", @object = "customer" }, out _));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Empty(stripe.Requests);
        Assert.Equal("succeeded", (await LoadOrderAsync()).PaymentStatus);
        Assert.DoesNotContain(_webhookLog.Entries, e => e.Level >= LogLevel.Warning);
    }

    // ---- helpers ------------------------------------------------------------------------

    private HttpClient ClientFor(
        FakeStripeHandler? stripe,
        bool stripeEnabled = true,
        string? webhookSecret = WebhookSecret,
        string? graceSeconds = null)
    {
        var host = _factory.WithWebHostBuilder(builder =>
        {
            builder.UseSetting("STRIPE_ENABLED", stripeEnabled ? "true" : "false");
            builder.UseSetting("STRIPE_WEBHOOK_SECRET", webhookSecret ?? string.Empty);
            if (graceSeconds is not null)
            {
                builder.UseSetting("STRIPE_ORPHAN_GRACE_PERIOD_SECONDS", graceSeconds);
            }

            if (stripe is not null)
            {
                builder.UseSetting("STRIPE_SECRET_KEY", "rk_test_fake");
            }

            builder.ConfigureTestServices(services =>
            {
                services.AddSingleton<ILogger<StripeWebhookService>>(_webhookLog);
                services.AddSingleton<ILogger<StripePaymentCharger>>(_chargerLog);
                if (stripe is null)
                {
                    return;
                }

                foreach (var d in services.Where(d => d.ServiceType == typeof(IStripeClient)).ToList())
                {
                    services.Remove(d);
                }

                services.AddSingleton(FakeStripeHandler.ClientFor(stripe));
            });
        });

        return host.CreateClient();
    }

    private static async Task<HttpResponseMessage> PostAsync(HttpClient client, string body, string? signature)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, Route)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };
        if (signature is not null)
        {
            request.Headers.TryAddWithoutValidation("Stripe-Signature", signature);
        }

        return await client.SendAsync(request);
    }

    private static Task<HttpResponseMessage> PostSignedAsync(HttpClient client, string body) =>
        PostAsync(client, body, Sign(body, WebhookSecret));

    /// <summary>Stripe's signature scheme: <c>t={unix},v1={hex HMAC-SHA256(secret, "{t}.{body}")}</c>.</summary>
    private static string Sign(string body, string secret)
    {
        var timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
        var signature = Convert.ToHexString(hmac.ComputeHash(Encoding.UTF8.GetBytes($"{timestamp}.{body}")));
        return $"t={timestamp},v1={signature.ToLowerInvariant()}";
    }

    private static string Event(string type, object dataObject, out string eventId)
    {
        eventId = $"evt_{Guid.NewGuid():N}";
        return JsonSerializer.Serialize(new
        {
            id = eventId,
            @object = "event",
            api_version = "2026-08-26.dahlia",
            created = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
            livemode = false,
            pending_webhooks = 1,
            type,
            data = new { @object = dataObject },
        });
    }

    private string PaymentIntentSucceeded(TimeSpan createdAgo, bool withOrderId = true) =>
        Event("payment_intent.succeeded", new
        {
            id = _paymentIntentId,
            @object = "payment_intent",
            amount = 2500,
            currency = "usd",
            status = "succeeded",
            created = DateTimeOffset.UtcNow.Subtract(createdAgo).ToUnixTimeSeconds(),
            metadata = withOrderId ? new Dictionary<string, string> { ["order_id"] = _orderId } : new(),
        }, out _);

    private string ChargeRefunded(long amount, long amountRefunded) =>
        Event("charge.refunded", new
        {
            id = $"ch_{Guid.NewGuid():N}",
            @object = "charge",
            amount,
            amount_refunded = amountRefunded,
            refunded = amountRefunded >= amount,
            currency = "usd",
            payment_intent = _paymentIntentId,
        }, out _);

    private string Dispute(string type, string status) =>
        Event(type, new
        {
            id = $"dp_{Guid.NewGuid():N}",
            @object = "dispute",
            amount = 2500,
            currency = "usd",
            charge = "ch_disputed",
            payment_intent = _paymentIntentId,
            status,
        }, out _);

    private async Task InsertOrderAsync(string status)
    {
        // CONTRACT: An identity no other test uses — CacheCrossUserTests asserts the factory's
        // OTHER user has no orders, and the database is shared by the whole collection.
        await using var db = _factory.NewWriteContext();
        db.Orders.Add(new Order
        {
            Id = _orderId,
            UserId = "usr_webhooktest",
            CognitoSub = "sub-webhook-test",
            PaymentIntentId = _paymentIntentId,
            PaymentStatus = status,
            AmountCents = 2500,
            Currency = "usd",
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow,
        });
        await db.SaveChangesAsync();
    }

    private async Task<Order> LoadOrderAsync()
    {
        await using var db = _factory.NewWriteContext();
        return await db.Orders.AsNoTracking().IgnoreQueryFilters().SingleAsync(o => o.Id == _orderId);
    }

    private Activity ThisRefundSpan()
    {
        var key = StripePaymentCharger.RefundIdempotencyKeyFor(_paymentIntentId);
        lock (_stopped)
        {
            return Assert.Single(_stopped, a =>
                a.DisplayName == "stripe.refund.create" && (string?)a.GetTagItem("stripe.idempotency_key") == key);
        }
    }

    private void AssertNothingLeaked(string signature)
    {
        var logged = _webhookLog.Entries
            .SelectMany(e => e.Values.Values.Select(v => v?.ToString() ?? string.Empty).Append(e.Rendered))
            .ToList();
        Assert.DoesNotContain(logged, v => v.Contains(signature) || v.Contains("whsec_"));
    }

    private static async Task<ErrorBody> ErrorOf(HttpResponseMessage response) =>
        (await response.Content.ReadFromJsonAsync<ErrorBody>())!;

    private sealed record ErrorBody(string Error);
}
