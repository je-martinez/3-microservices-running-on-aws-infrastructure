using Orders.Application.Abstractions;

namespace Orders.Infrastructure.Metrics;

/// <summary>No-op binding for suites that must not reach CloudWatch.</summary>
public class NoopMetricsPublisher : IMetricsPublisher
{
    public Task PublishAsync(
        string name,
        double value,
        IReadOnlyDictionary<string, string> dimensions,
        CancellationToken cancellationToken = default) => Task.CompletedTask;
}
