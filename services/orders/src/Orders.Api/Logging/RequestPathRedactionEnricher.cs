using Orders.Api.Endpoints;
using Serilog.Core;
using Serilog.Events;

namespace Orders.Api.Logging;

/// <summary>
/// Rewrites <c>RequestPath</c> through <see cref="StripeWebhookEndpoints.RedactPath"/> on every
/// log event.
/// </summary>
/// <remarks>
/// CONTRACT: Do NOT remove — ASP.NET Core's hosting scope stamps the concrete path on EVERY line
/// written during a request, not only on "request completed", and the Stripe webhook's path holds
/// its URL token. See [[2026-09-19-stripe-payments-design]]
/// </remarks>
public sealed class RequestPathRedactionEnricher : ILogEventEnricher
{
    private const string PropertyName = "RequestPath";

    public void Enrich(LogEvent logEvent, ILogEventPropertyFactory propertyFactory)
    {
        if (logEvent.Properties.TryGetValue(PropertyName, out var value)
            && value is ScalarValue { Value: string path }
            && StripeWebhookEndpoints.RedactPath(path) is { } redacted
            && redacted != path)
        {
            logEvent.AddOrUpdateProperty(new LogEventProperty(PropertyName, new ScalarValue(redacted)));
        }
    }
}
