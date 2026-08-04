using System.Net;
using System.Net.Http.Json;
using Microsoft.EntityFrameworkCore;
using Orders.Application.Abstractions;
using Orders.Application.Orders;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;
using Orders.Infrastructure.Persistence;

namespace Orders.Tests.Api;

// The E2E tagging mechanism, end-to-end through the real pipeline with
// E2E_TESTING_ENABLED on: x-e2e-source tags the created order, the tag is forwarded
// to Tracking, and e2e-cleanup soft-deletes BY TAG rather than by caller.
//
// The mirror-image case — the same header with the flag OFF — lives in
// E2eTagsDisabledTests, which needs a host built without the flag.
[Collection(OrdersE2eApiCollection.Name)]
public class E2eTagsAndCleanupTests
{
    private readonly OrdersE2eApiFactory _factory;
    public E2eTagsAndCleanupTests(OrdersE2eApiFactory factory) => _factory = factory;

    private async Task<string> CreateOrder(string sub, bool e2eSource)
    {
        var client = _factory.CreateClient();
        var request = new HttpRequestMessage(HttpMethod.Post, "/v1/orders")
        {
            Content = JsonContent.Create(new
            {
                lines = new[] { new { productId = _factory.SeededProductId, quantity = 1 } },
            }),
        };
        request.Headers.Add("x-user-id", sub);
        if (e2eSource)
        {
            request.Headers.Add("x-e2e-source", "true");
        }

        var response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<OrderDto>();
        return body!.Id;
    }

    // IgnoreQueryFilters: a soft-deleted row is hidden by the global
    // DeletedAt == null filter, and whether it still EXISTS is the point.
    private async Task<Order> LoadOrder(string orderId)
    {
        await using var db = _factory.NewContext();
        return await db.Orders.AsNoTracking().IgnoreQueryFilters().FirstAsync(o => o.Id == orderId);
    }

    [Fact]
    public async Task Creating_with_the_header_tags_the_order()
    {
        var orderId = await CreateOrder(OrdersE2eApiFactory.KnownCognitoSub, e2eSource: true);

        var order = await LoadOrder(orderId);
        Assert.Equal(new[] { Order.E2eSourceTag }, order.Tags);
    }

    [Fact]
    public async Task Creating_without_the_header_leaves_tags_empty_not_null()
    {
        var orderId = await CreateOrder(OrdersE2eApiFactory.KnownCognitoSub, e2eSource: false);

        var order = await LoadOrder(orderId);
        // Empty, and non-null: a reader must never have to distinguish "no tags" from
        // "unknown" (see Order.Tags).
        Assert.NotNull(order.Tags);
        Assert.Empty(order.Tags);
    }

    [Fact]
    public async Task Creating_with_the_header_forwards_e2e_source_to_tracking()
    {
        await CreateOrder(OrdersE2eApiFactory.KnownCognitoSub, e2eSource: true);

        // Tracking tags its own record from this, so an E2E run is removable by tag on
        // both sides of the seam.
        Assert.True(_factory.Tracking.E2eSource);
    }

    [Fact]
    public async Task Creating_without_the_header_forwards_false_to_tracking()
    {
        await CreateOrder(OrdersE2eApiFactory.KnownCognitoSub, e2eSource: false);

        Assert.False(_factory.Tracking.E2eSource);
    }

    [Fact]
    public async Task Cleanup_soft_deletes_tagged_orders_and_leaves_untagged_intact()
    {
        var tagged = await CreateOrder(OrdersE2eApiFactory.KnownCognitoSub, e2eSource: true);
        var untagged = await CreateOrder(OrdersE2eApiFactory.KnownCognitoSub, e2eSource: false);

        var response = await _factory.CreateClient().DeleteAsync("/v1/orders/e2e-cleanup");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var taggedRow = await LoadOrder(tagged);
        Assert.NotNull(taggedRow.DeletedAt);

        // The one real risk of deleting by tag is over-reach: an untagged order is a
        // real customer's, and must be untouched.
        var untaggedRow = await LoadOrder(untagged);
        Assert.Null(untaggedRow.DeletedAt);
        Assert.Null(untaggedRow.DeletedBy);
    }

    [Fact]
    public async Task Cleanup_is_a_soft_delete_stamped_with_the_e2e_actor()
    {
        var orderId = await CreateOrder(OrdersE2eApiFactory.KnownCognitoSub, e2eSource: true);

        await _factory.CreateClient().DeleteAsync("/v1/orders/e2e-cleanup");

        // The row still exists — never a physical DELETE ([[soft-delete]]) — and carries
        // the semantic actor, which ExecuteUpdate stamps explicitly because it bypasses
        // the AuditInterceptor.
        var order = await LoadOrder(orderId);
        Assert.NotNull(order.DeletedAt);
        Assert.Equal(AuditActor.E2eCleanup, order.DeletedBy);
    }

    [Fact]
    public async Task Cleanup_also_soft_deletes_the_details_of_a_tagged_order()
    {
        var orderId = await CreateOrder(OrdersE2eApiFactory.KnownCognitoSub, e2eSource: true);

        await _factory.CreateClient().DeleteAsync("/v1/orders/e2e-cleanup");

        // OrderDetail carries no tag of its own; it is removed through its parent. Left
        // behind, each line would be a live child of a deleted order.
        await using var db = _factory.NewContext();
        var details = await db.OrderDetails.AsNoTracking().IgnoreQueryFilters()
            .Where(d => d.OrderId == orderId)
            .ToListAsync();

        Assert.NotEmpty(details);
        Assert.All(details, d =>
        {
            Assert.NotNull(d.DeletedAt);
            Assert.Equal(AuditActor.E2eCleanup, d.DeletedBy);
        });
    }

    [Fact]
    public async Task Cleanup_removes_tagged_orders_of_every_user_not_just_the_caller()
    {
        var mine = await CreateOrder(OrdersE2eApiFactory.KnownCognitoSub, e2eSource: true);
        var theirs = await CreateOrder(OrdersE2eApiFactory.OtherCognitoSub, e2eSource: true);

        // Deliberately no x-user-id at all: the global teardown calls this with no
        // identity, and the tag — not the caller — is what selects the rows.
        await _factory.CreateClient().DeleteAsync("/v1/orders/e2e-cleanup");

        Assert.NotNull((await LoadOrder(mine)).DeletedAt);
        Assert.NotNull((await LoadOrder(theirs)).DeletedAt);
    }

    [Fact]
    public async Task Cleanup_without_x_user_id_is_not_401()
    {
        var response = await _factory.CreateClient().DeleteAsync("/v1/orders/e2e-cleanup");

        // The teardown runs unauthenticated; a 401 here would silently leave every test
        // row in the database.
        Assert.NotEqual(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task Cleanup_reports_how_many_rows_it_deleted()
    {
        // Drain anything earlier tests left tagged, so the count below is this test's.
        await _factory.CreateClient().DeleteAsync("/v1/orders/e2e-cleanup");

        await CreateOrder(OrdersE2eApiFactory.KnownCognitoSub, e2eSource: true);
        await CreateOrder(OrdersE2eApiFactory.KnownCognitoSub, e2eSource: true);

        var response = await _factory.CreateClient().DeleteAsync("/v1/orders/e2e-cleanup");

        // Asserted on the RAW JSON rather than a deserialized record: a record binds
        // case-insensitively and would pass against any casing, while the teardown reads
        // the `deleted` key literally (the same key Users' cleanup returns).
        var raw = await response.Content.ReadAsStringAsync();
        Assert.Contains("\"deleted\":2", raw);
        // One line per order in this fixture.
        Assert.Contains("\"deletedDetails\":2", raw);
    }

    [Fact]
    public async Task Cleanup_on_an_empty_set_deletes_nothing_and_still_succeeds()
    {
        await _factory.CreateClient().DeleteAsync("/v1/orders/e2e-cleanup");

        var response = await _factory.CreateClient().DeleteAsync("/v1/orders/e2e-cleanup");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<CleanupBody>();
        Assert.Equal(0, body!.Deleted);
    }

    [Fact]
    public async Task Cleanup_restores_catalogue_stock_to_the_seed_quantities()
    {
        // Orders permanently decrement stock and a soft-delete does not give it back, so
        // without this the catalogue drains a little on every run until the suite fails
        // with "no product with stock in the catalogue".
        //
        // Uses the SEED's product names, not the fixture's own product: the restore is
        // keyed by name off ProductSeed.SeedStock, so a product the seed does not know
        // about is deliberately left alone.
        var (seedName, seedUnits) = ProductSeed.SeedStock[0];
        // Tracked by ID, not by name: this row is left behind for the rest of the class,
        // and the seeded catalogue may hold another product of the same name. Asserting
        // on "the first Widget" would then read whichever row the database returned.
        var drainedId = NanoId.NewId(NanoId.ProductPrefix);

        await using (var db = _factory.NewContext())
        {
            db.Products.Add(new Product
            {
                Id = drainedId,
                Name = seedName,
                Description = "drained by a previous run",
                UnitPriceCents = 1999,
                UnitsInStock = 0,
                CreatedAt = DateTime.UtcNow,
                UpdatedAt = DateTime.UtcNow,
            });
            await db.SaveChangesAsync();
        }

        var response = await _factory.CreateClient().DeleteAsync("/v1/orders/e2e-cleanup");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        await using (var db = _factory.NewContext())
        {
            var restored = await db.Products.AsNoTracking().FirstAsync(p => p.Id == drainedId);
            Assert.Equal(seedUnits, restored.UnitsInStock);
        }
    }

    [Fact]
    public async Task Cleanup_does_not_lower_stock_that_is_already_at_or_above_the_seed()
    {
        // The restore is a floor, not an assignment: it only raises a drained product.
        // The fixture's own product sits at 1000 — far above any seed quantity — and a
        // blind SetProperty would knock it down and break the fixture's other tests.
        await _factory.CreateClient().DeleteAsync("/v1/orders/e2e-cleanup");

        await using var db = _factory.NewContext();
        var fixtureProduct = await db.Products.AsNoTracking()
            .FirstAsync(p => p.Id == _factory.SeededProductId);
        Assert.True(
            fixtureProduct.UnitsInStock >= 999,
            $"the fixture's product was restocked down to {fixtureProduct.UnitsInStock}");
    }

    private sealed record CleanupBody(int Deleted, int DeletedDetails);
}
