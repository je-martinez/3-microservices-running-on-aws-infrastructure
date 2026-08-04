using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Orders.Application.Tracking;
using Orders.Infrastructure.Tracking;

namespace Orders.Tests.Infrastructure;

// Exercises the Tracking HTTP client against a stub HttpMessageHandler — the
// standard way to verify a typed client's wire contract without a live server.
// Covers the request shape (path, snake_case body, both headers) and every
// response class the client classifies: 2xx, 409, 404, 401, other non-success,
// and a transport failure.
public class TrackingHttpClientTests
{
    private const string BaseAddress = "http://tracking:8000/";

    private static (TrackingHttpClient Client, StubHandler Handler) Build(
        HttpStatusCode status = HttpStatusCode.Created)
    {
        var handler = new StubHandler { Status = status };
        var http = new HttpClient(handler) { BaseAddress = new Uri(BaseAddress) };
        return (new TrackingHttpClient(http, NullLogger<TrackingHttpClient>.Instance), handler);
    }

    [Fact]
    public async Task Posts_to_init_tracking_path_with_snake_case_body_and_both_headers()
    {
        var (client, handler) = Build();

        var result = await client.InitTrackingAsync(
            "ord_abc",
            """{"street":"1 Main St","city":"Austin"}""",
            "sub-123",
            testMode: true,
            e2eSource: true);

        Assert.Equal(TrackingInitOutcome.Created, result.Outcome);

        var request = handler.Request!;
        Assert.Equal(HttpMethod.Post, request.Method);
        Assert.Equal("http://tracking:8000/v1/trackings/init-tracking", request.RequestUri!.ToString());

        // Identity is a header, never the body.
        Assert.Equal("sub-123", request.Headers.GetValues("x-user-id").Single());
        Assert.Equal("true", request.Headers.GetValues("x-test-mode").Single());
        // Tracking tags its own record from this, so an E2E run's rows are removable by
        // tag on both sides of the seam.
        Assert.Equal("true", request.Headers.GetValues("x-e2e-source").Single());

        using var body = JsonDocument.Parse(handler.Body!);
        var root = body.RootElement;

        // snake_case field names, and nothing beyond the two contract fields.
        Assert.Equal(
            new[] { "order_id", "shipping_address" },
            root.EnumerateObject().Select(p => p.Name).ToArray());
        Assert.Equal("ord_abc", root.GetProperty("order_id").GetString());

        // The address travels as a real JSON object, not a double-escaped string.
        var address = root.GetProperty("shipping_address");
        Assert.Equal(JsonValueKind.Object, address.ValueKind);
        Assert.Equal("Austin", address.GetProperty("city").GetString());
    }

    [Fact]
    public async Task Sends_test_mode_false_when_not_requested()
    {
        var (client, handler) = Build();

        await client.InitTrackingAsync("ord_abc", null, "sub-123", testMode: false);

        Assert.Equal("false", handler.Request!.Headers.GetValues("x-test-mode").Single());
    }

    [Fact]
    public async Task Sends_e2e_source_false_when_not_requested()
    {
        var (client, handler) = Build();

        await client.InitTrackingAsync("ord_abc", null, "sub-123", testMode: false);

        // Explicit "false" rather than an omitted header, same convention as
        // x-test-mode: the header's meaning stays unambiguous in a traffic capture.
        Assert.Equal("false", handler.Request!.Headers.GetValues("x-e2e-source").Single());
    }

    [Fact]
    public async Task Sends_null_shipping_address_when_the_order_has_none()
    {
        var (client, handler) = Build();

        await client.InitTrackingAsync("ord_abc", null, "sub-123", testMode: false);

        using var body = JsonDocument.Parse(handler.Body!);
        Assert.Equal(JsonValueKind.Null, body.RootElement.GetProperty("shipping_address").ValueKind);
    }

    [Theory]
    [InlineData(HttpStatusCode.OK)]
    [InlineData(HttpStatusCode.Created)]
    [InlineData(HttpStatusCode.Accepted)]
    public async Task Any_2xx_is_created(HttpStatusCode status)
    {
        var (client, _) = Build(status);

        var result = await client.InitTrackingAsync("ord_abc", null, "sub-123", testMode: false);

        Assert.Equal(TrackingInitOutcome.Created, result.Outcome);
        Assert.Equal((int)status, result.StatusCode);
        Assert.True(result.IsTracked);
    }

    [Fact]
    public async Task Conflict_is_already_tracked_and_counts_as_tracked()
    {
        var (client, _) = Build(HttpStatusCode.Conflict);

        var result = await client.InitTrackingAsync("ord_abc", null, "sub-123", testMode: false);

        // 409 is Tracking's idempotency guard — the desired end state holds, so
        // this must never be reported as a failure.
        Assert.Equal(TrackingInitOutcome.AlreadyTracked, result.Outcome);
        Assert.Equal(409, result.StatusCode);
        Assert.True(result.IsTracked);
    }

    [Fact]
    public async Task Not_found_is_unknown_user()
    {
        var (client, _) = Build(HttpStatusCode.NotFound);

        var result = await client.InitTrackingAsync("ord_abc", null, "sub-nope", testMode: false);

        Assert.Equal(TrackingInitOutcome.UnknownUser, result.Outcome);
        Assert.Equal(404, result.StatusCode);
        Assert.False(result.IsTracked);
    }

    [Fact]
    public async Task Unauthorized_is_reported_as_unauthorized()
    {
        var (client, _) = Build(HttpStatusCode.Unauthorized);

        var result = await client.InitTrackingAsync("ord_abc", null, "", testMode: false);

        Assert.Equal(TrackingInitOutcome.Unauthorized, result.Outcome);
        Assert.Equal(401, result.StatusCode);
        Assert.False(result.IsTracked);
    }

    [Fact]
    public async Task Other_non_success_is_failed()
    {
        var (client, _) = Build(HttpStatusCode.InternalServerError);

        var result = await client.InitTrackingAsync("ord_abc", null, "sub-123", testMode: false);

        Assert.Equal(TrackingInitOutcome.Failed, result.Outcome);
        Assert.Equal(500, result.StatusCode);
        Assert.False(result.IsTracked);
    }

    [Fact]
    public async Task Transport_failure_is_unreachable_and_does_not_throw()
    {
        var handler = new StubHandler { Throw = new HttpRequestException("connection refused") };
        var http = new HttpClient(handler) { BaseAddress = new Uri(BaseAddress) };
        var client = new TrackingHttpClient(http, NullLogger<TrackingHttpClient>.Instance);

        var result = await client.InitTrackingAsync("ord_abc", null, "sub-123", testMode: false);

        // A downstream outage must surface as a value, never as an exception the
        // order-creation path would have to catch.
        Assert.Equal(TrackingInitOutcome.Unreachable, result.Outcome);
        Assert.Null(result.StatusCode);
        Assert.False(result.IsTracked);
    }

    [Fact]
    public async Task Timeout_is_unreachable_and_does_not_throw()
    {
        // HttpClient surfaces its own timeout as an OperationCanceledException
        // with no caller cancellation in flight.
        var handler = new StubHandler { Throw = new TaskCanceledException("timed out") };
        var http = new HttpClient(handler) { BaseAddress = new Uri(BaseAddress) };
        var client = new TrackingHttpClient(http, NullLogger<TrackingHttpClient>.Instance);

        var result = await client.InitTrackingAsync("ord_abc", null, "sub-123", testMode: false);

        Assert.Equal(TrackingInitOutcome.Unreachable, result.Outcome);
        Assert.Null(result.StatusCode);
    }

    [Fact]
    public async Task Caller_cancellation_still_propagates()
    {
        var handler = new StubHandler();
        var http = new HttpClient(handler) { BaseAddress = new Uri(BaseAddress) };
        var client = new TrackingHttpClient(http, NullLogger<TrackingHttpClient>.Instance);

        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        // Genuine cancellation is not a Tracking failure; it must not be swallowed
        // into an Unreachable result.
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => client.InitTrackingAsync("ord_abc", null, "sub-123", false, ct: cts.Token));
    }

    [Fact]
    public async Task Unparsable_address_is_sent_as_null_rather_than_failing()
    {
        var (client, handler) = Build();

        var result = await client.InitTrackingAsync("ord_abc", "not json at all", "sub-123", false);

        Assert.Equal(TrackingInitOutcome.Created, result.Outcome);
        using var body = JsonDocument.Parse(handler.Body!);
        Assert.Equal(JsonValueKind.Null, body.RootElement.GetProperty("shipping_address").ValueKind);
    }

    // Records the outgoing request and replays a canned status (or throws).
    private sealed class StubHandler : HttpMessageHandler
    {
        public HttpStatusCode Status { get; init; } = HttpStatusCode.Created;
        public Exception? Throw { get; init; }
        public HttpRequestMessage? Request { get; private set; }
        public string? Body { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();

            Request = request;
            // Buffer the body here: the client disposes the request when SendAsync
            // returns, so the content is unreadable by the time the test asserts.
            Body = request.Content is null ? null : await request.Content.ReadAsStringAsync(CancellationToken.None);

            if (Throw is not null) throw Throw;

            return new HttpResponseMessage(Status);
        }
    }
}
