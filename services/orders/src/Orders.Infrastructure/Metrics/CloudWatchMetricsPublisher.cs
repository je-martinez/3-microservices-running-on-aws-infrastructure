using System.Diagnostics;
using Amazon.CloudWatch;
using Amazon.CloudWatch.Model;
using Microsoft.Extensions.Logging;
using Orders.Application.Abstractions;

namespace Orders.Infrastructure.Metrics;

public class CloudWatchMetricsPublisher : IMetricsPublisher
{
    /// <summary>The one namespace every 3MRAI metric is published under.</summary>
    public const string MetricsNamespace = "3MRAI";

    /// <summary>
    /// Activity source for this publisher's spans. Named for its area, like
    /// SqsEventPublisher's "orders-messaging", and registered with the tracer
    /// provider in Program.cs — an unregistered source produces NO activities at
    /// all, silently.
    /// </summary>
    public const string ActivitySourceName = "orders-metrics";

    private static readonly ActivitySource Source = new(ActivitySourceName);

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
        // CONTRACT: A span of our own, naming the metric — the SDK's auto-instrumented span
        // is called `CloudWatch.PutMetricData` and carries no metric name, so a waterfall
        // renders hundreds of identical, unreadable bars. Do NOT suppress the SDK's span to
        // remove the extra level: turning instrumentation off in code has silently killed
        // telemetry three times here. Null-conditional throughout, since StartActivity returns
        // null with no listener registered. See [[ADR-0019-distributed-tracing-opentelemetry]]
        using var activity = Source.StartActivity(
            $"cloudwatch PutMetricData {name}",
            ActivityKind.Client);
        activity?.SetTag("rpc.system", "aws-api");
        activity?.SetTag("rpc.service", "CloudWatch");
        activity?.SetTag("rpc.method", "PutMetricData");
        activity?.SetTag("metric.name", name);

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
            activity?.SetStatus(ActivityStatusCode.Ok);
        }
        catch (Exception ex)
        {
            // The span records the outcome of the CALL; the method still returns
            // normally, because swallowing is this publisher's contract.
            activity?.SetStatus(ActivityStatusCode.Error, ex.Message);
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
