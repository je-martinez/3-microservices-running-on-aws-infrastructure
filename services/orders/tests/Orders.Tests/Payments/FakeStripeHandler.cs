using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Primitives;
using Stripe;

namespace Orders.Tests.Payments;

/// <summary>What the Stripe SDK put on the wire for one call.</summary>
public sealed record CapturedStripeRequest(
    HttpMethod Method,
    string Path,
    Dictionary<string, StringValues> Form,
    string? IdempotencyKey,
    string? StripeVersion);

/// <summary>
/// The transport under a REAL <see cref="StripeClient"/>: records each request and answers with
/// a canned Stripe JSON body per endpoint, emulating Stripe's idempotency.
/// </summary>
/// <remarks>
/// CONTRACT: Idempotency is emulated the way Stripe documents it — a repeated key with the same
/// parameters replays the FIRST response (<c>Idempotent-Replayed: true</c>), different
/// parameters answer 400 <c>idempotency_error</c>, and a repeat arriving while the first is in
/// flight waits for it. See [[2026-09-19-stripe-payments-design]]
/// </remarks>
public sealed class FakeStripeHandler : HttpMessageHandler
{
    public const string PaymentMethodId = "pm_card_visa";
    public const string PaymentIntentId = "pi_test_123";
    public const string RefundId = "re_test_123";
    public const string ClientSecret = PaymentIntentId + "_secret_abc";

    private const string ChargePath = "/v1/payment_intents";
    private const string RefundPath = "/v1/refunds";

    private readonly Func<CapturedStripeRequest, (HttpStatusCode Status, string Body)> _charge;
    private readonly Func<CapturedStripeRequest, (HttpStatusCode Status, string Body)> _refund;
    private readonly Dictionary<string, (string Parameters, TaskCompletionSource<(HttpStatusCode, string)> Response)> _byKey = new();
    private readonly List<string> _refundedIntents = new();

    private FakeStripeHandler(
        Func<CapturedStripeRequest, (HttpStatusCode, string)> charge,
        Func<CapturedStripeRequest, (HttpStatusCode, string)>? refund = null)
    {
        _charge = charge;
        _refund = refund ?? SucceededRefund;
    }

    /// <summary>Every request on the wire, replays included.</summary>
    public List<CapturedStripeRequest> Requests { get; } = new();

    public IEnumerable<CapturedStripeRequest> Charges =>
        Snapshot().Where(r => r.Path == ChargePath && r.Method == HttpMethod.Post);

    public IEnumerable<CapturedStripeRequest> Refunds =>
        Snapshot().Where(r => r.Path == RefundPath && r.Method == HttpMethod.Post);

    /// <summary>Charges Stripe actually executed — replays of a cached response excluded.</summary>
    public int ChargesExecuted { get; private set; }

    /// <summary>Refunds Stripe actually executed — replays of a cached response excluded.</summary>
    public int RefundsExecuted { get; private set; }

    /// <summary>Runs while a CHARGE is in flight, before its response is produced.</summary>
    public Func<CapturedStripeRequest, Task>? OnRequest { get; set; }

    // WHY: Includes client_secret and the expanded card on purpose — the snapshot must keep the
    // card fields and drop the secret, and telemetry must carry neither.
    public static FakeStripeHandler Succeeding(string status = "succeeded") => new(r => (HttpStatusCode.OK,
        JsonSerializer.Serialize(new
        {
            id = PaymentIntentId,
            @object = "payment_intent",
            amount = long.Parse(r.Form["amount"].ToString()),
            currency = "usd",
            status,
            client_secret = ClientSecret,
            customer = r.Form["customer"].ToString(),
            metadata = new { order_id = r.Form["metadata[order_id]"].ToString() },
            payment_method = new
            {
                id = PaymentMethodId,
                @object = "payment_method",
                type = "card",
                card = new { brand = "visa", last4 = "4242", exp_month = 12, exp_year = 2034 },
            },
        })));

    /// <summary>A charge that succeeds and a refund that Stripe rejects with a key-bearing message.</summary>
    public static FakeStripeHandler SucceedingWithFailingRefund()
    {
        var charged = Succeeding();
        return new FakeStripeHandler(charged._charge, _ => (HttpStatusCode.InternalServerError, """
            {"error":{"type":"api_error","message":"Refund failed for key rk_test_****fake"}}
            """));
    }

    public static FakeStripeHandler Failing(HttpStatusCode status, string errorJson) =>
        new(_ => (status, errorJson));

    /// <summary>A card decline as Stripe returns it: 402 with a card_error body.</summary>
    public static FakeStripeHandler Declining(string? declineCode = "insufficient_funds") =>
        Failing(HttpStatusCode.PaymentRequired, JsonSerializer.Serialize(new
        {
            error = new
            {
                type = "card_error",
                code = "card_declined",
                decline_code = declineCode,
                message = "Your card has insufficient funds.",
            },
        }));

    /// <summary>Stripe's answer to a bad key — its message carries a masked key fragment.</summary>
    public static FakeStripeHandler RejectingTheKey() =>
        Failing(HttpStatusCode.Unauthorized, """
            {"error":{"type":"invalid_request_error","message":"Invalid API Key provided: rk_test_****fake"}}
            """);

    /// <summary>A real client whose only transport is <paramref name="handler"/>, with no retries.</summary>
    public static IStripeClient ClientFor(FakeStripeHandler handler) =>
        new StripeClient(new StripeClientOptions
        {
            ApiKey = "rk_test_fake",
            HttpClient = new SystemNetHttpClient(
                new HttpClient(handler), maxNetworkRetries: 0, appInfo: null, enableTelemetry: false),
        });

    private (HttpStatusCode, string) SucceededRefund(CapturedStripeRequest r)
    {
        lock (_refundedIntents)
        {
            _refundedIntents.Add(r.Form["payment_intent"].ToString());
        }

        return (HttpStatusCode.OK, JsonSerializer.Serialize(new
        {
            id = RefundId,
            @object = "refund",
            payment_intent = r.Form["payment_intent"].ToString(),
            status = "succeeded",
        }));
    }

    private (HttpStatusCode, string) ListRefunds(string paymentIntentId)
    {
        string[] refunded;
        lock (_refundedIntents)
        {
            refunded = _refundedIntents.Where(pi => pi == paymentIntentId).ToArray();
        }

        return (HttpStatusCode.OK, JsonSerializer.Serialize(new
        {
            @object = "list",
            url = RefundPath,
            has_more = false,
            data = refunded.Select(pi => new { id = RefundId, @object = "refund", payment_intent = pi, status = "succeeded" }),
        }));
    }

    private CapturedStripeRequest[] Snapshot()
    {
        lock (Requests)
        {
            return Requests.ToArray();
        }
    }

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var content = request.Content is null ? string.Empty : await request.Content.ReadAsStringAsync(cancellationToken);
        var captured = new CapturedStripeRequest(
            request.Method,
            request.RequestUri!.AbsolutePath,
            QueryHelpers.ParseQuery(content),
            request.Headers.TryGetValues("Idempotency-Key", out var keys) ? keys.Single() : null,
            request.Headers.TryGetValues("Stripe-Version", out var versions) ? versions.Single() : null);
        lock (Requests)
        {
            Requests.Add(captured);
        }

        if (request.Method == HttpMethod.Get && captured.Path == RefundPath)
        {
            var query = QueryHelpers.ParseQuery(request.RequestUri.Query);
            return Respond(ListRefunds(query["payment_intent"].ToString()), replayed: false);
        }

        var isRefund = captured.Path == RefundPath;

        // WHY: The key is claimed BEFORE OnRequest runs, so a duplicate arriving while the first
        // is held inside OnRequest is already known to be a repeat.
        TaskCompletionSource<(HttpStatusCode, string)>? owned = null;
        (string Parameters, TaskCompletionSource<(HttpStatusCode, string)> Response) prior = default;
        var repeat = false;
        if (captured.IdempotencyKey is { } key)
        {
            lock (_byKey)
            {
                if (_byKey.TryGetValue(key, out prior))
                {
                    repeat = true;
                }
                else
                {
                    owned = new TaskCompletionSource<(HttpStatusCode, string)>(TaskCreationOptions.RunContinuationsAsynchronously);
                    _byKey[key] = (content, owned);
                }
            }
        }

        if (!isRefund && OnRequest is not null)
        {
            await OnRequest(captured);
        }

        if (repeat)
        {
            if (prior.Parameters != content)
            {
                return Respond((HttpStatusCode.BadRequest, """
                    {"error":{"type":"idempotency_error","message":"Keys for idempotent requests can only be used with the same parameters they were first used with."}}
                    """), replayed: false);
            }

            return Respond(await prior.Response.Task, replayed: true);
        }

        var response = isRefund ? _refund(captured) : _charge(captured);
        if (isRefund)
        {
            RefundsExecuted++;
        }
        else
        {
            ChargesExecuted++;
        }

        owned?.SetResult(response);
        return Respond(response, replayed: false);
    }

    private static HttpResponseMessage Respond((HttpStatusCode Status, string Body) response, bool replayed)
    {
        var message = new HttpResponseMessage(response.Status)
        {
            Content = new StringContent(response.Body, Encoding.UTF8, "application/json"),
        };
        if (replayed)
        {
            message.Headers.Add("Idempotent-Replayed", "true");
        }

        return message;
    }
}
