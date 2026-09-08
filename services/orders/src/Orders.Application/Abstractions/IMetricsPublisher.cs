namespace Orders.Application.Abstractions;

/// <summary>
/// Publishes a custom business metric.
/// CONTRACT: Implementations MUST NOT throw — a metrics backend being unreachable may never
/// fail the operation that produced the metric. See [[logging-context]]
/// </summary>
public interface IMetricsPublisher
{
    Task PublishAsync(
        string name,
        double value,
        IReadOnlyDictionary<string, string> dimensions,
        CancellationToken cancellationToken = default);
}
