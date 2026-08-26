using System.Net;
using System.Net.Http.Json;
using Microsoft.EntityFrameworkCore;
using Orders.Api.Endpoints;
using Orders.Application.Abstractions;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;

namespace Orders.Tests.Api;

// The internal cascade route used by Users' DELETE /v1/users/me. It is NOT on the
// API Gateway and never sees an end-user JWT: its only credential is the shared
// internal GRPC_API_KEY.
public class InternalDeleteByUserTests : IClassFixture<OrdersE2eApiFactory>
{
    private const string Path = "/v1/orders/by-user";
    private readonly OrdersE2eApiFactory _factory;

    public InternalDeleteByUserTests(OrdersE2eApiFactory factory) => _factory = factory;

    // The route keys on EITHER identity, so every request carries both. `usr` defaults
    // to a value no seeded row uses, which keeps the pre-existing sub-only tests testing
    // what they always tested: without that, a shared default user id would make every
    // one of them pass through the new OR branch and the sub branch would go unexercised.
    private HttpRequestMessage Request(
        string? sub,
        string? apiKey = "test-key",
        string? usr = "usr_no_such_user")
    {
        var request = new HttpRequestMessage(HttpMethod.Delete, Path)
        {
            Content = JsonContent.Create(new { cognitoSub = sub, userId = usr }),
        };
        if (apiKey is not null) request.Headers.Add("x-api-key", apiKey);
        return request;
    }

    // userId defaults to a per-order unique value for the same reason: a shared literal
    // would make unrelated rows collide on the OR's user_id side, and a test asserting
    // "another user's order survived" would fail for a reason having nothing to do with
    // the behaviour it names.
    private async Task<string> SeedOrderAsync(string sub, string? userId = null)
    {
        await using var db = _factory.NewContext();
        var orderId = NanoId.NewId(NanoId.OrderPrefix);
        db.Orders.Add(new Order
        {
            Id = orderId,
            UserId = userId ?? NanoId.NewId("usr_"),
            CognitoSub = sub,
            SubtotalCents = 0,
            TaxCents = 0,
            TotalCents = 0,
        });
        await db.SaveChangesAsync();
        return orderId;
    }

    [Fact]
    public async Task Rejects_a_request_with_no_api_key()
    {
        var response = await _factory.CreateClient().SendAsync(Request("sub-x", apiKey: null));
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Rejects_a_request_with_a_wrong_api_key()
    {
        var response = await _factory.CreateClient().SendAsync(Request("sub-x", apiKey: "wrong"));
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Soft_deletes_the_users_orders_and_stamps_the_actor()
    {
        const string sub = "sub-cascade-1";
        var orderId = await SeedOrderAsync(sub);

        var response = await _factory.CreateClient().SendAsync(Request(sub));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        await using var db = _factory.NewContext();
        var order = await db.Orders.AsNoTracking().IgnoreQueryFilters()
            .FirstAsync(o => o.Id == orderId);
        Assert.NotNull(order.DeletedAt);
        Assert.Equal(AuditActor.DeleteByUser, order.DeletedBy);
    }

    [Fact]
    public async Task Does_not_touch_another_users_orders()
    {
        var mine = await SeedOrderAsync("sub-cascade-2");
        var theirs = await SeedOrderAsync("sub-untouched");

        await _factory.CreateClient().SendAsync(Request("sub-cascade-2"));

        await using var db = _factory.NewContext();
        Assert.NotNull((await db.Orders.AsNoTracking().IgnoreQueryFilters()
            .FirstAsync(o => o.Id == mine)).DeletedAt);
        Assert.Null((await db.Orders.AsNoTracking().IgnoreQueryFilters()
            .FirstAsync(o => o.Id == theirs)).DeletedAt);
    }

    [Fact]
    public async Task Is_idempotent_a_second_call_deletes_nothing_more()
    {
        const string sub = "sub-cascade-3";
        await SeedOrderAsync(sub);

        var first = await (await _factory.CreateClient().SendAsync(Request(sub)))
            .Content.ReadFromJsonAsync<InternalDeleteResponse>();
        var second = await (await _factory.CreateClient().SendAsync(Request(sub)))
            .Content.ReadFromJsonAsync<InternalDeleteResponse>();

        Assert.Equal(1, first!.Deleted);
        Assert.Equal(0, second!.Deleted);
    }

    [Fact]
    public async Task Returns_zero_for_a_user_with_nothing()
    {
        var response = await _factory.CreateClient().SendAsync(Request("sub-nothing-here"));
        var body = await response.Content.ReadFromJsonAsync<InternalDeleteResponse>();

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(0, body!.Deleted);
    }

    // The cognito_sub guard: a real failure branch that used to return with no log
    // line and no reason at all. Whitespace and null are covered separately because
    // the check is IsNullOrWhiteSpace — a blank string is the case a plain null check
    // would let through into a query that soft-deletes on `CognitoSub == "  "`.
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public async Task Rejects_a_missing_or_blank_cognito_sub(string? sub)
    {
        var response = await _factory.CreateClient().SendAsync(Request(sub));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);

        var body = await response.Content.ReadFromJsonAsync<ErrorBody>();
        Assert.Equal("cognito_sub_required", body!.Error);
    }

    // The user_id guard, with its own distinct reason rather than a shared
    // "identity_required": the caller is Users, and which field it failed to send is
    // the only fact that points an operator at the bug.
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public async Task Rejects_a_missing_or_blank_user_id(string? usr)
    {
        var response = await _factory.CreateClient()
            .SendAsync(Request("sub-has-one", usr: usr));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);

        var body = await response.Content.ReadFromJsonAsync<ErrorBody>();
        Assert.Equal("user_id_required", body!.Error);
    }

    // THE DANGEROUS CASE, and the reason both guards are load-bearing rather than
    // defensive. `cognito_sub` and `user_id` are both NOT NULL varchar in MySQL, which
    // still permits the EMPTY STRING — so an empty identity reaching either side of the
    // handler's OR would match every row whose column was left blank, i.e. erase data
    // belonging to someone else entirely. The assertion is not merely "returns 400": it
    // is that a row carrying an empty column SURVIVES the rejected call. A guard that
    // returned 400 after running the query would pass a status-only test.
    [Theory]
    [InlineData("", "usr_whatever")]
    [InlineData("sub-whatever", "")]
    public async Task An_empty_identity_deletes_nothing_at_all(string sub, string usr)
    {
        // Empty on BOTH columns, so it is a candidate for whichever side of the OR the
        // blank value would have reached.
        var victim = await SeedOrderAsync(sub: string.Empty, userId: string.Empty);

        var response = await _factory.CreateClient().SendAsync(Request(sub, usr: usr));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);

        await using var db = _factory.NewContext();
        var order = await db.Orders.AsNoTracking().IgnoreQueryFilters()
            .FirstAsync(o => o.Id == victim);
        Assert.Null(order.DeletedAt);
    }

    // The 400 must be reached only AFTER the key check, so an unauthenticated caller
    // still cannot tell a valid subject from an invalid one — and, more to the point
    // for observability, never emits a *_started line for a flow that never started.
    [Fact]
    public async Task Prefers_401_over_400_when_the_api_key_is_wrong_too()
    {
        var response = await _factory.CreateClient()
            .SendAsync(Request(sub: null, apiKey: "wrong"));

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    // The success response still reports all three counts. Guards the wiring change
    // that moved the whole handler inside the workflow span: the traced overload
    // returns IResult, and a mistake there surfaces as a shape change here.
    [Fact]
    public async Task Reports_every_cascaded_count_on_success()
    {
        const string sub = "sub-cascade-counts";
        await SeedOrderAsync(sub);

        var response = await _factory.CreateClient().SendAsync(Request(sub));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var body = await response.Content.ReadFromJsonAsync<InternalDeleteResponse>();
        Assert.Equal(1, body!.Deleted);
        Assert.Equal(0, body.DeletedDetails);
        Assert.Equal(0, body.DeletedCarts);
    }

    // THE CASE THIS CHANGE EXISTS FOR. `cognito_sub` is not durable: a user who deletes
    // their account and registers again gets a NEW sub from Cognito, while their internal
    // `usr_` id never changes. So an erasure request can legitimately carry a sub that
    // matches nothing while its user id matches everything. Keying on `cognito_sub` alone
    // left those rows behind — silently, reporting a cheerful 200 and a count of zero.
    [Fact]
    public async Task Deletes_an_order_matched_only_by_user_id()
    {
        var userId = NanoId.NewId("usr_");
        // A DIFFERENT sub from the one the request will carry — the stale-sub shape.
        var orderId = await SeedOrderAsync("sub-stale-and-forgotten", userId);

        var response = await _factory.CreateClient()
            .SendAsync(Request("sub-freshly-minted", usr: userId));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var body = await response.Content.ReadFromJsonAsync<InternalDeleteResponse>();
        Assert.Equal(1, body!.Deleted);

        await using var db = _factory.NewContext();
        var order = await db.Orders.AsNoTracking().IgnoreQueryFilters()
            .FirstAsync(o => o.Id == orderId);
        Assert.NotNull(order.DeletedAt);
        Assert.Equal(AuditActor.DeleteByUser, order.DeletedBy);
    }

    // The order_details subquery must follow the parent selection, OR included. When it
    // did not, the parent order was soft-deleted and its lines stayed live — orphaned
    // children of a deleted parent, invisible to every read (the parent's query filter
    // hides the order) and therefore undetectable except by looking in the table.
    [Fact]
    public async Task Deletes_the_lines_of_an_order_matched_only_by_user_id()
    {
        var userId = NanoId.NewId("usr_");
        var orderId = await SeedOrderAsync("sub-stale-with-lines", userId);
        var detailId = await SeedDetailAsync(orderId, "sub-stale-with-lines", userId);

        var response = await _factory.CreateClient()
            .SendAsync(Request("sub-unrelated", usr: userId));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var body = await response.Content.ReadFromJsonAsync<InternalDeleteResponse>();
        Assert.Equal(1, body!.DeletedDetails);

        await using var db = _factory.NewContext();
        var detail = await db.OrderDetails.AsNoTracking().IgnoreQueryFilters()
            .FirstAsync(d => d.Id == detailId);
        Assert.NotNull(detail.DeletedAt);
        Assert.Equal(AuditActor.DeleteByUser, detail.DeletedBy);
    }

    // The OR widens the match; it must not widen it to a DIFFERENT user. Neither of this
    // row's two identities appears in the request, so neither side of the OR may reach it.
    [Fact]
    public async Task Does_not_touch_a_user_who_matches_on_neither_identity()
    {
        var theirs = await SeedOrderAsync("sub-bystander", NanoId.NewId("usr_"));

        var response = await _factory.CreateClient()
            .SendAsync(Request("sub-cascade-or", usr: NanoId.NewId("usr_")));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        await using var db = _factory.NewContext();
        Assert.Null((await db.Orders.AsNoTracking().IgnoreQueryFilters()
            .FirstAsync(o => o.Id == theirs)).DeletedAt);
    }

    private async Task<string> SeedDetailAsync(string orderId, string sub, string userId)
    {
        await using var db = _factory.NewContext();
        var detailId = NanoId.NewId(NanoId.OrderDetailPrefix);
        db.OrderDetails.Add(new OrderDetail
        {
            Id = detailId,
            OrderId = orderId,
            ProductId = _factory.SeededProductId,
            UserId = userId,
            CognitoSub = sub,
            Quantity = 1,
            SubtotalCents = 0,
            TaxCents = 0,
            TotalCents = 0,
        });
        await db.SaveChangesAsync();
        return detailId;
    }

    private sealed record ErrorBody(string Error);
}
