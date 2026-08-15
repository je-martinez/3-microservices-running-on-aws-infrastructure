using Orders.Infrastructure.Id;

namespace Orders.Tests.Logging;

// Pins the correlation id's format and, more importantly, its VALIDATION — the
// header is untrusted input that lands on every log line of the request and is
// forwarded to Tracking and onto the SQS envelope, so what Resolve accepts is a
// security boundary and not a formatting preference (see RequestId.Resolve).
public class RequestIdTests
{
    // A well-formed id: req_ + EXACTLY 21 characters of the default URL-safe
    // alphabet, including the two non-alphanumerics it actually contains (_ and -).
    private const string ValidId = "req_V1StGXR8_Z5jdHi6B-MyT";

    [Fact]
    public void New_produces_a_prefixed_21_character_nano_id()
    {
        var id = RequestId.New();

        Assert.StartsWith("req_", id);
        // 4 (prefix) + 21. Asserted as the total length rather than by re-deriving
        // it, so a change to the size fails here instead of being computed away.
        Assert.Equal(25, id.Length);
        // The generator must produce something its own validator accepts — the two
        // drifting apart would mean every generated id gets thrown away downstream.
        Assert.Equal(id, RequestId.Resolve(id));
    }

    [Fact]
    public void New_produces_a_different_id_each_time()
    {
        // A constant would correlate every unrelated flow into one, which is worse
        // than having no id at all.
        Assert.NotEqual(RequestId.New(), RequestId.New());
    }

    [Fact]
    public void Resolve_honours_a_valid_caller_id()
    {
        // The whole point of the field: the caller's id survives the hop, so both
        // sides' log lines carry the same value.
        Assert.Equal(ValidId, RequestId.Resolve(ValidId));
    }

    [Theory]
    // No header at all — by far the common case.
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    // Correct 21-char body, WRONG PREFIX. Accepting these would let a caller pass
    // off an order or user id as a correlation id and cross-contaminate log queries.
    [InlineData("ord_V1StGXR8_Z5jdHi6B-MyT")]
    [InlineData("usr_V1StGXR8_Z5jdHi6B-MyT")]
    // No prefix at all — a bare 21-char nanoid.
    [InlineData("V1StGXR8_Z5jdHi6B-MyT")]
    // Prefix casing: the comparison is case-sensitive on the prefix.
    [InlineData("REQ_V1StGXR8_Z5jdHi6B-MyT")]
    // Right prefix, WRONG LENGTH — one short and one long. The pattern is exact,
    // not a minimum, so neither may pass.
    [InlineData("req_V1StGXR8_Z5jdHi6B-My")]
    [InlineData("req_V1StGXR8_Z5jdHi6B-MyTT")]
    // Bare prefix.
    [InlineData("req_")]
    // Right length, but with a character OUTSIDE the alphabet: a space, a quote that
    // would break the JSON a dashboard parses, a newline that would forge a second
    // log record, and a percent-encoding attempt.
    [InlineData("req_V1StGXR8 Z5jdHi6B-MyT")]
    [InlineData("req_V1StGXR8\"Z5jdHi6B-MyT")]
    [InlineData("req_V1StGXR8\nZ5jdHi6B-MyT")]
    [InlineData("req_V1StGXR8%0AZ5jdHi6-MyT")]
    // Anchoring: a VALID id embedded in a longer string. Without both anchors these
    // would match and carry the surrounding junk onto every log line of the flow.
    [InlineData("req_V1StGXR8_Z5jdHi6B-MyT extra")]
    [InlineData("prefix req_V1StGXR8_Z5jdHi6B-MyT")]
    [InlineData("req_V1StGXR8_Z5jdHi6B-MyT\nreq_V1StGXR8_Z5jdHi6B-MyT")]
    public void Resolve_discards_anything_that_is_not_one_of_ours(string? headerValue)
    {
        var resolved = RequestId.Resolve(headerValue);

        // Discarded, not echoed — and replaced with a usable id rather than nothing,
        // because a malformed correlation header must never fail the request or leave
        // the flow uncorrelated.
        Assert.NotEqual(headerValue, resolved);
        Assert.StartsWith("req_", resolved);
        Assert.Equal(resolved, RequestId.Resolve(resolved));
    }

    [Fact]
    public void Resolve_rejects_an_oversized_value()
    {
        // The failure this most protects against: an unbounded string copied onto
        // every log line of the flow. Sized well past any accident.
        var oversized = "req_" + new string('a', 10_000);

        Assert.Equal(25, RequestId.Resolve(oversized).Length);
    }

    [Fact]
    public void Header_name_is_the_lowercase_cross_service_spelling()
    {
        // Every service in this repo reads and writes this exact spelling; a drift
        // here would silently break correlation at the seam rather than fail loudly.
        Assert.Equal("x-request-id", RequestId.HeaderName);
    }
}
