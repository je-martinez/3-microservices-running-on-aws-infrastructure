using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;
using Amazon.SQS;
using Amazon.SQS.Model;
using Microsoft.Extensions.Logging;
using Orders.Application.Abstractions;
using Orders.Infrastructure.Id;

namespace Orders.Infrastructure.Messaging;

/// <summary>
/// Publishes <c>ORDER_CREATED</c> onto the shared events queue, where the
/// events-pipeline Lambda consumes it and sends the confirmation email.
/// </summary>
/// <remarks>
/// CONTRACT: The wire names are owned by the consumer's Zod schemas
/// (<c>functions/events-pipeline/src/domain/envelope.ts</c> and
/// <c>handlers/order-created.ts</c>). Do NOT rename a field without changing them: a
/// rejected envelope is classified PermanentError, so the message is consumed, the event
/// is recorded FAILED, and no email is ever sent — silently, for every event.
/// See [[events-pipeline-design]]
/// </remarks>
public class SqsEventPublisher : IEventPublisher
{
    private const string EventIdPrefix = NanoIdConfig.EventPrefix;
    private const string EventType = "ORDER_CREATED";
    private const string EventSource = "orders";

    // CONTRACT: WhenWritingNull, not Never. Optional identities are OMITTED, never sent as
    // `"cognito_sub": null` — the shape the consumer's schema forbids. No camelCase policy
    // either: each DTO below declares its own snake_case wire name.
    // See [[events-pipeline-design]]
    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>
    /// The ActivitySource for the publish span, identifying the queue hop.
    /// CONTRACT: Keep it registered in <c>Program.cs</c> via <c>AddSource</c>. .NET drops
    /// every source the pipeline was not told about — no span, no error.
    /// See [[ADR-0019-distributed-tracing-opentelemetry]]
    /// </summary>
    public const string ActivitySourceName = "orders-messaging";

    /// <summary>The publish span's name, asserted by the tests that pin the trace hop.</summary>
    public const string PublishActivityName = "sqs.publish order_created";

    private static readonly ActivitySource Source = new(ActivitySourceName);

    private readonly IAmazonSQS _client;
    private readonly string _queueUrl;
    private readonly ILogger<SqsEventPublisher> _logger;

    public SqsEventPublisher(IAmazonSQS client, string queueUrl, ILogger<SqsEventPublisher> logger)
    {
        _client = client;
        _queueUrl = queueUrl;
        _logger = logger;
    }

    public async Task PublishOrderCreatedAsync(
        string orderId,
        string? orderNumber,
        string userId,
        string email,
        string fullName,
        long subtotalCents,
        long taxCents,
        long shippingCents,
        long totalCents,
        string? shippingAddress,
        IReadOnlyList<OrderCreatedItem> items,
        DateTime createdAt,
        string? cognitoSub = null,
        CancellationToken ct = default)
    {
        var envelope = new EventEnvelope(
            // CONTRACT: Mint the event id here, never in the caller. It is the idempotency
            // key behind the pipeline's unique index on event_id; a caller-supplied id lets
            // an SQS redelivery be processed twice.
            EventId: NanoId.NewId(EventIdPrefix),
            Type: EventType,
            Source: EventSource,
            UserId: userId,
            OrderId: orderId,
            // WHY: The only link across the queue — the pipeline Lambda runs no OTel SDK,
            // so trace_id never reaches it. Null outside a request, and omitted when null.
            RequestId: AmbientRequestId.Current,
            // WHY: `author` is WHO acted; the root UserId is WHO the event is about. Actor
            // reuses the AuditActor the interceptor stamps on the row, so event and row name
            // the same origin. No author.source — the root Source already names the producer.
            Author: new EventAuthor(
                Actor: AuditActor.CreateOrder,
                UserId: userId,
                CognitoSub: string.IsNullOrWhiteSpace(cognitoSub) ? null : cognitoSub),
            Payload: new OrderCreatedPayload(
                OrderId: orderId,
                // CONTRACT: Send BOTH forms and let the template render `formatted`
                // verbatim. The separator rule lives on the server — six templates each
                // inserting their own hyphen is six copies that drift, and a customer then
                // reads out a number support cannot find. Omitted (not null) for an order
                // predating the backfill. See [[friendly-order-number]]
                OrderNumber: string.IsNullOrWhiteSpace(orderNumber)
                    ? null
                    : new OrderNumberPayload(orderNumber, Domain.OrderNumber.Format(orderNumber)),
                UserId: userId,
                Email: email,
                FullName: fullName,
                // CONTRACT: Send all four figures; the consumer must NOT derive one from the
                // others. A template re-doing the arithmetic disagrees with the order row.
                // See [[money-representation]]
                SubtotalCents: subtotalCents,
                TaxCents: taxCents,
                ShippingCents: shippingCents,
                TotalCents: totalCents,
                // CONTRACT: Embed the address as a real JSON object, not a string-of-JSON —
                // the consumer receives the latter double-escaped and renders quotes and
                // backslashes on the receipt. Unparsable collapses to null and is omitted.
                // See [[events-pipeline-design]]
                ShippingAddress: ParseShippingAddress(shippingAddress, orderId),
                Items: items
                    .Select(i => new OrderCreatedItemPayload(i.Name, i.Quantity, i.UnitPriceCents))
                    .ToList(),
                // WHY: Round-trip ("O") UTC — a machine-locale rendering is ambiguous.
                CreatedAt: createdAt.ToUniversalTime().ToString("O")));

        var request = new SendMessageRequest
        {
            QueueUrl = _queueUrl,
            MessageBody = JsonSerializer.Serialize(envelope, SerializerOptions),
        };

        // CONTRACT: Start the activity OUTSIDE the try, with the try/catch nested in its
        // scope. Inside the try, an exception disposes it on the way out and the failure log
        // lands on the enclosing workflow span, invisible to a span-scoped lookup on the
        // publish. See [[logging-context]]
        using var activity = Source.StartActivity(PublishActivityName, ActivityKind.Producer);

        try
        {
            // CONTRACT: Build the attributes here, inside the activity's scope. Evaluated in
            // the request initializer above, Activity.Current is the enclosing create_order
            // span and the consumer parents its work to that instead of to this send.
            request.MessageAttributes = BuildMessageAttributes();

            await _client.SendMessageAsync(request, ct);

            // CONTRACT: Never log the email, name or address (PII) — the ids identify the
            // message. Keep the line inside the activity: OpenObserve's "View logs" filters
            // by trace_id AND span_id, so a span nobody logs from returns nothing.
            // See [[logging-context]]
            _logger.LogInformation(
                "ORDER_CREATED published {app_event} {event_type} {event_id} {order_id} {user_id}",
                "order_created_published", EventType, envelope.EventId, orderId, userId);
        }
        catch (Exception ex)
        {
            // WHY: A failed send must not render as a healthy hop in the waterfall.
            activity?.SetStatus(ActivityStatusCode.Error, ex.Message);


            // CONTRACT: Do NOT rethrow. The order is already persisted and its stock already
            // decremented, so rethrowing aborts the enclosing transaction and a queue outage
            // rolls back a sale the customer completed. Log at error with the `*_failed`
            // app_event so it stays alertable and backfillable — never the email or address
            // (PII). See [[logging-context]]
            _logger.LogError(
                ex,
                "ORDER_CREATED publish failed (non-fatal): the order was created but no event was emitted {app_event} {reason} {order_id} {user_id}",
                "order_created_publish_failed", "sqs_send_failed", orderId, userId);
        }
    }

    // CONTRACT: Call this INSIDE the publish activity's scope — it reads Activity.Current.
    // Called while building the SendMessageRequest, it captures the enclosing create_order
    // span and the consumer parents process_record as a sibling of the send, so expanding
    // the publish shows only SDK internals. Omit traceparent when there is no activity:
    // SQS rejects an empty StringValue, turning a missing trace into a failed publish.
    // It rides in the attributes, never in the body, which the consumer's schema validates.
    // See [[ADR-0019-distributed-tracing-opentelemetry]]
    private static Dictionary<string, MessageAttributeValue> BuildMessageAttributes()
    {
        var attributes = new Dictionary<string, MessageAttributeValue>
        {
            ["type"] = new MessageAttributeValue { DataType = "String", StringValue = EventType },
            ["source"] = new MessageAttributeValue { DataType = "String", StringValue = EventSource },
        };

        if (Activity.Current?.Id is { Length: > 0 } traceparent)
        {
            attributes["traceparent"] = new MessageAttributeValue
            {
                DataType = "String",
                StringValue = traceparent,
            };
        }

        return attributes;
    }

    // CONTRACT: Never echo the address into a log line (PII) — only the order id. A
    // malformed snapshot degrades to null (and is then omitted) rather than costing the
    // buyer the whole email. Mirrors TrackingHttpClient.ParseAddress on the same column.
    // See [[logging-context]]
    private JsonElement? ParseShippingAddress(string? shippingAddress, string orderId)
    {
        if (string.IsNullOrWhiteSpace(shippingAddress))
            return null;

        try
        {
            using var document = JsonDocument.Parse(shippingAddress);
            return document.RootElement.Clone();
        }
        catch (JsonException)
        {
            _logger.LogWarning(
                "Shipping address snapshot is not valid JSON; omitting it from ORDER_CREATED {app_event} {order_id}",
                "order_created_address_unparsable", orderId);
            return null;
        }
    }

    // CONTRACT: Every root key is required except `request_id`, which is omitted when
    // absent. Making it required fails validation for messages already on the queue from
    // before the field existed — PermanentError, dead-lettered, email silently never sent.
    // `order_id` is nullable but required, and this publisher always fills it.
    // See [[events-pipeline-design]]
    private sealed record EventEnvelope(
        [property: JsonPropertyName("event_id")] string EventId,
        [property: JsonPropertyName("type")] string Type,
        [property: JsonPropertyName("source")] string Source,
        [property: JsonPropertyName("user_id")] string UserId,
        [property: JsonPropertyName("order_id")] string? OrderId,
        [property: JsonPropertyName("request_id")] string? RequestId,
        [property: JsonPropertyName("author")] EventAuthor Author,
        [property: JsonPropertyName("payload")] OrderCreatedPayload Payload);

    // CONTRACT: Only `actor` is always present. Omit `user_id`/`cognito_sub` when unknown
    // rather than sending null — a producer with no human behind it (Tracking's carrier
    // webhook) sends `actor` alone. See [[events-pipeline-design]]
    private sealed record EventAuthor(
        [property: JsonPropertyName("actor")] string Actor,
        [property: JsonPropertyName("user_id")] string? UserId,
        [property: JsonPropertyName("cognito_sub")] string? CognitoSub);

    // WHY: The receipt travels whole because the consumer has no connection to the Orders
    // database and cannot look anything up. `shipping_address` is the only optional key —
    // omitted, never null; every other key is always present.
    private sealed record OrderCreatedPayload(
        [property: JsonPropertyName("order_id")] string OrderId,
        [property: JsonPropertyName("order_number")] OrderNumberPayload? OrderNumber,
        [property: JsonPropertyName("user_id")] string UserId,
        [property: JsonPropertyName("email")] string Email,
        [property: JsonPropertyName("full_name")] string FullName,
        [property: JsonPropertyName("subtotal_cents")] long SubtotalCents,
        [property: JsonPropertyName("tax_cents")] long TaxCents,
        [property: JsonPropertyName("shipping_cents")] long ShippingCents,
        [property: JsonPropertyName("total_cents")] long TotalCents,
        [property: JsonPropertyName("shipping_address")] JsonElement? ShippingAddress,
        [property: JsonPropertyName("items")] IReadOnlyList<OrderCreatedItemPayload> Items,
        [property: JsonPropertyName("created_at")] string CreatedAt);

    // CONTRACT: Keep this distinct from Application's OrderCreatedItem — that one is the
    // port's vocabulary, this one is the wire the consumer's schema validates, and merging
    // them lets a rename in Application silently change what the pipeline accepts. Carries
    // the product NAME (an id on a receipt is not a receipt) and no line total, which the
    // template derives. See [[events-pipeline-design]]
    // CONTRACT: Both forms travel. `raw` is the canonical value a consumer would send back;
    // `formatted` is what a template prints, verbatim. The consumer's schema must keep the
    // whole object OPTIONAL — messages published before this field existed can still be on
    // the queue at deploy time, and a schema failure is a PermanentError whose email is
    // never sent. See [[events-pipeline-design]]
    private sealed record OrderNumberPayload(
        [property: JsonPropertyName("raw")] string Raw,
        [property: JsonPropertyName("formatted")] string Formatted);

    private sealed record OrderCreatedItemPayload(
        [property: JsonPropertyName("name")] string Name,
        [property: JsonPropertyName("quantity")] uint Quantity,
        [property: JsonPropertyName("unit_price_cents")] long UnitPriceCents);
}
