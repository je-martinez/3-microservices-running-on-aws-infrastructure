using Xunit;

namespace Orders.Tests.Api;

/// <summary>
/// Groups every test class that drives the in-process API, so xUnit runs them one at a
/// time rather than in parallel.
/// </summary>
/// <remarks>
/// CONTRACT: Keep these serialised. <c>RequestLogTests</c> captures Serilog by swapping the
/// process-global <see cref="System.Console.Out"/>, so in parallel it captures whatever any
/// other test writes and the suite fails intermittently — passing alone, failing in a full
/// run. No assertion can partition a process-wide resource. See [[testing]]
/// </remarks>
[CollectionDefinition(Name)]
public class OrdersApiCollection : ICollectionFixture<OrdersApiFactory>
{
    public const string Name = "orders-api";
}
