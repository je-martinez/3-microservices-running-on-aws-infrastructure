using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using OpenTelemetry.Instrumentation.AspNetCore;
using Orders.Api.Endpoints;
using Orders.Api.Payments;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;
using Orders.Infrastructure.Observability;
using Orders.Infrastructure.Payments;
using Orders.Tests.Observability;
using Orders.Tests.Payments;
using Stripe;

namespace Orders.Tests.Api;

/// <summary>
/// POST /v1/orders/stripe/webhook/{token} — payment reconciliation, one test per branch.
/// CONTRACT: Every delivery is signed with Stripe's real scheme (HMAC-SHA256 over
/// <c>{t}.{body}</c>) and verified by the service, never bypassed. See
/// [[2026-09-19-stripe-payments-design]]
/// </summary>
[Collection(OrdersApiCollection.Name)]
public sealed class StripeWebhookTests : IDisposable
{
    private const string WebhookSecret = "whsec_test_orders";
    private const string UrlToken = "ordTok_Q7vYk2mPz9RwX4cL8nB3tH6jF1sD5gA0";
    private const string Route = "/v1/orders/stripe/webhook/" + UrlToken;

    // WHY: TEST-NET ranges. With one trusted hop the RIGHTMOST forwarded entry is the client.
    private const string AllowedCidrs = "203.0.113.0/24, 2001:db8::/32";
    private const string StripeIp = "203.0.113.10";
    private const string OutsideIp = "198.51.100.7";
    private const string ViaProxy = OutsideIp + ", " + StripeIp;

    private readonly OrdersApiFactory _factory;
    private readonly SpanScopedLogger<StripeWebhookService> _webhookLog = new();
    private readonly SpanScopedLogger<StripePaymentCharger> _chargerLog = new();
    private readonly SpanScopedLogger<StripeWebhookAccess> _accessLog = new();
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

    // ---- layer 1: URL token --------------------------------------------------------------

    [Fact]
    public async Task A_wrong_url_token_answers_the_same_bodiless_404_as_an_unmapped_route()
    {
        var stripe = FakeStripeHandler.Succeeding();
        var client = ClientFor(stripe);
        var body = PaymentIntentSucceeded(createdAgo: TimeSpan.FromHours(1));

        var wrong = await PostAsync(client, body, Sign(body, WebhookSecret), path: "/v1/orders/stripe/webhook/ordTok_wrong");
        // WHY: x-user-id gets an unmapped path past the caller guard to the framework's own 404.
        var unmappedRequest = new HttpRequestMessage(HttpMethod.Post, "/v1/orders/stripe/nowhere")
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };
        unmappedRequest.Headers.Add("x-user-id", OrdersApiFactory.KnownCognitoSub);
        var unmapped = await client.SendAsync(unmappedRequest);

        Assert.Equal(HttpStatusCode.NotFound, unmapped.StatusCode);
        Assert.Equal(unmapped.StatusCode, wrong.StatusCode);
        Assert.Equal(string.Empty, await wrong.Content.ReadAsStringAsync());
        Assert.Equal(await unmapped.Content.ReadAsStringAsync(), await wrong.Content.ReadAsStringAsync());
        Assert.Equal(unmapped.Content.Headers.ContentType, wrong.Content.Headers.ContentType);
        Assert.Empty(stripe.Requests);
        Assert.Empty(_webhookLog.Entries);
        Assert.Empty(_accessLog.Entries);
    }

    [Fact]
    public async Task A_prefix_of_the_url_token_is_rejected_like_any_wrong_token()
    {
        var stripe = FakeStripeHandler.Succeeding();
        var client = ClientFor(stripe);
        var body = PaymentIntentSucceeded(createdAgo: TimeSpan.FromHours(1));

        var response = await PostAsync(client, body, Sign(body, WebhookSecret), path: Route[..^1]);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Empty(stripe.Requests);
    }

    [Fact]
    public async Task The_bare_route_without_a_token_is_not_mapped()
    {
        var stripe = FakeStripeHandler.Succeeding();
        var client = ClientFor(stripe);
        var body = PaymentIntentSucceeded(createdAgo: TimeSpan.FromHours(1));

        var response = await PostAsync(client, body, Sign(body, WebhookSecret), path: "/v1/orders/stripe/webhook");

        // WHY: No endpoint matches, so the caller guard answers it like any other unmapped path.
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Empty(stripe.Requests);
        Assert.Empty(_webhookLog.Entries);
    }

    [Fact]
    public async Task With_no_url_token_configured_it_answers_503_before_verifying_anything()
    {
        var stripe = FakeStripeHandler.Succeeding();
        var client = ClientFor(stripe, urlToken: "  ");
        var body = PaymentIntentSucceeded(createdAgo: TimeSpan.FromHours(1));

        var response = await PostAsync(client, body, Sign(body, WebhookSecret));

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.Equal("stripe_unavailable", (await ErrorOf(response)).Error);
        Assert.Empty(stripe.Requests);
        Assert.Empty(_webhookLog.Entries);
    }

    [Fact]
    public async Task A_wrong_url_token_is_rejected_before_the_signature_is_checked()
    {
        var client = ClientFor(FakeStripeHandler.Succeeding());
        var body = PaymentIntentSucceeded(createdAgo: TimeSpan.FromHours(1));

        var response = await PostAsync(client, body, Sign(body, "whsec_someone_else"), path: "/v1/orders/stripe/webhook/nope");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Empty(_webhookLog.Entries);
    }

    // ---- layer 2: Stripe source-IP allowlist ----------------------------------------------

    [Fact]
    public async Task A_source_outside_the_allowlist_answers_403_and_logs_the_source_ip()
    {
        var stripe = FakeStripeHandler.Succeeding();
        var client = ClientFor(stripe);
        var body = PaymentIntentSucceeded(createdAgo: TimeSpan.FromHours(1));

        var response = await PostAsync(client, body, Sign(body, WebhookSecret), forwardedFor: OutsideIp);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal("forbidden_source", (await ErrorOf(response)).Error);
        Assert.Empty(stripe.Requests);
        Assert.Empty(_webhookLog.Entries);
        var line = Assert.Single(_accessLog.Entries);
        Assert.Equal(LogLevel.Warning, line.Level);
        Assert.Equal("stripe_webhook_received", line.Values["app_event"]);
        Assert.Equal("source_ip_not_allowed", line.Values["reason"]);
        Assert.Equal(OutsideIp, line.Values["source_ip"]);
        Assert.DoesNotContain(UrlToken, line.Rendered);
    }

    [Fact]
    public async Task The_allowlist_is_checked_before_the_url_token()
    {
        var client = ClientFor(FakeStripeHandler.Succeeding());
        var body = PaymentIntentSucceeded(createdAgo: TimeSpan.FromHours(1));

        var response = await PostAsync(
            client, body, Sign(body, WebhookSecret), path: "/v1/orders/stripe/webhook/nope", forwardedFor: OutsideIp);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task A_client_prepending_a_stripe_ip_to_x_forwarded_for_is_still_rejected()
    {
        var client = ClientFor(FakeStripeHandler.Succeeding());

        var response = await PostSignedAsync(client, CustomerCreated(), forwardedFor: $"{StripeIp}, {OutsideIp}");

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Theory]
    [InlineData("not-an-ip")]
    [InlineData(null)]
    public async Task An_unparseable_or_missing_forwarded_entry_answers_403(string? forwardedFor)
    {
        var stripe = FakeStripeHandler.Succeeding();
        var client = ClientFor(stripe);
        var body = PaymentIntentSucceeded(createdAgo: TimeSpan.FromHours(1));

        var response = await PostAsync(client, body, Sign(body, WebhookSecret), forwardedFor: forwardedFor);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal("forbidden_source", (await ErrorOf(response)).Error);
        Assert.Empty(stripe.Requests);
        var line = Assert.Single(_accessLog.Entries);
        Assert.Equal(LogLevel.Warning, line.Level);
        Assert.Equal("source_ip_not_allowed", line.Values["reason"]);
        Assert.False(line.Values.ContainsKey("source_ip"));
    }

    [Fact]
    public async Task With_two_trusted_hops_the_entry_two_positions_from_the_right_is_the_client()
    {
        var client = ClientFor(FakeStripeHandler.Succeeding(), trustedProxyHops: "2");

        var response = await PostSignedAsync(client, CustomerCreated(), forwardedFor: $"{OutsideIp}, {StripeIp}, 10.0.0.5");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Theory]
    [InlineData("2001:db8::17")]
    [InlineData("::ffff:203.0.113.10")]
    public async Task Ipv6_and_ipv4_mapped_sources_are_matched_against_the_allowlist(string forwardedFor)
    {
        var client = ClientFor(FakeStripeHandler.Succeeding());

        var response = await PostSignedAsync(client, CustomerCreated(), forwardedFor);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task A_bare_address_in_the_allowlist_matches_exactly_that_address()
    {
        var client = ClientFor(FakeStripeHandler.Succeeding(), allowedCidrs: StripeIp);

        var allowed = await PostSignedAsync(client, CustomerCreated(), forwardedFor: StripeIp);
        var neighbour = await PostSignedAsync(client, CustomerCreated(), forwardedFor: "203.0.113.11");

        Assert.Equal(HttpStatusCode.OK, allowed.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, neighbour.StatusCode);
    }

    [Fact]
    public async Task With_zero_hops_the_socket_address_is_the_client_and_x_forwarded_for_is_ignored()
    {
        var host = HostFor(FakeStripeHandler.Succeeding(), trustedProxyHops: "0");

        var fromStripe = await PostFromSocketAsync(host, IPAddress.Parse("::ffff:" + StripeIp), CustomerCreated(), OutsideIp);
        var spoofed = await PostFromSocketAsync(host, IPAddress.Parse(OutsideIp), CustomerCreated(), StripeIp);

        Assert.Equal(StatusCodes.Status200OK, fromStripe.Response.StatusCode);
        Assert.Equal(StatusCodes.Status403Forbidden, spoofed.Response.StatusCode);
    }

    [Theory]
    [InlineData(null, "1")]
    [InlineData("203.0.113.0/24, not-a-cidr", "1")]
    [InlineData(AllowedCidrs, "-1")]
    [InlineData(AllowedCidrs, "two")]
    public async Task A_missing_or_invalid_allowlist_fails_closed_with_503(string? allowedCidrs, string hops)
    {
        var stripe = FakeStripeHandler.Succeeding();
        var client = ClientFor(stripe, allowedCidrs: allowedCidrs, trustedProxyHops: hops);
        var body = PaymentIntentSucceeded(createdAgo: TimeSpan.FromHours(1));

        var response = await PostAsync(client, body, Sign(body, WebhookSecret));

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.Equal("stripe_unavailable", (await ErrorOf(response)).Error);
        Assert.Empty(stripe.Requests);
        Assert.Empty(_webhookLog.Entries);
    }

    // ---- the URL token is a secret ----------------------------------------------------------

    [Fact]
    public async Task The_url_token_appears_in_no_log_line_and_no_span_attribute()
    {
        var spans = new List<Activity>();
        using var everySource = new ActivityListener
        {
            ShouldListenTo = _ => true,
            Sample = (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllData,
            ActivityStopped = a => { lock (spans) { spans.Add(a); } },
        };
        ActivitySource.AddActivityListener(everySource);
        var client = HostFor(FakeStripeHandler.Succeeding(), captureLogs: false).CreateClient();
        var forged = PaymentIntentSucceeded(createdAgo: TimeSpan.FromHours(1));

        var originalOut = Console.Out;
        using var capture = new StringWriter();
        Console.SetOut(capture);
        try
        {
            Assert.Equal(HttpStatusCode.OK, (await PostSignedAsync(client, CustomerCreated())).StatusCode);
            Assert.Equal(HttpStatusCode.BadRequest, (await PostAsync(client, forged, Sign(forged, "whsec_x"))).StatusCode);
            Assert.Equal(HttpStatusCode.Forbidden, (await PostSignedAsync(client, CustomerCreated(), OutsideIp)).StatusCode);
            // WHY: An unmatched path under the webhook prefix still carries the token.
            Assert.Equal(HttpStatusCode.Unauthorized, (await PostAsync(client, forged, null, path: Route + "/extra")).StatusCode);
        }
        finally
        {
            Console.SetOut(originalOut);
        }

        var logged = capture.ToString();
        Assert.Contains("request completed", logged);
        Assert.Contains(StripeWebhookEndpoints.Route, logged);
        Assert.DoesNotContain(UrlToken, logged);

        lock (spans)
        {
            Assert.DoesNotContain(spans, a =>
                a.DisplayName.Contains(UrlToken)
                || a.TagObjects.Any(t => t.Value?.ToString()?.Contains(UrlToken) == true)
                || a.Events.Any(e => e.Tags.Any(t => t.Value?.ToString()?.Contains(UrlToken) == true)));
            Assert.All(
                spans.Where(a => a.GetTagItem("url.path") is not null),
                a => Assert.Equal(StripeWebhookEndpoints.Route, a.GetTagItem("url.path")));
        }
    }

    // WARNING: The server span above carries NO tags when the whole suite runs — the ASP.NET Core
    // instrumentation is inert in later WebApplicationFactory hosts — so its absence check alone
    // cannot prove redaction. This pins the wiring; StripeWebhookRedactionTests pins the rewrite.
    [Fact]
    public void The_aspnetcore_instrumentation_redacts_every_request_span()
    {
        var options = _factory.Services
            .GetRequiredService<IOptionsMonitor<AspNetCoreTraceInstrumentationOptions>>()
            .Get(Options.DefaultName);

        Assert.NotNull(options.EnrichWithHttpRequest);
        Assert.Equal(
            typeof(StripeWebhookEndpoints).GetMethod(nameof(StripeWebhookEndpoints.RedactSpan)),
            options.EnrichWithHttpRequest.Method);
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
        string? graceSeconds = null,
        string? urlToken = UrlToken,
        string? allowedCidrs = AllowedCidrs,
        string trustedProxyHops = "1") =>
        HostFor(stripe, stripeEnabled, webhookSecret, graceSeconds, urlToken, allowedCidrs, trustedProxyHops)
            .CreateClient();

    private WebApplicationFactory<Program> HostFor(
        FakeStripeHandler? stripe,
        bool stripeEnabled = true,
        string? webhookSecret = WebhookSecret,
        string? graceSeconds = null,
        string? urlToken = UrlToken,
        string? allowedCidrs = AllowedCidrs,
        string trustedProxyHops = "1",
        bool captureLogs = true)
    {
        return _factory.WithWebHostBuilder(builder =>
        {
            builder.UseSetting("STRIPE_ENABLED", stripeEnabled ? "true" : "false");
            builder.UseSetting("STRIPE_WEBHOOK_SECRET", webhookSecret ?? string.Empty);
            builder.UseSetting("STRIPE_WEBHOOK_URL_TOKEN", urlToken ?? string.Empty);
            builder.UseSetting("STRIPE_WEBHOOK_ALLOWED_CIDRS", allowedCidrs ?? string.Empty);
            builder.UseSetting("STRIPE_WEBHOOK_TRUSTED_PROXY_HOPS", trustedProxyHops);
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
                if (captureLogs)
                {
                    services.AddSingleton<ILogger<StripeWebhookService>>(_webhookLog);
                    services.AddSingleton<ILogger<StripePaymentCharger>>(_chargerLog);
                    services.AddSingleton<ILogger<StripeWebhookAccess>>(_accessLog);
                }

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
    }

    private static async Task<HttpResponseMessage> PostAsync(
        HttpClient client, string body, string? signature, string path = Route, string? forwardedFor = ViaProxy)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, path)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };
        if (signature is not null)
        {
            request.Headers.TryAddWithoutValidation("Stripe-Signature", signature);
        }

        if (forwardedFor is not null)
        {
            request.Headers.TryAddWithoutValidation("X-Forwarded-For", forwardedFor);
        }

        return await client.SendAsync(request);
    }

    private static Task<HttpResponseMessage> PostSignedAsync(
        HttpClient client, string body, string? forwardedFor = ViaProxy) =>
        PostAsync(client, body, Sign(body, WebhookSecret), forwardedFor: forwardedFor);

    // WHY: HttpClient cannot set the socket address; TestServer.SendAsync writes the HttpContext.
    private static Task<HttpContext> PostFromSocketAsync(
        WebApplicationFactory<Program> host, IPAddress remote, string body, string forwardedFor) =>
        host.Server.SendAsync(ctx =>
        {
            ctx.Connection.RemoteIpAddress = remote;
            ctx.Request.Method = HttpMethods.Post;
            ctx.Request.Path = Route;
            ctx.Request.ContentType = "application/json";
            ctx.Request.Headers["Stripe-Signature"] = Sign(body, WebhookSecret);
            ctx.Request.Headers["X-Forwarded-For"] = forwardedFor;
            ctx.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes(body));
        });

    private static string CustomerCreated() =>
        Event("customer.created", new { id = "cus_x", @object = "customer" }, out _);

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
