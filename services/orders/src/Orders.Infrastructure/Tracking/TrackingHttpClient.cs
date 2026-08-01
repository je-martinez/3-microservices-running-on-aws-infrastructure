using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;
using Orders.Application.Tracking;
using RestSharp;

namespace Orders.Infrastructure.Tracking;

// Typed HTTP client for Tracking, covering both directions of the seam:
//   POST {TRACKING_BASE_URL}/v1/trackings/init-tracking   (creation)
//   GET  {TRACKING_BASE_URL}/v1/trackings?order_ids=<csv> (batch read)
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
// The read returns Tracking's JSON verbatim: no DTO, no mapping, no validation,
// so a field Tracking adds reaches the client without a change here. Both
// operations degrade instead of throwing — see TrackingInitOutcome and
// ITrackingReader for why the outcome is returned rather than raised.
public class TrackingHttpClient : ITrackingInitiator, ITrackingReader
{
    // Relative on purpose: the base address (TRACKING_BASE_URL) is configured on
    // the HttpClient, so the path never hardcodes a host. No leading slash, so it
    // appends to a base address that may carry a path prefix.
    internal const string InitTrackingPath = "v1/trackings/init-tracking";

    // The batch read. Same relative-path reasoning as above.
    internal const string TrackingsPath = "v1/trackings";

    // Read budget, deliberately tighter than the client-wide timeout configured in
    // Program.cs for creation. This call decorates an order read: the order data is
    // already in hand and the tracking section is optional, so a slow Tracking must
    // cost the caller a bounded fraction of the endpoint budget and then be dropped,
    // never turn a fast order read into a slow one. Enforced per-call with a linked
    // token so it composes with (and never overrides) the caller's own cancellation.
    internal static readonly TimeSpan ReadTimeout = TimeSpan.FromSeconds(2);

    private readonly RestClient _rest;
    private readonly ILogger<TrackingHttpClient> _logger;

    // Still takes an HttpClient even though nothing stores it: that parameter is how
    // AddHttpClient hands over the configured, pooled instance, and it is what the
    // RestClient below is built on.
    public TrackingHttpClient(HttpClient http, ILogger<TrackingHttpClient> logger)
    {
        _logger = logger;

        // Wraps the injected HttpClient rather than constructing its own. That client
        // comes from AddHttpClient, so it carries the configured BaseAddress and, more
        // importantly, the pooled HttpMessageHandler — a RestClient built from a bare
        // URL would open a second, unmanaged connection pool to the same service and
        // reintroduce the socket-exhaustion problem AddHttpClient exists to solve.
        // disposeHttpClient stays false: the DI container owns that instance's lifetime.
        _rest = new RestClient(http, disposeHttpClient: false);
    }

    public async Task<TrackingInitResult> InitTrackingAsync(
        string orderId,
        string? shippingAddressJson,
        string cognitoSub,
        bool testMode,
        CancellationToken ct = default)
    {
        var request = new RestRequest(InitTrackingPath, Method.Post)
            // Identity travels in headers, never in the body.
            .AddHeader("x-user-id", cognitoSub)
            // Only the literal "true" activates TestMode on the far side; sending the
            // explicit "false" keeps the header's meaning unambiguous in a capture.
            .AddHeader("x-test-mode", testMode ? "true" : "false")
            .AddJsonBody(new InitTrackingRequest(orderId, ParseAddress(shippingAddressJson)));

        // ExecuteAsync, not PostAsync: the Execute* family reports failure on the
        // response rather than throwing, which keeps every outcome — 2xx, 4xx, and no
        // response at all — flowing through the same Classify call below.
        var response = await _rest.ExecuteAsync(request, ct);

        // Branch on whether a status code came back at all, which is the only thing
        // that actually separates "the server answered" from "nothing answered".
        //
        // Two RestSharp details make the more obvious properties wrong here, and both
        // cost a round of failing tests to find. ErrorException is populated for
        // server-side error statuses too, so keying off it classified every 404 and
        // 409 as unreachable. ResponseStatus is no better: it is Error for 4xx/5xx
        // (404 excepted), which is the same conflation. But a transport failure has
        // no HTTP status to report — RestSharp leaves StatusCode at 0 — while a 409
        // has one. That is the real signal.
        // RestSharp CATCHES cancellation and reports it on the response, where
        // HttpClient threw it. That difference matters: a caller who gave up is not a
        // Tracking failure, and reporting it as Unreachable would make an abandoned
        // request look like an outage in the logs. Rethrow before the degrade path so
        // genuine cancellation still propagates untouched.
        ct.ThrowIfCancellationRequested();

        if (response.StatusCode == default)
        {
            // The reason, never the exception body — a request dump could carry the
            // shipping address. Timeout and unreachable stay distinct: a slow Tracking
            // and an absent one are different operational problems, even though both
            // leave the order created and its tracking absent.
            _logger.LogError(
                "Tracking initiation failed {app_event} {reason} {order_id} {error}",
                "init_tracking_failed",
                response.ResponseStatus == ResponseStatus.TimedOut ? "timeout" : "unreachable",
                orderId,
                response.ErrorException?.Message ?? response.ErrorMessage ?? "no response");

            return new TrackingInitResult(TrackingInitOutcome.Unreachable, null);
        }

        // Every status the server actually returned — 2xx, 404, 409 — classified here.
        return Classify(orderId, (int)response.StatusCode);
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

    private static readonly IReadOnlyDictionary<string, TrackingDto> NoTrackings =
        new Dictionary<string, TrackingDto>();

    /// <inheritdoc />
    public async Task<IReadOnlyDictionary<string, TrackingDto>> GetTrackingsAsync(
        IReadOnlyCollection<string> orderIds,
        string cognitoSub,
        CancellationToken ct = default)
    {
        // No ids means nothing to ask for. Short-circuiting here keeps an order list
        // that happens to be empty from costing a round trip.
        if (orderIds.Count == 0)
        {
            return NoTrackings;
        }

        // Linked so the bounded read timeout composes with the caller's cancellation
        // rather than overriding it: whichever fires first wins.
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(ReadTimeout);

        // ONE batch call for N orders, never one per order. Tracking exposes the
        // csv-shaped query precisely so a list read does not fan out. AddQueryParameter
        // encodes the value, so the csv is built plainly rather than escaped by hand.
        var request = new RestRequest(TrackingsPath)
            .AddQueryParameter("order_ids", string.Join(',', orderIds))
            // Same identity mechanism initiation uses. Ownership is enforced on the
            // far side: Tracking filters by cognito_sub and silently omits ids that
            // belong to anyone else, so Orders adds no check of its own.
            .AddHeader("x-user-id", cognitoSub);

        // ExecuteGetAsync deliberately, not GetAsync: the Execute* family REPORTS
        // failure in the response instead of throwing it, which is exactly the shape
        // this method wants — every failure here degrades to "no tracking" rather than
        // propagating. A transport error arrives as IsSuccessful=false with
        // ErrorException set, so one branch covers unreachable, non-2xx and
        // undeserializable alike.
        var response = await _rest.ExecuteGetAsync<TrackingBatchDto>(request, timeout.Token);

        // Same reason as in InitTrackingAsync: RestSharp catches cancellation rather
        // than throwing it, and a caller who gave up must not be logged as a Tracking
        // failure. Only OUR read timeout degrades — hence checking the caller's token,
        // not the linked one.
        ct.ThrowIfCancellationRequested();

        if (!response.IsSuccessful || response.Data?.Trackings is null)
        {
            // Every branch degrades identically; only the logged reason differs, and
            // that is for whoever reads the dashboard. A missing StatusCode means no
            // response arrived — see the note in InitTrackingAsync for why that, and
            // not ResponseStatus or ErrorException, is the property to test.
            var reason = response.StatusCode == default
                ? response.ResponseStatus == ResponseStatus.TimedOut ? "timeout" : "unreachable"
                : !response.IsSuccessStatusCode
                    ? "status"
                    : "unreadable_body";

            _logger.LogWarning(
                response.ErrorException,
                "tracking_read_failed reason={Reason} status={Status} order_count={Count}",
                reason,
                (int)response.StatusCode,
                orderIds.Count);

            return NoTrackings;
        }

        // Keyed by order_id because that is how the caller looks them up — one batch
        // response fans back out to the orders that asked for it. A duplicate order_id
        // would be a Tracking bug; last-wins rather than throwing, since this path must
        // not fail an order read.
        var byOrderId = new Dictionary<string, TrackingDto>(response.Data.Trackings.Count);
        foreach (var tracking in response.Data.Trackings)
        {
            if (!string.IsNullOrEmpty(tracking.OrderId))
            {
                byOrderId[tracking.OrderId] = tracking;
            }
        }

        return byOrderId;
    }
}
