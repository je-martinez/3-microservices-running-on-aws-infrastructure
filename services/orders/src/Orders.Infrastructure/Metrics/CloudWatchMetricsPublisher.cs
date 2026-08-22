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
        // A span of OUR OWN, naming the metric. The AWS SDK auto-instrumentation
        // already produces one, but it is called `CloudWatch.PutMetricData` and
        // carries no metric name — this service emitted 1,451 identical,
        // unreadable bars. A waterfall renders names, so the metric belongs in
        // the name, exactly as with `sqs.publish order_created`.
        //
        // The auto-instrumented activity stays as this one's child. That extra
        // level is accepted rather than suppressed: turning SDK instrumentation
        // off in code is the pattern that has silently killed telemetry three
        // times in this repo.
        //
        // Null-conditional throughout: StartActivity returns NULL when no
        // listener is registered for the source (a plain `dotnet test` run, or a
        // host with tracing off), and that is a normal condition, not an error.
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
