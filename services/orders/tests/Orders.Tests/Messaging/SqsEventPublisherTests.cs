using System.Text.Json;
using Amazon.SQS;
using Amazon.SQS.Model;
using Microsoft.Extensions.Logging;
using Moq;
using Orders.Infrastructure.Messaging;

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
    private const long TotalCents = 4599;

    private static readonly DateTime CreatedAt =
        new(2026, 8, 3, 14, 30, 15, DateTimeKind.Utc);

    private static (SqsEventPublisher Publisher, RecordingSqs Sqs, CapturingLogger Logger) Build(
        Exception? sendFailure = null)
    {
        var sqs = new RecordingSqs(sendFailure);
        var logger = new CapturingLogger();
        return (new SqsEventPublisher(sqs.Object, QueueUrl, logger), sqs, logger);
    }

    private static async Task<JsonElement> PublishAndReadBody(RecordingSqs sqs, SqsEventPublisher publisher)
    {
        await publisher.PublishOrderCreatedAsync(OrderId, UserId, Email, TotalCents, CreatedAt);
        return JsonDocument.Parse(sqs.Requests.Single().MessageBody).RootElement;
    }

    [Fact]
    public async Task Sends_one_message_to_the_configured_queue_url()
    {
        var (publisher, sqs, _) = Build();

        await publisher.PublishOrderCreatedAsync(OrderId, UserId, Email, TotalCents, CreatedAt);

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

        // EnvelopeSchema requires all six. `order_id` is nullable but NOT optional: an
        // absent key fails validation just as a wrong name would.
        Assert.Equal(
            new[] { "event_id", "order_id", "payload", "source", "type", "user_id" },
            body.EnumerateObject().Select(p => p.Name).OrderBy(n => n, StringComparer.Ordinal).ToArray());

        Assert.Equal("ORDER_CREATED", body.GetProperty("type").GetString());
        Assert.Equal("orders", body.GetProperty("source").GetString());
        Assert.Equal(UserId, body.GetProperty("user_id").GetString());
        // Unlike USER_CREATED (which sends null), ORDER_CREATED carries the real order id.
        Assert.Equal(OrderId, body.GetProperty("order_id").GetString());
        Assert.False(string.IsNullOrWhiteSpace(body.GetProperty("event_id").GetString()));
    }

    [Fact]
    public async Task Payload_matches_the_consumers_OrderCreatedPayloadSchema()
    {
        var (publisher, sqs, _) = Build();

        var body = await PublishAndReadBody(sqs, publisher);
        var payload = body.GetProperty("payload");

        // The five fields OrderCreatedPayloadSchema requires — exactly, and snake_case.
        // `email` is the one the original plan omitted: without it every ORDER_CREATED
        // would be rejected as a PermanentError and no confirmation email ever sent.
        Assert.Equal(
            new[] { "created_at", "email", "order_id", "total_cents", "user_id" },
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
    public async Task Sets_type_and_source_as_message_attributes()
    {
        var (publisher, sqs, _) = Build();

        await publisher.PublishOrderCreatedAsync(OrderId, UserId, Email, TotalCents, CreatedAt);

        // Duplicated as attributes so the queue can be inspected/filtered without
        // deserializing bodies.
        var attributes = Assert.Single(sqs.Requests).MessageAttributes;
        Assert.Equal("ORDER_CREATED", attributes["type"].StringValue);
        Assert.Equal("String", attributes["type"].DataType);
        Assert.Equal("orders", attributes["source"].StringValue);
        Assert.Equal("String", attributes["source"].DataType);
    }

    [Fact]
    public async Task Generates_a_fresh_event_id_per_call()
    {
        var (publisher, sqs, _) = Build();

        // Same arguments both times: only an id minted INSIDE the publisher can differ.
        await publisher.PublishOrderCreatedAsync(OrderId, UserId, Email, TotalCents, CreatedAt);
        await publisher.PublishOrderCreatedAsync(OrderId, UserId, Email, TotalCents, CreatedAt);

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
        await publisher.PublishOrderCreatedAsync(OrderId, UserId, Email, TotalCents, CreatedAt);

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

        await publisher.PublishOrderCreatedAsync(OrderId, UserId, Email, TotalCents, CreatedAt);

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
