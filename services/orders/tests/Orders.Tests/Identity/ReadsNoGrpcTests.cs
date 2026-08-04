using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Moq;
using Orders.Application.Identity;
using Orders.Tests.Api;

namespace Orders.Tests.Identity;

// Reads (my-orders, by-id) filter by cognito_sub and need no internal usr_ id to
// do their work — but they now resolve one anyway, ONCE per request in
// CallerContextMiddleware, so every log line of the request carries user_id.
//
// That reverses what this file used to assert. Reads previously made no gRPC call
// at all, which was deliberate; the reversal is equally deliberate, because log
// lines carrying only a sub cannot be joined to Users or Tracking, both of which
// key by user_id. The trade — one Users call per read — was accepted explicitly.
//
// The class name is kept: git history is easier to follow when the file that
// asserted "no gRPC on reads" is the same file that now asserts what replaced it.
// These tests replace the factory's stub IUserDirectory with a Mock so the call
// count is verifiable rather than assumed.
[Collection(Orders.Tests.Api.OrdersApiCollection.Name)]
public class ReadsNoGrpcTests
{
    private readonly OrdersApiFactory _factory;
    public ReadsNoGrpcTests(OrdersApiFactory factory) => _factory = factory;

    private (HttpClient client, Mock<IUserDirectory> mock) CreateClientWithMockedDirectory()
    {
        var mock = new Mock<IUserDirectory>();
        mock.Setup(d => d.ResolveInternalUserIdAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(OrdersApiFactory.KnownUserId);
        // Order creation resolves through ResolveCallerAsync — it needs the address
        // as well as the id, from one call. Left unconfigured this returns null,
        // which the service reads as an unknown user and answers 404.
        mock.Setup(d => d.ResolveCallerAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new CallerProfile(OrdersApiFactory.KnownUserId, OrdersApiFactory.KnownEmail, null));

        var host = _factory.WithWebHostBuilder(builder =>
        {
            builder.ConfigureTestServices(services =>
            {
                var directory = services.Single(d => d.ServiceType == typeof(IUserDirectory));
                services.Remove(directory);
                services.AddScoped(_ => mock.Object);
            });
        });

        return (host.CreateClient(), mock);
    }

    [Fact]
    public async Task My_orders_never_calls_the_directory()
    {
        var (client, mock) = CreateClientWithMockedDirectory();
        var req = new HttpRequestMessage(HttpMethod.Get, "/v1/orders/my-orders");
        req.Headers.Add("x-user-id", OrdersApiFactory.KnownCognitoSub);

        var resp = await client.SendAsync(req);

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        // Resolved EXACTLY once, by the middleware, for log enrichment.
        //
        // This assertion used to be VerifyNoOtherCalls: reads scope by cognito_sub
        // and genuinely need no usr_ id, so they made no gRPC call at all. That was
        // deliberate and is now deliberately reversed — read log lines carried only
        // a sub and could not be joined to Users or Tracking, which key by user_id.
        // The cost was accepted explicitly: one Users call per read.
        //
        // Times.Once is the part worth keeping strict. CurrentCaller memoizes the
        // resolution, so a second call would mean the cache broke — and since the
        // enricher reads the resolved id on EVERY log event, a cache regression
        // would turn one call per request into one per log line.
        mock.Verify(
            d => d.ResolveInternalUserIdAsync(
                OrdersApiFactory.KnownCognitoSub, It.IsAny<CancellationToken>()),
            Times.Once);
        mock.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task Get_by_id_never_calls_the_directory()
    {
        var (client, mock) = CreateClientWithMockedDirectory();
        var req = new HttpRequestMessage(HttpMethod.Get, "/v1/orders/ord_does_not_exist");
        req.Headers.Add("x-user-id", OrdersApiFactory.KnownCognitoSub);

        var resp = await client.SendAsync(req);

        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
        // Resolved once even though the order was not found: enrichment happens in
        // the middleware, before routing reaches a handler, so a 404 still gets a
        // log line carrying user_id. That is the point — a request that fails is
        // exactly when you want to know whose it was.
        mock.Verify(
            d => d.ResolveInternalUserIdAsync(
                OrdersApiFactory.KnownCognitoSub, It.IsAny<CancellationToken>()),
            Times.Once);
        mock.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task Create_order_calls_the_directory_once()
    {
        var (client, mock) = CreateClientWithMockedDirectory();
        var req = new HttpRequestMessage(HttpMethod.Post, "/v1/orders")
        {
            Content = JsonContent.Create(new { lines = new[] { new { productId = _factory.SeededProductId, quantity = 1 } } }),
        };
        req.Headers.Add("x-user-id", OrdersApiFactory.KnownCognitoSub);

        var resp = await client.SendAsync(req);

        Assert.Equal(HttpStatusCode.Created, resp.StatusCode);
        mock.Verify(
            d => d.ResolveCallerAsync(OrdersApiFactory.KnownCognitoSub, It.IsAny<CancellationToken>()),
            Times.Once);
    }
}
