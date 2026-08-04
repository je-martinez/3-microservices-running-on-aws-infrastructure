using System.Text.Json;
using Orders.Application.Tracking;

namespace Orders.Tests.Infrastructure;

/// <summary>
/// Guards Orders' copy of Tracking's response contract.
/// </summary>
/// <remarks>
/// <para>
/// Orders maps Tracking's payload into <see cref="TrackingDto"/> rather than forwarding
/// it opaquely, which buys an explicit schema and a compiler that knows the shape — at
/// the cost of a second copy of someone else's contract. These tests are what makes that
/// cost payable: they fail when the two drift, so the divergence surfaces in CI instead
/// of as a field that quietly arrives empty in a UI.
/// </para>
/// <para>
/// <b>Runtime stays tolerant.</b> Nothing here asks the deserializer to reject unknown
/// members — a Tracking deploy that adds a field must not break an Orders read in
/// production. Detection belongs in CI, not in the request path.
/// </para>
/// <para>
/// This is the fast half. The other half lives in the gateway E2E suite, which asserts
/// the same shape against a tracking Tracking actually produced — a fixture only catches
/// drift once somebody updates it, so the live check is what catches the rest.
/// </para>
/// </remarks>
public class TrackingContractTests
{
    /// <summary>
    /// A batch response exactly as Tracking's schemas.py defines it. Update this fixture
    /// and <see cref="TrackingDto"/> together, never one alone.
    /// </summary>
    private const string BatchFixture = """
        {
          "trackings": [
            {
              "id": "trk_2f8Kq1xWpLmN0aBcDeFgH",
              "user_id": "usr_9zYxWvUtSrQpOnMlKjIhG",
              "order_id": "ord_1aBcDeFgHiJkLmNoPqRsT",
              "status": "SHIPPED",
              "datetime": "2026-07-31T10:15:00Z",
              "history": [
                {
                  "tracking_id": "trk_2f8Kq1xWpLmN0aBcDeFgH",
                  "user_id": "usr_9zYxWvUtSrQpOnMlKjIhG",
                  "order_id": "ord_1aBcDeFgHiJkLmNoPqRsT",
                  "status": "SHIPPED",
                  "datetime": "2026-07-31T10:15:00Z"
                }
              ]
            }
          ]
        }
        """;

    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);

    [Fact]
    public void The_fixture_maps_onto_the_dto_with_every_member_populated()
    {
        var batch = JsonSerializer.Deserialize<TrackingBatchDto>(BatchFixture, Options);

        Assert.NotNull(batch);
        var tracking = Assert.Single(batch!.Trackings);

        // Asserting every member individually, rather than that the object is non-null:
        // a renamed field deserializes to null on a nullable member and to the type
        // default otherwise, so only a per-member check catches a rename.
        Assert.Equal("trk_2f8Kq1xWpLmN0aBcDeFgH", tracking.Id);
        Assert.Equal("usr_9zYxWvUtSrQpOnMlKjIhG", tracking.UserId);
        Assert.Equal("ord_1aBcDeFgHiJkLmNoPqRsT", tracking.OrderId);
        Assert.Equal("SHIPPED", tracking.Status);
        Assert.Equal("2026-07-31T10:15:00Z", tracking.Datetime);

        var entry = Assert.Single(tracking.History);
        // The history entry names the tracking `tracking_id`, NOT `id` — the one place
        // the two shapes differ, and the easiest to get wrong when adding a field.
        Assert.Equal("trk_2f8Kq1xWpLmN0aBcDeFgH", entry.TrackingId);
        Assert.Equal("usr_9zYxWvUtSrQpOnMlKjIhG", entry.UserId);
        Assert.Equal("ord_1aBcDeFgHiJkLmNoPqRsT", entry.OrderId);
        Assert.Equal("SHIPPED", entry.Status);
        Assert.Equal("2026-07-31T10:15:00Z", entry.Datetime);
    }

    [Fact]
    public void Every_key_in_the_fixture_is_claimed_by_the_dto()
    {
        // The direction the mapping test cannot cover. Deserializing proves Orders can
        // read what it knows about; this proves Orders knows about everything Tracking
        // sends. Without it, a field added to the fixture (mirroring one added to
        // Tracking) would pass unnoticed — exactly the drift these tests exist for.
        var expectedTrackingKeys = new[] { "id", "user_id", "order_id", "status", "datetime", "history" };
        var expectedHistoryKeys = new[] { "tracking_id", "user_id", "order_id", "status", "datetime" };

        using var document = JsonDocument.Parse(BatchFixture);
        var tracking = document.RootElement.GetProperty("trackings")[0];

        var actualTrackingKeys = tracking.EnumerateObject().Select(p => p.Name).ToArray();
        Assert.Equal(expectedTrackingKeys.OrderBy(k => k), actualTrackingKeys.OrderBy(k => k));

        var actualHistoryKeys = tracking.GetProperty("history")[0]
            .EnumerateObject().Select(p => p.Name).ToArray();
        Assert.Equal(expectedHistoryKeys.OrderBy(k => k), actualHistoryKeys.OrderBy(k => k));
    }

    [Fact]
    public void An_unknown_member_is_ignored_rather_than_throwing()
    {
        // The production guarantee, pinned. Tracking shipping a new field must degrade
        // to "Orders does not surface it yet", never to a failed order read. If someone
        // later sets UnmappedMemberHandling.Disallow, this fails and says why.
        const string withNewField = """
            {
              "trackings": [
                {
                  "id": "trk_x", "user_id": "usr_x", "order_id": "ord_x",
                  "status": "SHIPPED", "datetime": "2026-07-31T10:15:00Z",
                  "history": [],
                  "carrier_name": "a field Orders has never heard of"
                }
              ]
            }
            """;

        var batch = JsonSerializer.Deserialize<TrackingBatchDto>(withNewField, Options);

        var tracking = Assert.Single(batch!.Trackings);
        Assert.Equal("ord_x", tracking.OrderId);
    }

    [Fact]
    public void An_empty_batch_deserializes_to_an_empty_list_not_null()
    {
        // Tracking returns `{"trackings": []}` when the caller owns none of the ids —
        // an ordinary outcome, not an error, so it must not need null-handling upstream.
        var batch = JsonSerializer.Deserialize<TrackingBatchDto>("""{"trackings": []}""", Options);

        Assert.NotNull(batch);
        Assert.Empty(batch!.Trackings);
    }
}
