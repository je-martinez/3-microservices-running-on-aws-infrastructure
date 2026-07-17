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
public class RequestLogTests : IClassFixture<OrdersApiFactory>
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
            response = await client.GetAsync("/v1/health");
        }
        finally
        {
            Console.SetOut(originalOut);
        }

        Assert.True(response.IsSuccessStatusCode);

        var roots = capture.ToString()
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line => JsonDocument.Parse(line).RootElement)
            .ToList();
        var found = roots.Any(root =>
            root.TryGetProperty("message", out var msg) && msg.GetString() == "request completed");
        Assert.True(found, "Expected a 'request completed' log line.");
        var root = roots.First(r =>
            r.TryGetProperty("message", out var msg) && msg.GetString() == "request completed");

        Assert.Equal("GET", root.GetProperty("http_request_method").GetString());
        Assert.False(string.IsNullOrEmpty(root.GetProperty("http_route").GetString()));

        var statusProp = root.GetProperty("http_response_status_code");
        Assert.Equal(JsonValueKind.Number, statusProp.ValueKind);
        Assert.Equal(200, statusProp.GetInt32());

        var durationProp = root.GetProperty("duration_ms");
        Assert.Equal(JsonValueKind.Number, durationProp.ValueKind);
        Assert.True(durationProp.GetDouble() >= 0);

        Assert.False(string.IsNullOrEmpty(root.GetProperty("trace_id").GetString()));
    }
}
