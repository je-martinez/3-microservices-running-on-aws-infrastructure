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

    private HttpRequestMessage Request(string sub, string? apiKey = "test-key")
    {
        var request = new HttpRequestMessage(HttpMethod.Delete, Path)
        {
            Content = JsonContent.Create(new { cognitoSub = sub }),
        };
        if (apiKey is not null) request.Headers.Add("x-api-key", apiKey);
        return request;
    }

    private async Task<string> SeedOrderAsync(string sub)
    {
        await using var db = _factory.NewContext();
        var orderId = NanoId.NewId(NanoId.OrderPrefix);
        db.Orders.Add(new Order
        {
            Id = orderId,
            UserId = "usr_x",
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
}
