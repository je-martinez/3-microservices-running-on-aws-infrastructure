using System.Collections.Concurrent;
using System.Net;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Orders.Application.Abstractions;
using Xunit;

namespace Orders.Tests.Api;

// Pins that the middleware observes the FINAL status, including the 401 short-circuited
// before routing, which an endpoint filter would miss.
// CONTRACT: Filter assertions on the metric NAME rather than counting publications — the
// OrdersMetricsPublisher hosted service ticks against the same IMetricsPublisher. Its own
// host, so the recording publisher replaces the fixture's Noop.
[Collection(OrdersApiCollection.Name)]
public class HttpErrorMetricsTests
{
    private readonly OrdersApiFactory _factory;
    public HttpErrorMetricsTests(OrdersApiFactory factory) => _factory = factory;

    private sealed record Publication(string Name, double Value, IReadOnlyDictionary<string, string> Dimensions);

    private sealed class RecordingMetricsPublisher : IMetricsPublisher
    {
        public ConcurrentQueue<Publication> Published { get; } = new();

        public Task PublishAsync(
            string name,
            double value,
            IReadOnlyDictionary<string, string> dimensions,
            CancellationToken cancellationToken = default)
        {
            Published.Enqueue(new Publication(name, value, dimensions));
            return Task.CompletedTask;
        }
    }

    private (HttpClient Client, RecordingMetricsPublisher Metrics) BuildClient()
    {
        var metrics = new RecordingMetricsPublisher();
        var host = _factory.WithWebHostBuilder(builder =>
        {
            builder.ConfigureTestServices(services =>
            {
                // Same Single/Remove/re-add idiom the factory uses for the Noop.
                var descriptor = services.Single(d => d.ServiceType == typeof(IMetricsPublisher));
                services.Remove(descriptor);
                services.AddSingleton<IMetricsPublisher>(metrics);
            });
        });
        return (host.CreateClient(), metrics);
    }

    private static List<Publication> HttpErrors(RecordingMetricsPublisher metrics) =>
        metrics.Published.Where(p => p.Name == "http_errors_total").ToList();

    [Fact]
    public async Task Publishes_http_errors_total_with_4xx_on_an_unauthenticated_request()
    {
        var (client, metrics) = BuildClient();

        // No x-user-id: CallerContextMiddleware short-circuits with 401.
        var response = await client.GetAsync("/v1/orders/my-orders");

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        var errors = HttpErrors(metrics);
        var published = Assert.Single(errors);
        Assert.Equal(1, published.Value);
        Assert.Equal("orders", published.Dimensions["Service"]);
        Assert.Equal("4xx", published.Dimensions["StatusClass"]);
        Assert.Equal(2, published.Dimensions.Count);
    }

    [Fact]
    public async Task Publishes_nothing_on_a_successful_response()
    {
        var (client, metrics) = BuildClient();

        var response = await client.GetAsync("/v1/health");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Empty(HttpErrors(metrics));
    }
}
