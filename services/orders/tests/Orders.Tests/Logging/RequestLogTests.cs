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

        // WHY: A 401 — this route needs x-user-id. The status is incidental; what matters
        // is that a request reaching the pipeline produced one schema-shaped log line.
        Assert.Equal(System.Net.HttpStatusCode.Unauthorized, response.StatusCode);

        // CONTRACT: Skip non-JSON lines rather than parsing every one. The capture is the
        // shared console, so Testcontainers' teardown narration lands in it and fails this
        // test with a JsonReaderException pointing at Docker output. The assertions below
        // still require a real "request completed" record.
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
        // CONTRACT: The clean route template, not Serilog's debug DisplayName, so http_route
        // stays consistent with the Users dashboards. Do NOT assert this against /v1/health —
        // a succeeding probe is exempt from the log, so that asserts the exemption.
        // See [[health-check-logging]]
        Assert.Equal("/v1/orders/{orderId}", root.GetProperty("http_route").GetString());

        var statusProp = root.GetProperty("http_response_status_code");
        Assert.Equal(JsonValueKind.Number, statusProp.ValueKind);
        Assert.Equal(401, statusProp.GetInt32());

        var durationProp = root.GetProperty("duration_ms");
        Assert.Equal(JsonValueKind.Number, durationProp.ValueKind);
        Assert.True(durationProp.GetDouble() >= 0);

        Assert.False(string.IsNullOrEmpty(root.GetProperty("trace_id").GetString()));
    }

    // CONTRACT: The liveness probe is exempt WHILE IT SUCCEEDS — its successes scale with
    // uptime, not usage. A FAILING probe still logs, the exemption being scoped by status;
    // that branch is covered in Tracking's suite rather than by making this service's real
    // health endpoint fail. See [[health-check-logging]]
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
