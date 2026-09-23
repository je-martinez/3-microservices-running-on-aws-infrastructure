using System.Diagnostics;

namespace Orders.Infrastructure.Observability;

/// <summary>The trace source for outbound Stripe calls, separate from the SNS and workflow ones.</summary>
/// <remarks>
/// CONTRACT: Program.cs's AddSource(...) must name this EXACT string — an unregistered source
/// creates spans that are silently never exported.
/// See [[ADR-0019-distributed-tracing-opentelemetry]]
/// </remarks>
public static class StripeActivitySource
{
    public const string Name = "orders-stripe";

    public static readonly ActivitySource Source = new(Name);
}
