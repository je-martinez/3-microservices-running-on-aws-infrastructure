using System.Diagnostics;
using System.Net;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Primitives;
using Orders.Api.Endpoints;
using Orders.Api.Logging;
using Orders.Api.Payments;
using Serilog.Events;
using Serilog.Parsing;

namespace Orders.Tests.Api;

/// <summary>
/// The pure halves of the webhook's two access layers: path redaction and the source/token checks.
/// </summary>
public sealed class StripeWebhookRedactionTests
{
    private const string Token = "ordTok_unit_Zx81Qm";
    private const string ConcretePath = "/v1/orders/stripe/webhook/" + Token;

    [Theory]
    [InlineData(ConcretePath)]
    [InlineData(ConcretePath + "/extra")]
    [InlineData("/V1/Orders/Stripe/Webhook/" + Token)]
    public void Any_path_below_the_webhook_prefix_redacts_to_the_route_template(string path)
    {
        Assert.Equal(StripeWebhookEndpoints.Route, StripeWebhookEndpoints.RedactPath(path));
    }

    [Theory]
    [InlineData("/v1/orders/stripe/webhook")]
    [InlineData("/v1/orders/stripe/webhooks/abc")]
    [InlineData("/v1/orders/ord_123")]
    [InlineData(null)]
    public void Other_paths_are_left_untouched(string? path)
    {
        Assert.Equal(path, StripeWebhookEndpoints.RedactPath(path));
    }

    [Fact]
    public void RedactSpan_rewrites_every_attribute_that_holds_the_concrete_path()
    {
        using var activity = new Activity("test");
        activity.SetTag("url.path", ConcretePath);
        activity.SetTag("http.target", ConcretePath + "?x=1");
        activity.SetTag("url.full", "http://orders:3001" + ConcretePath);
        activity.SetTag("http.request.method", "POST");
        var context = new DefaultHttpContext();
        context.Request.Path = ConcretePath;

        StripeWebhookEndpoints.RedactSpan(activity, context.Request);

        Assert.Equal(StripeWebhookEndpoints.Route, activity.GetTagItem("url.path"));
        Assert.Equal(StripeWebhookEndpoints.Route + "?x=1", activity.GetTagItem("http.target"));
        Assert.Equal("http://orders:3001" + StripeWebhookEndpoints.Route, activity.GetTagItem("url.full"));
        Assert.Equal("POST", activity.GetTagItem("http.request.method"));
        Assert.DoesNotContain(activity.TagObjects, t => t.Value?.ToString()?.Contains(Token) == true);
    }

    [Fact]
    public void The_log_enricher_redacts_the_request_path_scope_property()
    {
        var logEvent = new LogEvent(
            DateTimeOffset.UtcNow,
            LogEventLevel.Information,
            null,
            new MessageTemplateParser().Parse("anything"),
            [new LogEventProperty("RequestPath", new ScalarValue(ConcretePath))]);

        new RequestPathRedactionEnricher().Enrich(logEvent, null!);

        Assert.Equal(StripeWebhookEndpoints.Route, ((ScalarValue)logEvent.Properties["RequestPath"]).Value);
    }

    [Theory]
    [InlineData(Token, true)]
    [InlineData(Token + "x", false)]
    [InlineData("ordTok_unit_Zx81Q", false)]
    [InlineData("ordTok_unit_Zx81Qn", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void The_url_token_matches_only_exactly(string? presented, bool expected)
    {
        var access = new StripeWebhookAccess(Token, StripeWebhookAccess.ParseAllowlist("0.0.0.0/0"), 0);

        Assert.Equal(expected, access.TokenMatches(presented));
    }

    [Fact]
    public void With_no_token_configured_nothing_matches()
    {
        var access = new StripeWebhookAccess(" ", StripeWebhookAccess.ParseAllowlist("0.0.0.0/0"), 0);

        Assert.False(access.TokenConfigured);
        Assert.False(access.TokenMatches(" "));
    }

    [Theory]
    [InlineData("3.18.12.63, 10.0.0.0/8, ::1", true)]
    [InlineData("", false)]
    [InlineData(" , ", false)]
    [InlineData("10.0.0.0/8, stripe.com", false)]
    [InlineData("10.0.0.0/33", false)]
    public void An_allowlist_with_any_invalid_entry_is_rejected_whole(string raw, bool valid)
    {
        Assert.Equal(valid, StripeWebhookAccess.ParseAllowlist(raw) is not null);
    }

    [Fact]
    public void The_client_ip_is_counted_from_the_right_of_x_forwarded_for_across_headers()
    {
        var access = new StripeWebhookAccess(Token, StripeWebhookAccess.ParseAllowlist("0.0.0.0/0"), 2);

        var ip = access.ResolveClientIp(
            IPAddress.Loopback, new StringValues(["198.51.100.7, 203.0.113.10", "10.0.0.5"]));

        Assert.Equal(IPAddress.Parse("203.0.113.10"), ip);
    }

    [Fact]
    public void Fewer_forwarded_entries_than_trusted_hops_resolve_to_no_client()
    {
        var access = new StripeWebhookAccess(Token, StripeWebhookAccess.ParseAllowlist("0.0.0.0/0"), 2);

        Assert.Null(access.ResolveClientIp(IPAddress.Loopback, new StringValues("203.0.113.10")));
    }

    [Fact]
    public void An_ipv4_mapped_socket_address_is_matched_as_ipv4()
    {
        var access = new StripeWebhookAccess(Token, StripeWebhookAccess.ParseAllowlist("127.0.0.0/8"), 0);

        var ip = access.ResolveClientIp(IPAddress.Parse("::ffff:127.0.0.1"), StringValues.Empty);

        Assert.NotNull(ip);
        Assert.True(access.IsAllowed(ip));
    }
}
