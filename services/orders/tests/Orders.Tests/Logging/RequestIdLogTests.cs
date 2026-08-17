using System.Text.Json;
using Orders.Tests.Api;
using Xunit;

namespace Orders.Tests.Logging;

// Verifies request_id reaches the logger's REAL OUTPUT — not just the ambient
// context — through the whole Program pipeline: CallerContextMiddleware seeds it,
// LogContextEnricher stamps it onto the event, the formatter emits it.
//
// Uses the same Console-redirect capture as RequestLogTests: Serilog's Console
// sink resolves Console.Out per write, so swapping it for a StringWriter around
// the request captures the genuine pipeline without a bespoke test sink.
[Collection(Orders.Tests.Api.OrdersApiCollection.Name)]
public class RequestIdLogTests
{
    private const string ValidId = "req_V1StGXR8Z5jdHi6BMyTqWxYz";

    private readonly OrdersApiFactory _factory;

    public RequestIdLogTests(OrdersApiFactory factory)
    {
        _factory = factory;
    }

    [Fact]
    public async Task A_valid_inbound_request_id_is_logged_as_sent()
    {
        var (_, requestId) = await CaptureRequestCompleted("/v1/orders/my-orders", "sub-1", ValidId);

        // The caller's own id, unchanged: this is what makes one flow greppable
        // across both services' log streams.
        Assert.Equal(ValidId, requestId);
    }

    [Fact]
    public async Task A_request_without_the_header_still_logs_a_generated_id()
    {
        var (_, requestId) = await CaptureRequestCompleted("/v1/orders/my-orders", "sub-1", requestId: null);

        // Absent is the common case and must never mean an uncorrelated line.
        Assert.NotNull(requestId);
        Assert.StartsWith("req_", requestId);
        Assert.Equal(28, requestId!.Length);
    }

    [Theory]
    // A forged/mangled header of every shape the validator rejects. None may reach
    // the log line: whatever appears in request_id is copied onto every record of
    // the flow and forwarded downstream.
    [InlineData("ord_V1StGXR8Z5jdHi6BMyTqWxYz")]
    [InlineData("not-a-request-id")]
    [InlineData("req_short")]
    public async Task A_forged_header_is_not_honoured(string forged)
    {
        var (status, requestId) = await CaptureRequestCompleted("/v1/orders/my-orders", "sub-1", forged);

        // Discarded and replaced...
        Assert.NotEqual(forged, requestId);
        Assert.StartsWith("req_", requestId);
        // ...without failing the request. A correlation header is not part of the
        // route's contract, so a bad one must never turn into a 400.
        Assert.Equal(200, status);
    }

    [Fact]
    public async Task A_401_still_carries_a_request_id()
    {
        // THE ordering bug this pins. If the id were seeded after the auth guard,
        // it would never reach a short-circuited 401 — and an unauthenticated
        // request is exactly the one someone comes asking about later. The same
        // mistake was caught by the equivalent test in the Users service.
        var (status, requestId) = await CaptureRequestCompleted(
            "/v1/orders/my-orders", cognitoSub: null, requestId: ValidId);

        Assert.Equal(401, status);
        // And the caller's own id survives the short-circuit, so the 401 can be
        // joined to whatever the caller logged on their side.
        Assert.Equal(ValidId, requestId);
    }

    [Fact]
    public async Task A_401_without_the_header_still_carries_a_generated_id()
    {
        var (status, requestId) = await CaptureRequestCompleted(
            "/v1/orders/my-orders", cognitoSub: null, requestId: null);

        Assert.Equal(401, status);
        Assert.NotNull(requestId);
        Assert.StartsWith("req_", requestId);
    }

    // Issues one request with the console captured and returns the status and the
    // request_id from the "request completed" line the pipeline actually emitted.
    private async Task<(int Status, string? RequestId)> CaptureRequestCompleted(
        string path, string? cognitoSub, string? requestId)
    {
        var client = _factory.CreateClient();
        using var message = new HttpRequestMessage(HttpMethod.Get, path);
        if (cognitoSub is not null) message.Headers.Add("x-user-id", cognitoSub);
        if (requestId is not null) message.Headers.Add("x-request-id", requestId);

        var originalOut = Console.Out;
        using var capture = new StringWriter();
        Console.SetOut(capture);

        HttpResponseMessage response;
        try
        {
            response = await client.SendAsync(message);
        }
        finally
        {
            Console.SetOut(originalOut);
        }

        // Non-JSON lines are skipped rather than parsed: the capture is the shared
        // console, so Testcontainers' teardown narration lands in it too (see the
        // same note in RequestLogTests). A genuinely missing log line still fails
        // the assertion below.
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
            .FirstOrDefault(root =>
                root.TryGetProperty("message", out var msg) && msg.GetString() == "request completed");

        Assert.True(
            completed.ValueKind == JsonValueKind.Object,
            "Expected a 'request completed' log line.");

        // Read off the emitted JSON, never from the in-memory context: a field that
        // never makes it through the enricher and formatter is not observable.
        var id = completed.TryGetProperty("request_id", out var prop) ? prop.GetString() : null;

        return ((int)response.StatusCode, id);
    }
}
