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
/// <para>
/// The wire contract is owned by the CONSUMER, not by this class:
/// <c>functions/events-pipeline/src/domain/envelope.ts</c> (envelope) and
/// <c>functions/events-pipeline/src/handlers/order-created.ts</c> (payload). Both are
/// Zod-validated on arrival, both are entirely snake_case, and a mismatch is not a soft
/// failure — an envelope or payload the schemas reject is classified PermanentError, so
/// the message is CONSUMED, the event document is recorded FAILED, and no email is ever
/// sent. Silently, for every single event. Change a field name here only together with
/// those schemas.
/// </para>
/// <para>
/// Every envelope key must be PRESENT: <c>order_id</c> is nullable in the schema but not
/// optional. It carries the real order id here (unlike USER_CREATED, which sends null).
/// </para>
/// </remarks>
public class SqsEventPublisher : IEventPublisher
{
    private const string EventIdPrefix = "evt_";
    private const string EventType = "ORDER_CREATED";
    private const string EventSource = "orders";

    // No camelCase policy and no property renaming: the DTOs below already declare the
    // exact snake_case names the consumer validates, so the wire shape is readable in
    // the source rather than being the product of a serializer convention.
    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };

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
        string userId,
        string email,
        long totalCents,
        DateTime createdAt,
        CancellationToken ct = default)
    {
        var envelope = new EventEnvelope(
            // Minted HERE, not by the caller: this is the idempotency key behind the
            // pipeline's unique index on event_id, so an SQS redelivery of the same
            // message collides and is recognised as already-processed.
            EventId: NanoId.NewId(EventIdPrefix),
            Type: EventType,
            Source: EventSource,
            UserId: userId,
            OrderId: orderId,
            Payload: new OrderCreatedPayload(
                OrderId: orderId,
                UserId: userId,
                Email: email,
                TotalCents: totalCents,
                // Round-trip ("O") UTC, so the consumer receives an unambiguous instant
                // rather than a machine-locale rendering.
                CreatedAt: createdAt.ToUniversalTime().ToString("O")));

        var request = new SendMessageRequest
        {
            QueueUrl = _queueUrl,
            MessageBody = JsonSerializer.Serialize(envelope, SerializerOptions),
            // Duplicated as message attributes so the queue can be inspected (and
            // filtered) without deserializing bodies.
            MessageAttributes = new Dictionary<string, MessageAttributeValue>
            {
                ["type"] = new MessageAttributeValue { DataType = "String", StringValue = EventType },
                ["source"] = new MessageAttributeValue { DataType = "String", StringValue = EventSource },
            },
        };

        try
        {
            await _client.SendMessageAsync(request, ct);
        }
        catch (Exception ex)
        {
            // DELIBERATE: logged and swallowed, never rethrown.
            //
            // By the time this runs the order is already persisted and its products'
            // stock already decremented. Rethrowing would abort the enclosing
            // transaction, so a queue outage would roll back a commercially valid order
            // that the customer successfully placed and that Tracking may already have
            // been told about — trading a missing confirmation EMAIL for a lost SALE.
            // The email is a notification about the order, not the order itself, so it
            // degrades independently; this is the same best-effort stance order creation
            // already takes for its Tracking call.
            //
            // NOT silent: logged at error with the `*_failed` app_event so it is
            // alertable and the event is backfillable from the order row.
            //
            // NEVER log the email or any address field (PII). order_id and user_id
            // identify the missing event completely on their own.
            _logger.LogError(
                ex,
                "ORDER_CREATED publish failed (non-fatal): the order was created but no event was emitted {app_event} {reason} {order_id} {user_id}",
                "order_created_publish_failed", "sqs_send_failed", orderId, userId);
        }
    }

    // snake_case wire names are declared explicitly on each member — see the class
    // remarks: these names ARE the contract the consumer's Zod schemas validate.
    private sealed record EventEnvelope(
        [property: JsonPropertyName("event_id")] string EventId,
        [property: JsonPropertyName("type")] string Type,
        [property: JsonPropertyName("source")] string Source,
        [property: JsonPropertyName("user_id")] string UserId,
        [property: JsonPropertyName("order_id")] string? OrderId,
        [property: JsonPropertyName("payload")] OrderCreatedPayload Payload);

    // Exactly the five fields OrderCreatedPayloadSchema requires, no more: the payload is
    // persisted on the event document, so anything extra would be stored for no reason.
    private sealed record OrderCreatedPayload(
        [property: JsonPropertyName("order_id")] string OrderId,
        [property: JsonPropertyName("user_id")] string UserId,
        [property: JsonPropertyName("email")] string Email,
        [property: JsonPropertyName("total_cents")] long TotalCents,
        [property: JsonPropertyName("created_at")] string CreatedAt);
}
