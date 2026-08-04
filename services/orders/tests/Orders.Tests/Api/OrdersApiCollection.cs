using Xunit;

namespace Orders.Tests.Api;

/// <summary>
/// Groups every test class that drives the in-process API, so xUnit runs them one at a
/// time rather than in parallel.
/// </summary>
/// <remarks>
/// <para>
/// The reason is <c>RequestLogTests</c>, which captures Serilog output by swapping
/// <see cref="System.Console.Out"/> for a StringWriter around its request. Console.Out
/// is process-global: while that swap is in place it also captures whatever any other
/// test writes, and those tests' log lines land in its capture. That made the suite fail
/// intermittently depending on timing — the same test passed alone and failed in a full
/// run, which is the signature of a shared-state race rather than a broken assertion.
/// </para>
/// <para>
/// Serialising the collection is the fix rather than making the assertions cleverer,
/// because the conflict is over a process-wide resource that no assertion can partition.
/// The cost is a slower suite for these classes; they share one
/// <c>OrdersApiFactory</c> (and its Testcontainers MySQL) anyway, so they were never
/// running fully independently.
/// </para>
/// </remarks>
[CollectionDefinition(Name)]
public class OrdersApiCollection : ICollectionFixture<OrdersApiFactory>
{
    public const string Name = "orders-api";
}
