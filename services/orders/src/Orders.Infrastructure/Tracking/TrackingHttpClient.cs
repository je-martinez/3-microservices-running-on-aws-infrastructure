using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;
using Orders.Application.Tracking;

namespace Orders.Infrastructure.Tracking;

// Typed HTTP client for Tracking's creation endpoint:
//   POST {TRACKING_BASE_URL}/v1/trackings/init-tracking
//
// Lives in Infrastructure (not Application) because it touches HttpClient —
// same split as IUserDirectory / UserDirectoryGrpcClient.
//
// Contract (docs/domains/tracking/specs/tracking-service-design.md):
//   body    { order_id, shipping_address }  — snake_case, NO identity in the body
//   header  x-user-id    the caller's Cognito sub, FORWARDED from what Orders
//                        received at the gateway; Tracking resolves the internal
//                        usr_ id itself
//   header  x-test-mode  "true" activates TestMode; anything else is false
//   2xx  created · 409 already tracked · 404 caller unresolvable · 401 header missing
//
// Never throws for a downstream failure — see TrackingInitOutcome for why the
// outcome is returned rather than raised.
public class TrackingHttpClient : ITrackingInitiator
{
    // Relative on purpose: the base address (TRACKING_BASE_URL) is configured on
    // the HttpClient, so the path never hardcodes a host. No leading slash, so it
    // appends to a base address that may carry a path prefix.
    internal const string InitTrackingPath = "v1/trackings/init-tracking";

    private readonly HttpClient _http;
    private readonly ILogger<TrackingHttpClient> _logger;

    public TrackingHttpClient(HttpClient http, ILogger<TrackingHttpClient> logger)
    {
        _http = http;
        _logger = logger;
    }

    public async Task<TrackingInitResult> InitTrackingAsync(
        string orderId,
        string? shippingAddressJson,
        string cognitoSub,
        bool testMode,
        CancellationToken ct = default)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, InitTrackingPath)
        {
            Content = JsonContent.Create(
                new InitTrackingRequest(orderId, ParseAddress(shippingAddressJson)),
                options: JsonOptions),
        };

        // Identity travels in headers, never in the body.
        request.Headers.TryAddWithoutValidation("x-user-id", cognitoSub);
        // Only the literal "true" activates TestMode on the far side; sending the
        // explicit "false" keeps the header's meaning unambiguous in a capture.
        request.Headers.TryAddWithoutValidation("x-test-mode", testMode ? "true" : "false");

        try
        {
            using var response = await _http.SendAsync(request, ct);
            return Classify(orderId, (int)response.StatusCode);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            // HttpClient surfaces its own timeout as a cancellation; the guard
            // distinguishes it from the caller genuinely cancelling, which must
            // propagate untouched.
            _logger.LogError(
                "Tracking initiation failed {app_event} {reason} {order_id}",
                "init_tracking_failed", "timeout", orderId);
            return new TrackingInitResult(TrackingInitOutcome.Unreachable, null);
        }
        catch (HttpRequestException ex)
        {
            // Connection refused / DNS failure / socket reset: no response ever
            // existed. Log the reason, not the exception body — a request dump
            // could carry the shipping address.
            _logger.LogError(
                "Tracking initiation failed {app_event} {reason} {order_id} {error}",
                "init_tracking_failed", "unreachable", orderId, ex.Message);
            return new TrackingInitResult(TrackingInitOutcome.Unreachable, null);
        }
    }

    private TrackingInitResult Classify(string orderId, int status)
    {
        if (status is >= 200 and < 300)
        {
            _logger.LogInformation(
                "Tracking initiated {app_event} {order_id}",
                "init_tracking_succeeded", orderId);
            return new TrackingInitResult(TrackingInitOutcome.Created, status);
        }

        // 409 is Tracking's idempotency guard: the order is already tracked, which
        // is the end state we wanted. Logged as INFO, not an error, and reported
        // as a tracked outcome.
        if (status == (int)HttpStatusCode.Conflict)
        {
            _logger.LogInformation(
                "Tracking already existed for this order {app_event} {order_id}",
                "init_tracking_succeeded", orderId);
            return new TrackingInitResult(TrackingInitOutcome.AlreadyTracked, status);
        }

        var outcome = status switch
        {
            (int)HttpStatusCode.NotFound => TrackingInitOutcome.UnknownUser,
            (int)HttpStatusCode.Unauthorized => TrackingInitOutcome.Unauthorized,
            _ => TrackingInitOutcome.Failed,
        };

        var reason = outcome switch
        {
            TrackingInitOutcome.UnknownUser => "unknown_user",
            TrackingInitOutcome.Unauthorized => "missing_user_header",
            _ => "tracking_rejected",
        };

        _logger.LogError(
            "Tracking initiation failed {app_event} {reason} {order_id} {status_code}",
            "init_tracking_failed", reason, orderId, status);

        return new TrackingInitResult(outcome, status);
    }

    // The address is already JSON on the Order entity, so it is re-parsed into a
    // JsonElement and embedded as a real JSON value rather than re-encoded as a
    // string-of-JSON, which would reach Tracking double-escaped. Malformed or
    // absent input becomes null: an address we cannot parse must never block the
    // call, and must never be echoed into a log line (PII).
    private JsonElement? ParseAddress(string? shippingAddressJson)
    {
        if (string.IsNullOrWhiteSpace(shippingAddressJson))
            return null;

        try
        {
            using var document = JsonDocument.Parse(shippingAddressJson);
            return document.RootElement.Clone();
        }
        catch (JsonException)
        {
            _logger.LogWarning(
                "Shipping address snapshot is not valid JSON; sending null {app_event}",
                "init_tracking_address_unparsable");
            return null;
        }
    }

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        // The property names below are already snake_case literals; this only
        // guards against a future property added without an explicit name.
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };

    // Wire shape. shipping_address is emitted even when null, so Tracking always
    // sees the field. Identity is deliberately absent — it rides in x-user-id.
    private sealed record InitTrackingRequest(
        [property: JsonPropertyName("order_id")] string OrderId,
        [property: JsonPropertyName("shipping_address")] JsonElement? ShippingAddress);
}
