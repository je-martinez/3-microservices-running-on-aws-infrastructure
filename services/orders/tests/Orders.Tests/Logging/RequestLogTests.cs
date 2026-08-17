using System.Text.Json;
using Orders.Tests.Api;
using Xunit;

namespace Orders.Tests.Logging;

// Verifies UseSerilogRequestLogging (wired in Program.cs) emits one "request
// completed" log line per HTTP request, carrying the shared-schema fields.
// Serilog's Console sink resolves Console.Out per write, so temporarily
// redirecting it to an in-memory StringWriter around the request is enough to
// capture the real request-log pipeline (formatter + middleware) end to end,
// without a bespoke Serilog test sink registered in the host.
[Collection(Orders.Tests.Api.OrdersApiCollection.Name)]
public class RequestLogTests
{
    private readonly OrdersApiFactory _factory;

    public RequestLogTests(OrdersApiFactory factory)
    {
        _factory = factory;
    }

    [Fact]
    public async Task Request_completed_log_contains_shared_schema_fields()
    {
        var client = _factory.CreateClient();
        var originalOut = Console.Out;
        using var capture = new StringWriter();
        Console.SetOut(capture);

        HttpResponseMessage response;
        try
        {
            response = await client.GetAsync("/v1/orders/no-such-order");
        }
        finally
        {
            Console.SetOut(originalOut);
        }

        // A 401: this route needs x-user-id, which the bare client does not send.
        // The status does not matter here — what matters is that a request that
        // reached the pipeline produced exactly one schema-shaped log line.
        Assert.Equal(System.Net.HttpStatusCode.Unauthorized, response.StatusCode);

        // Skip lines that are not JSON rather than parsing every one. The capture is
        // the shared console, so anything else writing there lands in it too —
        // Testcontainers narrates container teardown, and one such line used to fail
        // this test with a JsonReaderException that pointed at Docker output rather
        // than at anything about logging. The assertions below still require a real
        // "request completed" record, so a genuinely missing log line still fails.
        var roots = capture.ToString()
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line =>
            {
                try
                {
                    return (JsonElement?)JsonDocument.Parse(line).RootElement;
                }
                catch (JsonException)
                {
                    return null;
                }
            })
            .Where(root => root is not null)
            .Select(root => root!.Value)
            .ToList();
        var found = roots.Any(root =>
            root.TryGetProperty("message", out var msg) && msg.GetString() == "request completed");
        Assert.True(found, "Expected a 'request completed' log line.");
        var root = roots.First(r =>
            r.TryGetProperty("message", out var msg) && msg.GetString() == "request completed");

        Assert.Equal("GET", root.GetProperty("http_request_method").GetString());
        // Clean route template (from RouteEndpoint.RoutePattern.RawText), not Serilog's
        // debug DisplayName (e.g. "HTTP: GET /v1/orders/{orderId}") — keeps http_route consistent
        // with the Users service's dashboards.
        //
        // NOT /v1/health: a succeeding liveness probe is exempt from this log (see the
        // health-check-logging convention), so asserting the schema against it would be
        // asserting the exemption. This test used to request health and started failing
        // when the exemption landed — correctly.
        Assert.Equal("/v1/orders/{orderId}", root.GetProperty("http_route").GetString());

        var statusProp = root.GetProperty("http_response_status_code");
        Assert.Equal(JsonValueKind.Number, statusProp.ValueKind);
        Assert.Equal(401, statusProp.GetInt32());

        var durationProp = root.GetProperty("duration_ms");
        Assert.Equal(JsonValueKind.Number, durationProp.ValueKind);
        Assert.True(durationProp.GetDouble() >= 0);

        Assert.False(string.IsNullOrEmpty(root.GetProperty("trace_id").GetString()));
    }

    // The liveness probe is exempt from the request log WHILE IT SUCCEEDS — see
    // the health-check-logging convention. It runs forever at a fixed interval,
    // so its successes are volume that scales with uptime rather than with usage
    // (96% of one service's stream when this was measured), and a healthy
    // container already conveys what a 200 here would.
    //
    // A FAILING probe still logs: the exemption is scoped by status, and
    // GetLevel returns Error for 5xx. That branch is not asserted here because
    // forcing this service's real health endpoint to fail would mean changing
    // production code to suit a test; Tracking's suite covers the failing case
    // directly, where the middleware could be driven with a purpose-built app.
    [Fact]
    public async Task Succeeding_health_check_is_not_logged()
    {
        var client = _factory.CreateClient();
        var originalOut = Console.Out;
        using var capture = new StringWriter();
        Console.SetOut(capture);

        HttpResponseMessage response;
        try
        {
            response = await client.GetAsync("/v1/health");
        }
        finally
        {
            Console.SetOut(originalOut);
        }

        Assert.True(response.IsSuccessStatusCode);

        var completed = capture.ToString()
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line =>
            {
                try
                {
                    return (JsonElement?)JsonDocument.Parse(line).RootElement;
                }
                catch (JsonException)
                {
                    return null;
                }
            })
            .Where(root => root is not null)
            .Select(root => root!.Value)
            .Count(root =>
                root.TryGetProperty("message", out var msg) && msg.GetString() == "request completed");

        Assert.Equal(0, completed);
    }
}
