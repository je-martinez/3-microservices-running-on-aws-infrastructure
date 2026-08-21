using System.Diagnostics;
using System.Text.Json;
using Amazon.SQS;
using Amazon.SQS.Model;
using Microsoft.Extensions.Logging;
using Moq;
using Orders.Application.Abstractions;
using Orders.Infrastructure.Id;
using Orders.Infrastructure.Messaging;
using Orders.Tests.Observability;

namespace Orders.Tests.Messaging;

/// <summary>
/// Verifies the ORDER_CREATED message this publisher actually puts on the wire.
/// </summary>
/// <remarks>
/// <para>
/// Every assertion reads the <see cref="SendMessageRequest"/> the publisher BUILT, captured
/// by a recording fake. None asserts a stub's configured behaviour back at itself: a test
/// that checks "the throwing fake threw" or "the value I configured came back" passes
/// against any implementation, including one that publishes nothing or leaks PII.
/// </para>
/// <para>
/// The contract under test belongs to the CONSUMER —
/// <c>functions/events-pipeline/src/domain/envelope.ts</c> and
/// <c>src/handlers/order-created.ts</c> — and a mismatch fails silently in production
/// (PermanentError → recorded FAILED → no email), which is exactly why it is pinned here.
/// </para>
/// </remarks>
public class SqsEventPublisherTests
{
    private const string QueueUrl = "http://localhost:4566/000000000000/3mrai-local-events";
    private const string OrderId = "ord_abc123";
    private const string UserId = "usr_xyz789";
    private const string Email = "buyer@example.com";
    private const string FullName = "Ada Lovelace";

    // A breakdown whose four figures are mutually DISTINCT and genuinely add up
    // (2999 + 240 + 1500 = 4739). Distinct values are what make a publisher that wired
    // subtotal into tax_cents — or derived one figure from another — fail here instead of
    // coinciding; and a sum that balances is the arithmetic the receipt itself prints.
    private const long SubtotalCents = 2999;
    private const long TaxCents = 240;
    private const long ShippingCents = 1500;
    private const long TotalCents = 4739;

    // The address as it is persisted on the order: already JSON, which is why the payload
    // must embed it as an object rather than as a string-of-JSON.
    private const string ShippingAddressJson =
        """{"line1":"1 Ada Way","city":"San Juan","country":"PR","postal_code":"00901"}""";

    // Two lines with different names, quantities and prices, so a publisher that emitted
    // the same item twice, dropped one, or crossed quantity with price cannot pass.
    private static readonly IReadOnlyList<OrderCreatedItem> Items = new[]
    {
        new OrderCreatedItem("Mechanical Keyboard", 2, 1200),
        new OrderCreatedItem("USB-C Cable", 1, 599),
    };

    // Deliberately unlike UserId: an implementation that put the internal id in
    // author.cognito_sub (or vice versa) must fail rather than coincide.
    private const string CognitoSub = "a1b2-c3d4";

    private static readonly DateTime CreatedAt =
        new(2026, 8, 3, 14, 30, 15, DateTimeKind.Utc);

    // One place to build a full-fat publish call, so a future parameter is added once here
    // instead of in every test — and so each test names ONLY the argument it is about.
    private static Task Publish(
        SqsEventPublisher publisher,
        string? cognitoSub = CognitoSub,
        string? shippingAddress = ShippingAddressJson,
        IReadOnlyList<OrderCreatedItem>? items = null)
        => publisher.PublishOrderCreatedAsync(
            OrderId, UserId, Email, FullName,
            SubtotalCents, TaxCents, ShippingCents, TotalCents,
            shippingAddress, items ?? Items, CreatedAt, cognitoSub);

    private static (SqsEventPublisher Publisher, RecordingSqs Sqs, CapturingLogger Logger) Build(
        Exception? sendFailure = null)
    {
        var sqs = new RecordingSqs(sendFailure);
        var logger = new CapturingLogger();
        return (new SqsEventPublisher(sqs.Object, QueueUrl, logger), sqs, logger);
    }

    private static async Task<JsonElement> PublishAndReadBody(
        RecordingSqs sqs,
        SqsEventPublisher publisher,
        string? shippingAddress = ShippingAddressJson)
    {
        await Publish(publisher, shippingAddress: shippingAddress);
        return JsonDocument.Parse(sqs.Requests.Single().MessageBody).RootElement;
    }

    [Fact]
    public async Task Sends_one_message_to_the_configured_queue_url()
    {
        var (publisher, sqs, _) = Build();

        await Publish(publisher);

        var request = Assert.Single(sqs.Requests);
        // The queue URL is injected, never hardcoded — this pins that the injected value
        // is the one actually used.
        Assert.Equal(QueueUrl, request.QueueUrl);
    }

    [Fact]
    public async Task Envelope_carries_every_required_key_in_snake_case()
    {
        var (publisher, sqs, _) = Build();

        var body = await PublishAndReadBody(sqs, publisher);

        // EnvelopeSchema requires all seven. `order_id` is nullable but NOT optional: an
        // absent key fails validation just as a wrong name would.
        //
        // `request_id` is absent from this list on purpose: no ambient correlation id is
        // in scope here, and the field is OMITTED rather than nulled when so. Its two
        // cases are pinned separately below.
        Assert.Equal(
            new[] { "author", "event_id", "order_id", "payload", "source", "type", "user_id" },
            body.EnumerateObject().Select(p => p.Name).OrderBy(n => n, StringComparer.Ordinal).ToArray());

        Assert.Equal("ORDER_CREATED", body.GetProperty("type").GetString());
        Assert.Equal("orders", body.GetProperty("source").GetString());
        Assert.Equal(UserId, body.GetProperty("user_id").GetString());
        // Unlike USER_CREATED (which sends null), ORDER_CREATED carries the real order id.
        Assert.Equal(OrderId, body.GetProperty("order_id").GetString());
        Assert.False(string.IsNullOrWhiteSpace(body.GetProperty("event_id").GetString()));
    }

    // The correlation id crosses the queue as a ROOT envelope field, which is the hop the
    // whole design exists for: the pipeline Lambda runs no OTel SDK, so trace_id never
    // reaches it and nothing else joins the confirmation email to the HTTP request that
    // caused it. Seeded here the way CallerContextMiddleware seeds it at ingress.
    [Fact]
    public async Task Envelope_carries_the_request_id_as_a_root_field()
    {
        const string RequestIdValue = "req_V1StGXR8Z5jdHi6BMyTqWxYz";
        AmbientRequestId.Set(RequestIdValue);
        var (publisher, sqs, _) = Build();

        var body = await PublishAndReadBody(sqs, publisher);

        // At the ROOT, not inside payload or author: the consumer reads it off the
        // envelope, alongside event_id and type.
        Assert.Equal(RequestIdValue, body.GetProperty("request_id").GetString());
    }

    [Fact]
    public async Task Envelope_omits_request_id_entirely_when_there_is_none()
    {
        var (publisher, sqs, _) = Build();

        var body = await PublishAndReadBody(sqs, publisher);

        // OMITTED, never `"request_id": null` — the same WhenWritingNull rule
        // author.cognito_sub follows. A null would read as "correlation resolved to
        // nothing" rather than "this message carries none", and the consumer's schema
        // declares the field optional precisely so pre-existing queued messages without
        // it still validate instead of being dead-lettered.
        Assert.False(body.TryGetProperty("request_id", out _));
    }

    [Fact]
    public async Task Payload_matches_the_consumers_OrderCreatedPayloadSchema()
    {
        var (publisher, sqs, _) = Build();

        var body = await PublishAndReadBody(sqs, publisher);
        var payload = body.GetProperty("payload");

        // Every field OrderCreatedPayloadSchema requires — exactly, and snake_case. The
        // payload grew from a bare confirmation into a RECEIPT: the consumer holds no
        // connection to the Orders database, so the greeting, the money breakdown and the
        // line items all have to travel here or the email cannot print them.
        // `email` is the one the original plan omitted: without it every ORDER_CREATED
        // would be rejected as a PermanentError and no confirmation email ever sent.
        Assert.Equal(
            new[]
            {
                "created_at", "email", "full_name", "items", "order_id", "shipping_address",
                "shipping_cents", "subtotal_cents", "tax_cents", "total_cents", "user_id",
            },
            payload.EnumerateObject().Select(p => p.Name).OrderBy(n => n, StringComparer.Ordinal).ToArray());

        Assert.Equal(OrderId, payload.GetProperty("order_id").GetString());
        Assert.Equal(UserId, payload.GetProperty("user_id").GetString());
        Assert.Equal(Email, payload.GetProperty("email").GetString());
        // A JSON number, not a string — the schema is z.number().int().nonnegative().
        Assert.Equal(JsonValueKind.Number, payload.GetProperty("total_cents").ValueKind);
        Assert.Equal(TotalCents, payload.GetProperty("total_cents").GetInt64());

        // Parseable back to the same instant: the consumer stores it as a date string.
        var createdAt = payload.GetProperty("created_at").GetString();
        Assert.Equal(CreatedAt, DateTime.Parse(createdAt!).ToUniversalTime());
    }

    [Fact]
    public async Task Carries_the_buyers_name_for_the_greeting_and_the_billed_to_line()
    {
        var (publisher, sqs, _) = Build();

        var payload = (await PublishAndReadBody(sqs, publisher)).GetProperty("payload");

        // The consumer cannot look this up — it has no access to Users — so a dropped
        // full_name is an email addressed to nobody, not a recoverable omission.
        Assert.Equal(FullName, payload.GetProperty("full_name").GetString());
    }

    [Fact]
    public async Task Carries_the_four_figure_money_breakdown_the_receipt_prints()
    {
        var (publisher, sqs, _) = Build();

        var payload = (await PublishAndReadBody(sqs, publisher)).GetProperty("payload");

        // All four travel as their own figure. The constants are mutually distinct, so a
        // publisher that wired subtotal into tax_cents (or derived one from another) fails
        // here rather than coinciding.
        Assert.Equal(SubtotalCents, payload.GetProperty("subtotal_cents").GetInt64());
        Assert.Equal(TaxCents, payload.GetProperty("tax_cents").GetInt64());
        Assert.Equal(ShippingCents, payload.GetProperty("shipping_cents").GetInt64());
        Assert.Equal(TotalCents, payload.GetProperty("total_cents").GetInt64());

        // Numbers, not strings — the money convention is integer cents and the schema is
        // z.number().int().
        Assert.Equal(JsonValueKind.Number, payload.GetProperty("subtotal_cents").ValueKind);
        Assert.Equal(JsonValueKind.Number, payload.GetProperty("tax_cents").ValueKind);
        Assert.Equal(JsonValueKind.Number, payload.GetProperty("shipping_cents").ValueKind);

        // The arithmetic the reader of the receipt checks. Pinned so a future change that
        // makes the rows stop adding up to the total is caught here, not by a customer.
        Assert.Equal(
            payload.GetProperty("total_cents").GetInt64(),
            payload.GetProperty("subtotal_cents").GetInt64()
                + payload.GetProperty("tax_cents").GetInt64()
                + payload.GetProperty("shipping_cents").GetInt64());
    }

    [Fact]
    public async Task Items_carry_each_lines_name_quantity_and_unit_price()
    {
        var (publisher, sqs, _) = Build();

        var payload = (await PublishAndReadBody(sqs, publisher)).GetProperty("payload");
        var items = payload.GetProperty("items");

        Assert.Equal(JsonValueKind.Array, items.ValueKind);
        Assert.Equal(Items.Count, items.GetArrayLength());

        // Order matters as much as content: a publisher that emitted one line twice, or
        // crossed quantity with unit price, must fail. The two fixtures differ in every
        // field precisely so it cannot pass by coincidence.
        var actual = items.EnumerateArray().ToArray();
        for (var i = 0; i < Items.Count; i++)
        {
            // Exactly the three keys the consumer's schema names — no line total: the
            // template multiplies, and a fourth figure could contradict the two it came from.
            Assert.Equal(
                new[] { "name", "quantity", "unit_price_cents" },
                actual[i].EnumerateObject().Select(p => p.Name).OrderBy(n => n, StringComparer.Ordinal).ToArray());

            // The NAME, not the product id: OrderDetail stores only ProductId, and the
            // consumer cannot resolve one into the other — an id would print verbatim
            // on the customer's receipt.
            Assert.Equal(Items[i].Name, actual[i].GetProperty("name").GetString());
            Assert.Equal(Items[i].Quantity, actual[i].GetProperty("quantity").GetUInt32());
            Assert.Equal(Items[i].UnitPriceCents, actual[i].GetProperty("unit_price_cents").GetInt64());
        }
    }

    [Fact]
    public async Task Embeds_the_shipping_address_as_a_json_object_not_a_string_of_json()
    {
        var (publisher, sqs, _) = Build();

        var payload = (await PublishAndReadBody(sqs, publisher)).GetProperty("payload");
        var address = payload.GetProperty("shipping_address");

        // Re-parsed from the stored snapshot, so the consumer receives a real object. Left
        // as a string it would arrive double-escaped and render on the receipt as a blob
        // of quotes and backslashes.
        Assert.Equal(JsonValueKind.Object, address.ValueKind);
        Assert.Equal("1 Ada Way", address.GetProperty("line1").GetString());
        Assert.Equal("San Juan", address.GetProperty("city").GetString());
        Assert.Equal("PR", address.GetProperty("country").GetString());
        Assert.Equal("00901", address.GetProperty("postal_code").GetString());
    }

    [Fact]
    public async Task Omits_shipping_address_entirely_when_the_buyer_has_none_on_file()
    {
        var (publisher, sqs, _) = Build();

        await Publish(publisher, shippingAddress: null);

        // Asserted against the RAW JSON as well as the parsed keys, exactly like
        // author.cognito_sub: `"shipping_address": null` would satisfy a ValueKind.Null
        // check while violating the contract, which says an absent address is ABSENT.
        var raw = sqs.Requests.Single().MessageBody;
        var payload = JsonDocument.Parse(raw).RootElement.GetProperty("payload");

        Assert.False(payload.TryGetProperty("shipping_address", out _));
        Assert.DoesNotContain("shipping_address", raw);

        // The rest of the receipt is unaffected — no address must never cost the buyer
        // the whole email.
        Assert.Equal(FullName, payload.GetProperty("full_name").GetString());
        Assert.Equal(Items.Count, payload.GetProperty("items").GetArrayLength());
    }

    [Fact]
    public async Task Author_records_who_originated_the_event_not_only_who_it_is_about()
    {
        var (publisher, sqs, _) = Build();

        var body = await PublishAndReadBody(sqs, publisher);
        var author = body.GetProperty("author");

        // A real human acted here — the buyer placed their own order — so all three keys
        // are present. `actor` is the same semantic value the audit columns carry.
        Assert.Equal(
            new[] { "actor", "cognito_sub", "user_id" },
            author.EnumerateObject().Select(p => p.Name).OrderBy(n => n, StringComparer.Ordinal).ToArray());

        // A literal, not AuditActor.CreateOrder: renaming the constant must not silently
        // rename the value the consumer reads.
        Assert.Equal("orders_api:create_order", author.GetProperty("actor").GetString());
        Assert.Equal(UserId, author.GetProperty("user_id").GetString());
        Assert.Equal(CognitoSub, author.GetProperty("cognito_sub").GetString());
    }

    [Fact]
    public async Task Author_does_not_repeat_the_producing_service()
    {
        var (publisher, sqs, _) = Build();

        var body = await PublishAndReadBody(sqs, publisher);

        // AuthorSchema has no `source`. Two copies of a per-publisher constant carry no
        // information and can only drift; the root one stays.
        Assert.False(body.GetProperty("author").TryGetProperty("source", out _));
        Assert.Equal("orders", body.GetProperty("source").GetString());
    }

    [Fact]
    public async Task Author_ids_are_real_ids_never_the_actor_label()
    {
        var (publisher, sqs, _) = Build();

        var body = await PublishAndReadBody(sqs, publisher);
        var author = body.GetProperty("author");

        // The failure this rules out is filling an unknown id with the actor string. A
        // consumer joining on author.user_id must get something joinable.
        Assert.DoesNotContain(":", author.GetProperty("user_id").GetString());
        Assert.DoesNotContain(":", author.GetProperty("cognito_sub").GetString());
        Assert.NotEqual(
            author.GetProperty("user_id").GetString(),
            author.GetProperty("cognito_sub").GetString());
    }

    [Fact]
    public async Task Omits_cognito_sub_entirely_rather_than_serializing_it_as_null()
    {
        var (publisher, sqs, _) = Build();

        // No sub supplied — the shape a producer with no human author sends.
        await Publish(publisher, cognitoSub: null);

        // Asserted against the RAW JSON as well as the parsed keys: `"cognito_sub": null`
        // would satisfy a ValueKind.Null check while violating the contract, which says
        // an unknown identity is ABSENT, never present-and-null.
        var raw = sqs.Requests.Single().MessageBody;
        var author = JsonDocument.Parse(raw).RootElement.GetProperty("author");

        Assert.Equal(
            new[] { "actor", "user_id" },
            author.EnumerateObject().Select(p => p.Name).OrderBy(n => n, StringComparer.Ordinal).ToArray());
        Assert.DoesNotContain("cognito_sub", raw);
    }

    [Fact]
    public async Task A_blank_cognito_sub_is_omitted_too_rather_than_sent_as_an_empty_string()
    {
        var (publisher, sqs, _) = Build();

        // proto3 has no null, so an absent identity can reach us as "". An empty string
        // would pass a null check and reach the consumer as a real-looking value.
        await Publish(publisher, cognitoSub: "  ");

        var raw = sqs.Requests.Single().MessageBody;
        Assert.DoesNotContain("cognito_sub", raw);
    }

    [Fact]
    public async Task Order_id_stays_present_despite_the_null_ignoring_serializer()
    {
        var (publisher, sqs, _) = Build();

        var body = await PublishAndReadBody(sqs, publisher);

        // Guards the WhenWritingNull switch made for the author: `order_id` is nullable
        // but REQUIRED, so a future null there would be silently DROPPED rather than
        // serialized, and the envelope would fail the consumer's schema. Orders always
        // sends a real id, which is what keeps that safe — pinned so it stays true.
        Assert.Equal(OrderId, body.GetProperty("order_id").GetString());
    }

    [Fact]
    public async Task Sets_type_and_source_as_message_attributes()
    {
        var (publisher, sqs, _) = Build();

        await Publish(publisher);

        // Duplicated as attributes so the queue can be inspected/filtered without
        // deserializing bodies.
        var attributes = Assert.Single(sqs.Requests).MessageAttributes;
        Assert.Equal("ORDER_CREATED", attributes["type"].StringValue);
        Assert.Equal("String", attributes["type"].DataType);
        Assert.Equal("orders", attributes["source"].StringValue);
        Assert.Equal("String", attributes["source"].DataType);
    }

    // The trace hop across the queue. Unlike `type`/`source`, this attribute duplicates
    // nothing in the body — it is how the consumer joins its own spans to the HTTP request
    // that produced the message. Asserted on the attributes, never on the body: the
    // envelope is a Zod-validated contract with no traceparent field.
    [Fact]
    public async Task Injects_the_active_activitys_traceparent_as_a_message_attribute()
    {
        using var listener = ListenToEverything();
        using var source = new ActivitySource(TestActivitySourceName);
        var (publisher, sqs, _) = Build();

        // StartActivity returns null unless something LISTENS to the source, and a null
        // activity would make this test pass for the wrong reason — so it is asserted.
        using var activity = source.StartActivity("publish-test");
        Assert.NotNull(activity);

        await Publish(publisher);

        var attributes = Assert.Single(sqs.Requests).MessageAttributes;
        var traceparent = attributes["traceparent"];
        Assert.Equal("String", traceparent.DataType);
        // W3C format: version-traceid-spanid-flags. Matching the shape rather than only
        // "not empty" is what catches a hand-built string or a non-W3C Activity id format.
        Assert.Matches("^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$", traceparent.StringValue);
        // Same TRACE as the caller's activity — a well-formed traceparent belonging to a
        // different trace would correlate nothing. Asserted on the trace id alone: the
        // SPAN id is deliberately NOT the caller's, which is what the test below pins.
        Assert.Equal(activity.TraceId.ToHexString(), traceparent.StringValue.Split('-')[1]);
    }

    // The regression test for the span-hierarchy bug: the message's traceparent named the
    // enclosing WORKFLOW span (create_order), not the send. The consumer parents its work
    // to whatever it receives, so process_record came out a SIBLING of the publish instead
    // of its child — expanding the send in the waterfall showed AWS SDK internals and none
    // of the work it actually caused.
    //
    // Asserted against the SpanId the publisher's own activity REPORTED at runtime, not a
    // re-derivation of the value under test: comparing the attribute to itself would pass
    // against any implementation, including the broken one.
    [Fact]
    public async Task Injects_the_publish_spans_traceparent_not_the_enclosing_workflows()
    {
        var started = new List<Activity>();
        using var listener = ListenToEverything(started);
        using var source = new ActivitySource(TestActivitySourceName);
        var (publisher, sqs, _) = Build();

        // Stands in for create_order: the workflow span the publish happens inside.
        using var workflow = source.StartActivity("create_order");
        Assert.NotNull(workflow);

        await Publish(publisher);

        var publishSpan = Assert.Single(
            started, a => a.OperationName == SqsEventPublisher.PublishActivityName);

        // A CHILD of the workflow, so the cascade stays one connected trace rather than
        // the publish starting a detached root.
        Assert.Equal(workflow.SpanId, publishSpan.ParentSpanId);
        Assert.Equal(workflow.TraceId, publishSpan.TraceId);

        var traceparent = Assert.Single(sqs.Requests).MessageAttributes["traceparent"].StringValue;
        var spanId = traceparent.Split('-')[2];

        // THE POINT: the id on the wire is the publish span's...
        Assert.Equal(publishSpan.SpanId.ToHexString(), spanId);
        // ...and specifically NOT the workflow's. Stated separately so a future change that
        // collapses the two spans into one fails here with the reason spelled out, instead
        // of silently satisfying the assertion above.
        Assert.NotEqual(workflow.SpanId.ToHexString(), spanId);
    }

    [Fact]
    public async Task Omits_traceparent_entirely_when_no_activity_is_active()
    {
        // No listener, so no Activity is ever created here.
        Assert.Null(Activity.Current);
        var (publisher, sqs, _) = Build();

        await Publish(publisher);

        var attributes = Assert.Single(sqs.Requests).MessageAttributes;
        // OMITTED, not present-and-empty. Beyond losing the correlation, SQS REJECTS a
        // MessageAttributeValue with an empty StringValue — an empty traceparent would
        // turn "no trace in scope" into a failed publish.
        Assert.False(attributes.ContainsKey("traceparent"));
        // The other two are unaffected by the absence.
        Assert.True(attributes.ContainsKey("type"));
        Assert.True(attributes.ContainsKey("source"));
    }

    // The other half of the omission rule, and the case the publish span introduced: a
    // listener IS attached, so the publisher's own activity is created even though no
    // caller started one. The traceparent must then be the publish span's — a root one —
    // rather than absent. Pinned because "no ambient activity" and "no activity at all"
    // stopped being the same situation once this class started creating its own span.
    [Fact]
    public async Task Injects_a_root_traceparent_when_the_publish_span_has_no_caller()
    {
        var started = new List<Activity>();
        using var listener = ListenToEverything(started);
        // No caller activity: the publish span is the root of its own trace.
        Assert.Null(Activity.Current);
        var (publisher, sqs, _) = Build();

        await Publish(publisher);

        var publishSpan = Assert.Single(
            started, a => a.OperationName == SqsEventPublisher.PublishActivityName);
        Assert.Equal(default, publishSpan.ParentSpanId);

        var traceparent = Assert.Single(sqs.Requests).MessageAttributes["traceparent"].StringValue;
        Assert.Matches("^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$", traceparent);
        Assert.Equal(publishSpan.SpanId.ToHexString(), traceparent.Split('-')[2]);
    }

    // The publish span was mute: it carried a traceparent but no log line of its own, so
    // "View logs" on it in OpenObserve returned nothing at all. That button filters by
    // trace_id AND span_id with no fallback to the trace, so only a line written while THIS
    // activity is current can answer it.
    //
    // Asserted with SpanScopedLogger, which records Activity.Current AT LOG TIME: a line
    // written after the publish activity was disposed renders identically and asserts its
    // app_event identically, while carrying the workflow's span id — the exact bug this
    // pins, and one only the ambient activity can detect.
    [Fact]
    public async Task Logs_the_publication_inside_the_publish_span_not_the_enclosing_workflow()
    {
        var started = new List<Activity>();
        using var listener = ListenToEverything(started);
        using var source = new ActivitySource(TestActivitySourceName);
        var sqs = new RecordingSqs(failure: null);
        var logger = new SpanScopedLogger<SqsEventPublisher>();
        var publisher = new SqsEventPublisher(sqs.Object, QueueUrl, logger);

        // Stands in for create_order, the workflow the publish runs inside — the span the
        // line used to be attributed to.
        using var workflow = source.StartActivity("create_order");
        Assert.NotNull(workflow);

        await Publish(publisher);

        var publishSpan = Assert.Single(
            started, a => a.OperationName == SqsEventPublisher.PublishActivityName);

        var entry = Assert.Single(logger.Entries);
        Assert.Equal(LogLevel.Information, entry.Level);
        // THE POINT: the ambient activity at log time is the publish span...
        Assert.Same(publishSpan, entry.Activity);
        // ...and specifically not the workflow, stated separately so a regression that
        // moves the line back outside the span fails with the reason spelled out.
        Assert.NotSame(workflow, entry.Activity);

        Assert.Equal("order_created_published", entry.Values["app_event"]);
        // What a human wants to know when they open this span: which event, for which
        // order, for whom. `event_id` is the pipeline's idempotency key, so this line is
        // what joins an order to the event document (and the email) on the other side.
        Assert.Equal("ORDER_CREATED", entry.Values["event_type"]);
        Assert.Equal(OrderId, entry.Values["order_id"]);
        Assert.Equal(UserId, entry.Values["user_id"]);

        // The very event_id that went on the wire, not merely some non-empty string: a
        // line naming a different id would be worse than no line at all.
        var body = JsonDocument.Parse(Assert.Single(sqs.Requests).MessageBody).RootElement;
        Assert.Equal(body.GetProperty("event_id").GetString(), entry.Values["event_id"]);
    }

    // No PII on the success line either. The failure line has its own version of this test;
    // this one exists because the success line is the one that carries payload-derived
    // values, and the payload is where the email, the name and the address live.
    [Fact]
    public async Task The_publication_log_leaks_no_email_name_or_address()
    {
        using var listener = ListenToEverything();
        var sqs = new RecordingSqs(failure: null);
        var logger = new SpanScopedLogger<SqsEventPublisher>();

        await Publish(new SqsEventPublisher(sqs.Object, QueueUrl, logger));

        // Over the rendered line AND every structured value — a field carrying the email
        // never shows up in the rendered text, which is how such a leak survives a weaker
        // assertion.
        var everything = string.Join(
            "\n",
            logger.Entries.Select(e => $"{e.Rendered}\n{string.Join("\n", e.Values.Select(v => $"{v.Key}={v.Value}"))}"));

        Assert.DoesNotContain(Email, everything);
        Assert.DoesNotContain("buyer", everything);
        Assert.DoesNotContain("@", everything);
        Assert.DoesNotContain(FullName, everything);
        Assert.DoesNotContain("Ada Way", everything);
    }

    // The failure line used to fall OUTSIDE the span: `using var activity` lived inside the
    // try, so an exception disposed it on the way to the catch and the line was attributed
    // to create_order. A red send is precisely when an operator clicks "View logs" on the
    // publish span, so that was the worst case to leave mute.
    [Fact]
    public async Task Logs_a_failed_publish_inside_the_publish_span_and_marks_it_error()
    {
        var started = new List<Activity>();
        using var listener = ListenToEverything(started);
        using var source = new ActivitySource(TestActivitySourceName);
        var sqs = new RecordingSqs(new AmazonSQSException("queue unreachable"));
        var logger = new SpanScopedLogger<SqsEventPublisher>();

        using var workflow = source.StartActivity("create_order");
        Assert.NotNull(workflow);

        // Still swallowed — the order must survive a dead queue.
        await Publish(new SqsEventPublisher(sqs.Object, QueueUrl, logger));

        var publishSpan = Assert.Single(
            started, a => a.OperationName == SqsEventPublisher.PublishActivityName);

        var entry = Assert.Single(logger.Entries);
        Assert.Equal(LogLevel.Error, entry.Level);
        Assert.Same(publishSpan, entry.Activity);
        Assert.NotSame(workflow, entry.Activity);
        Assert.Equal("order_created_publish_failed", entry.Values["app_event"]);
        Assert.Equal("sqs_send_failed", entry.Values["reason"]);

        // And the span itself is red, so the waterfall does not render a failed send as a
        // healthy hop. The workflow's own status is untouched: the publish is best-effort
        // and does not fail the order.
        Assert.Equal(ActivityStatusCode.Error, publishSpan.Status);
        Assert.Equal("queue unreachable", publishSpan.StatusDescription);
        Assert.Equal(ActivityStatusCode.Unset, workflow.Status);
    }

    // A source name unique to this file so the listener below cannot pick up activities
    // created by other tests running in parallel.
    private const string TestActivitySourceName = "orders-tests-sqs-publisher";

    // Samples everything from that one source, which is what makes StartActivity return a
    // real Activity instead of null. ActivityIdFormat.W3C is the .NET default here, so the
    // resulting Id IS a W3C traceparent string.
    // Listens to the test's own source AND to the publisher's, because the behaviour under
    // test spans both: the caller's workflow activity and the publish activity the
    // publisher creates inside it. Listening only to the test source would leave
    // StartActivity returning null inside the publisher, and the traceparent would fall
    // back to the workflow span — i.e. the bug would pass as if fixed.
    //
    // `started` records every activity the publisher starts, so the assertions can compare
    // against the REAL SpanId of the publish span rather than re-deriving it from the value
    // under test (which would be circular).
    private static ActivityListener ListenToEverything(List<Activity>? started = null)
    {
        var listener = new ActivityListener
        {
            ShouldListenTo = s =>
                s.Name == TestActivitySourceName || s.Name == SqsEventPublisher.ActivitySourceName,
            Sample = (ref ActivityCreationOptions<ActivityContext> _) =>
                ActivitySamplingResult.AllDataAndRecorded,
            ActivityStarted = activity => started?.Add(activity),
        };

        ActivitySource.AddActivityListener(listener);
        return listener;
    }

    [Fact]
    public async Task Generates_a_fresh_event_id_per_call()
    {
        var (publisher, sqs, _) = Build();

        // Same arguments both times: only an id minted INSIDE the publisher can differ.
        await Publish(publisher);
        await Publish(publisher);

        var ids = sqs.Requests
            .Select(r => JsonDocument.Parse(r.MessageBody).RootElement.GetProperty("event_id").GetString())
            .ToList();

        Assert.Equal(2, ids.Count);
        // event_id backs the pipeline's UNIQUE index: a fixed value would make the second
        // event collide and be discarded as a duplicate of the first.
        Assert.NotEqual(ids[0], ids[1]);
        Assert.All(ids, id => Assert.StartsWith("evt_", id));
    }

    [Fact]
    public async Task Swallows_a_publish_failure_so_the_order_survives()
    {
        var (publisher, _, logger) = Build(sendFailure: new AmazonSQSException("queue unreachable"));

        // No assertion that "the throwing fake threw" — the behaviour under test is that
        // the publisher does NOT propagate, i.e. the caller's transaction is not aborted.
        await Publish(publisher);

        // Swallowed is not the same as hidden: it must still be alertable.
        var entry = Assert.Single(logger.Entries);
        Assert.Equal(LogLevel.Error, entry.Level);
        Assert.Contains("order_created_publish_failed", entry.Rendered);
        Assert.Contains(OrderId, entry.Rendered);
    }

    [Fact]
    public async Task Publish_failure_log_leaks_no_email_and_no_address()
    {
        var (publisher, _, logger) = Build(sendFailure: new AmazonSQSException("queue unreachable"));

        await Publish(publisher);

        // Read over EVERYTHING the logger received — rendered message, the raw template,
        // every structured value, and the exception — not just the formatted line. A
        // structured field carrying the address would never appear in the rendered text,
        // which is precisely how such a leak survives a weaker assertion.
        var everything = string.Join("\n", logger.Entries.Select(e => e.Everything));

        Assert.DoesNotContain(Email, everything);
        // The local part alone, in case only part of the address were interpolated.
        Assert.DoesNotContain("buyer", everything);
        Assert.DoesNotContain("@", everything);
    }

    // Captures the requests the publisher actually built. IAmazonSQS is far too wide to
    // implement by hand, so Moq supplies the surface — but every assertion in this file
    // reads `Requests`, i.e. the real SendMessageRequest the publisher constructed, never
    // the stub's own configured return value.
    //
    // MockBehavior.Strict on purpose: any call other than SendMessageAsync throws instead
    // of silently returning a default.
    private sealed class RecordingSqs
    {
        public RecordingSqs(Exception? failure)
        {
            var mock = new Mock<IAmazonSQS>(MockBehavior.Strict);
            var setup = mock
                .Setup(s => s.SendMessageAsync(It.IsAny<SendMessageRequest>(), It.IsAny<CancellationToken>()))
                // Records BEFORE the outcome, so even the failure path can be asserted on
                // the request that was actually built.
                .Callback<SendMessageRequest, CancellationToken>((req, _) => Requests.Add(req));

            if (failure is null)
            {
                setup.ReturnsAsync(new SendMessageResponse());
            }
            else
            {
                setup.ThrowsAsync(failure);
            }

            Object = mock.Object;
        }

        public List<SendMessageRequest> Requests { get; } = new();
        public IAmazonSQS Object { get; }
    }

    private sealed record LogEntry(LogLevel Level, string Rendered, string Everything);

    // Captures not only the rendered line but the template, every structured value, and the
    // exception — the PII test needs all of them (see its comment).
    private sealed class CapturingLogger : ILogger<SqsEventPublisher>
    {
        public List<LogEntry> Entries { get; } = new();

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            var rendered = formatter(state, exception);
            var parts = new List<string> { rendered, exception?.ToString() ?? string.Empty };

            if (state is IReadOnlyList<KeyValuePair<string, object?>> values)
            {
                // Includes {OriginalFormat} — the raw template — alongside each value.
                parts.AddRange(values.Select(v => $"{v.Key}={v.Value}"));
            }

            Entries.Add(new LogEntry(logLevel, rendered, string.Join("\n", parts)));
        }
    }
}
