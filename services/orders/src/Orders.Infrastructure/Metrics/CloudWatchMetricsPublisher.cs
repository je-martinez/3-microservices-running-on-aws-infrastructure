using Amazon.CloudWatch;
using Amazon.CloudWatch.Model;
using Microsoft.Extensions.Logging;
using Orders.Application.Abstractions;

namespace Orders.Infrastructure.Metrics;

public class CloudWatchMetricsPublisher : IMetricsPublisher
{
    /// <summary>The one namespace every 3MRAI metric is published under.</summary>
    public const string MetricsNamespace = "3MRAI";

    private readonly IAmazonCloudWatch _client;
    private readonly ILogger<CloudWatchMetricsPublisher> _logger;

    public CloudWatchMetricsPublisher(
        IAmazonCloudWatch client,
        ILogger<CloudWatchMetricsPublisher> logger)
    {
        _client = client;
        _logger = logger;
    }

    public async Task PublishAsync(
        string name,
        double value,
        IReadOnlyDictionary<string, string> dimensions,
        CancellationToken cancellationToken = default)
    {
        try
        {
            await _client.PutMetricDataAsync(
                new PutMetricDataRequest
                {
                    Namespace = MetricsNamespace,
                    MetricData =
                    [
                        new MetricDatum
                        {
                            MetricName = name,
                            Value = value,
                            Unit = StandardUnit.Count,
                            // The exact dimension set matters: the collector must query
                            // the same one, since Floci does not aggregate across
                            // dimensions and answers a mismatched query with an EMPTY
                            // result rather than an error.
                            Dimensions = dimensions
                                .Select(d => new Dimension { Name = d.Key, Value = d.Value })
                                .ToList(),
                        },
                    ],
                },
                cancellationToken);
        }
        catch (Exception ex)
        {
            // Swallowed on purpose — see IMetricsPublisher's remarks.
            _logger.LogWarning(
                ex,
                "{app_event} metric={metric_name} reason={reason}",
                "metric_publish_failed",
                name,
                ex.Message);
        }
    }
}
