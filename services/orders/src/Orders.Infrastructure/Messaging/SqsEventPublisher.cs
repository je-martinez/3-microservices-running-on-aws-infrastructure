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
/// <para>
/// The one exception is inside <c>author</c>, where <c>user_id</c>/<c>cognito_sub</c> are
/// genuinely OPTIONAL and are omitted when there is no human author. Orders always has
/// one — the buyer — so both are populated here; the omission path exists because the
/// same block is produced by Tracking's carrier webhook, where no person acted at all.
/// <c>author</c> carries no <c>source</c> of its own — the root one names the producer.
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
    //
    // WhenWritingNull, not Never: the author block OMITS an identity it does not have
    // rather than sending `null` for it (see EventAuthor). Never would serialize those
    // as `"cognito_sub": null`, which is precisely the shape the contract forbids.
    //
    // The envelope's own `order_id` is unaffected — it is nullable but REQUIRED, and this
    // publisher always populates it with a real order id, so there is no null to drop.
    // (USER_CREATED is the event that sends null there, and that is Users' publisher.)
    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
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
            // Minted HERE, not by the caller: this is the idempotency key behind the
            // pipeline's unique index on event_id, so an SQS redelivery of the same
            // message collides and is recognised as already-processed.
            EventId: NanoId.NewId(EventIdPrefix),
            Type: EventType,
            Source: EventSource,
            UserId: userId,
            OrderId: orderId,
            // WHO originated the event, next to the UserId above, which is WHO it is
            // about. A real human acted here — the buyer placed their own order — so the
            // author carries both identities. `Actor` is the same semantic AuditActor
            // value the audit interceptor stamps into CreatedBy/UpdatedBy for this write
            // path, so the event and the row it produced name their origin identically.
            //
            // There is no author.source: the producing service is already this envelope's
            // root Source, and a second copy would carry no information while inviting
            // the two to disagree (see AuthorSchema in the consumer's envelope.ts).
            //
            // An absent CognitoSub is OMITTED from the JSON, never serialized as null —
            // see SerializerOptions above.
            Author: new EventAuthor(
                Actor: AuditActor.CreateOrder,
                UserId: userId,
                CognitoSub: string.IsNullOrWhiteSpace(cognitoSub) ? null : cognitoSub),
            Payload: new OrderCreatedPayload(
                OrderId: orderId,
                UserId: userId,
                Email: email,
                FullName: fullName,
                // The receipt's four figures travel as four figures. The consumer must never
                // derive one from the others: the split was computed once, by the code that
                // priced the order, and a template that re-does that arithmetic can disagree
                // with the order row it is describing.
                SubtotalCents: subtotalCents,
                TaxCents: taxCents,
                ShippingCents: shippingCents,
                TotalCents: totalCents,
                // Re-parsed from the stored JSON into a JsonElement so it is embedded as a
                // real JSON OBJECT, not as a string-of-JSON the consumer would receive
                // double-escaped — the same treatment TrackingHttpClient gives this exact
                // column. Absent (or unparsable) collapses to null, and null is OMITTED from
                // the wire entirely by SerializerOptions above, exactly like author.cognito_sub:
                // "no address on file" must not reach the consumer as `"shipping_address": null`.
                ShippingAddress: ParseShippingAddress(shippingAddress, orderId),
                Items: items
                    .Select(i => new OrderCreatedItemPayload(i.Name, i.Quantity, i.UnitPriceCents))
                    .ToList(),
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

    // The address arrives as the JSON snapshot persisted on the order, so it is re-parsed
    // into a JsonElement and embedded as a real JSON value rather than re-encoded as a
    // string-of-JSON (which would reach the consumer double-escaped and render as a blob of
    // quotes and backslashes on the customer's receipt). Mirrors TrackingHttpClient.ParseAddress,
    // which does the same thing to the same column for the same reason.
    //
    // Absent or malformed becomes null, and null is dropped from the JSON by
    // SerializerOptions: an address we cannot parse must never cost the buyer the whole
    // email, and must never be echoed into a log line (PII) — only the order id is logged.
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

    // snake_case wire names are declared explicitly on each member — see the class
    // remarks: these names ARE the contract the consumer's Zod schemas validate.
    private sealed record EventEnvelope(
        [property: JsonPropertyName("event_id")] string EventId,
        [property: JsonPropertyName("type")] string Type,
        [property: JsonPropertyName("source")] string Source,
        [property: JsonPropertyName("user_id")] string UserId,
        [property: JsonPropertyName("order_id")] string? OrderId,
        [property: JsonPropertyName("author")] EventAuthor Author,
        [property: JsonPropertyName("payload")] OrderCreatedPayload Payload);

    // Who originated the event. Only `actor` is always present; `user_id` and
    // `cognito_sub` are OMITTED when unknown rather than sent as null — which is what
    // makes them nullable here and why the serializer uses WhenWritingNull. A producer
    // with no human behind it (Tracking's carrier webhook) sends `actor` alone. There is
    // no `source`: the envelope's root one already names the producing service.
    private sealed record EventAuthor(
        [property: JsonPropertyName("actor")] string Actor,
        [property: JsonPropertyName("user_id")] string? UserId,
        [property: JsonPropertyName("cognito_sub")] string? CognitoSub);

    // Exactly what OrderCreatedPayloadSchema requires, no more: the payload is persisted on
    // the event document, so anything extra would be stored for no reason.
    //
    // It grew from a bare confirmation into a RECEIPT — greeting, money breakdown, address
    // and line items — because the consumer holds no connection to the Orders database and
    // cannot look any of it up. Whatever the email prints has to travel here.
    //
    // `shipping_address` is the one OPTIONAL key: a buyer with no address on file yields
    // null, which WhenWritingNull omits from the JSON entirely. Every other key is always
    // present, so the payload's shape never varies.
    private sealed record OrderCreatedPayload(
        [property: JsonPropertyName("order_id")] string OrderId,
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

    // One receipt line. Carries the product's NAME, not its id: OrderDetail stores only
    // ProductId, and an id printed on a customer's receipt is not a receipt. The line's own
    // total is deliberately absent — the template multiplies quantity by unit price, and a
    // second figure on the wire could contradict the two it was derived from.
    //
    // A distinct type from Application's OrderCreatedItem on purpose: that one is the port's
    // vocabulary, this one is the WIRE, and the wire's names are owned by the consumer's Zod
    // schema. Collapsing them would let an innocuous rename in Application silently change
    // what the pipeline validates.
    private sealed record OrderCreatedItemPayload(
        [property: JsonPropertyName("name")] string Name,
        [property: JsonPropertyName("quantity")] uint Quantity,
        [property: JsonPropertyName("unit_price_cents")] long UnitPriceCents);
}
