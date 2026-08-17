using Amazon.CloudWatch;
using Amazon.CloudWatch.Model;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using Orders.Infrastructure.Metrics;

namespace Orders.Tests.Metrics;

/// <summary>
/// Pins the exact <see cref="PutMetricDataRequest"/> the publisher puts on the wire.
/// </summary>
/// <remarks>
/// The dimension set is asserted literally because Floci does not aggregate across
/// dimensions: a collector query naming a different set returns an EMPTY result with
/// StatusCode "Complete" — a silent no-data, not an error.
/// </remarks>
public class CloudWatchMetricsPublisherTests
{
    [Fact]
    public async Task PublishAsync_SendsOneDatumInThe3mraiNamespace()
    {
        PutMetricDataRequest? captured = null;
        var client = new Mock<IAmazonCloudWatch>();
        client
            .Setup(c => c.PutMetricDataAsync(It.IsAny<PutMetricDataRequest>(), It.IsAny<CancellationToken>()))
            .Callback<PutMetricDataRequest, CancellationToken>((r, _) => captured = r)
            .ReturnsAsync(new PutMetricDataResponse());

        var publisher = new CloudWatchMetricsPublisher(
            client.Object, NullLogger<CloudWatchMetricsPublisher>.Instance);

        await publisher.PublishAsync("orders_total", 42, new Dictionary<string, string>
        {
            ["Service"] = "orders",
        });

        Assert.NotNull(captured);
        Assert.Equal("3MRAI", captured!.Namespace);
        var datum = Assert.Single(captured.MetricData);
        Assert.Equal("orders_total", datum.MetricName);
        Assert.Equal(42, datum.Value);
        var dimension = Assert.Single(datum.Dimensions);
        Assert.Equal("Service", dimension.Name);
        Assert.Equal("orders", dimension.Value);
    }

    [Fact]
    public async Task PublishAsync_SwallowsClientFailures()
    {
        var client = new Mock<IAmazonCloudWatch>();
        client
            .Setup(c => c.PutMetricDataAsync(It.IsAny<PutMetricDataRequest>(), It.IsAny<CancellationToken>()))
            .ThrowsAsync(new AmazonCloudWatchException("CloudWatch is down"));

        var publisher = new CloudWatchMetricsPublisher(
            client.Object, NullLogger<CloudWatchMetricsPublisher>.Instance);

        // Must not throw: a metric failure may never break the caller.
        await publisher.PublishAsync("orders_total", 1, new Dictionary<string, string>
        {
            ["Service"] = "orders",
        });
    }
}
