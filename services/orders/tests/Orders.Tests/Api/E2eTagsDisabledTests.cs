using System.Net;
using System.Net.Http.Json;
using Microsoft.EntityFrameworkCore;
using Orders.Application.Orders;
using Orders.Domain.Entities;

namespace Orders.Tests.Api;

// The security half of E2E tagging, on a host built WITHOUT E2E_TESTING_ENABLED — what a
// production runtime is.
// CONTRACT: x-e2e-source is client-supplied, so it takes effect ONLY when the service also
// opts in. Without that double condition an external caller tags its own orders and hands
// itself rows a cleanup then deletes.
// CONTRACT: Its own host and container — the shared fixture's 5 units of stock are consumed
// exactly by its own tests, so an extra order there 409s an unrelated test.
// See [[testing]]
public class E2eTagsDisabledTests : IClassFixture<OrdersDisabledE2eApiFactory>
{
    private readonly OrdersDisabledE2eApiFactory _factory;
    public E2eTagsDisabledTests(OrdersDisabledE2eApiFactory factory) => _factory = factory;

    [Fact]
    public async Task Header_does_not_tag_when_e2e_testing_is_disabled()
    {
        var client = _factory.CreateClient();
        var request = new HttpRequestMessage(HttpMethod.Post, "/v1/orders")
        {
            Content = JsonContent.Create(new
            {
                lines = new[] { new { productId = _factory.SeededProductId, quantity = 1 } },
            }),
        };
        request.Headers.Add("x-user-id", OrdersDisabledE2eApiFactory.KnownCognitoSub);
        request.Headers.Add("x-e2e-source", "true");

        var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<OrderDto>();

        await using var db = _factory.NewContext();
        var order = await db.Orders.AsNoTracking().IgnoreQueryFilters().FirstAsync(o => o.Id == body!.Id);

        // The header was sent and honoured by nothing: the order is a normal order.
        Assert.Empty(order.Tags);
    }

    [Fact]
    public async Task Cleanup_route_is_unreachable_when_e2e_testing_is_disabled()
    {
        var response = await _factory.CreateClient().DeleteAsync("/v1/orders/e2e-cleanup");

        // Program never maps the route without the flag, so nothing can invoke the
        // handler. The status is 401 rather than 404 because CallerContextMiddleware
        // runs before the (empty) endpoint resolution and rejects the header-less
        // request first — PublicRoutes.IsPublic matches on the resolved route pattern,
        // which is null here. Either way the handler is unreachable, which is what
        // listing the path in PublicRoutes must not change.
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Cleanup_route_is_unreachable_even_with_an_identity()
    {
        var client = _factory.CreateClient();
        var request = new HttpRequestMessage(HttpMethod.Delete, "/v1/orders/e2e-cleanup");
        request.Headers.Add("x-user-id", OrdersDisabledE2eApiFactory.KnownCognitoSub);

        var response = await client.SendAsync(request);

        // 405, not 404: the PATH exists (GET /v1/orders/{orderId} matches it), but no
        // DELETE handler is registered for it — which is exactly the proof wanted here.
        // The route is absent from the application, not merely guarded, so nothing about
        // listing it in PublicRoutes can expose it. It must never be 200/204.
        Assert.Equal(HttpStatusCode.MethodNotAllowed, response.StatusCode);
    }
}
