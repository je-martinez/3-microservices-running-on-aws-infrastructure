namespace Orders.Application.Abstractions;

/// <summary>
/// Publishes a custom business metric.
/// </summary>
/// <remarks>
/// Implementations MUST NOT throw. A metrics backend being unreachable may never fail
/// the operation that produced the metric — the same stance <see cref="IEventPublisher"/>
/// takes. The port lives in Application; the CloudWatch implementation lives in
/// Infrastructure, per the dependency-direction rule in this service's CLAUDE.md §3.
/// </remarks>
public interface IMetricsPublisher
{
    Task PublishAsync(
        string name,
        double value,
        IReadOnlyDictionary<string, string> dimensions,
        CancellationToken cancellationToken = default);
}
