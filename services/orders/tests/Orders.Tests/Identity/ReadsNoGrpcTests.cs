using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Moq;
using Orders.Application.Identity;
using Orders.Tests.Api;

namespace Orders.Tests.Identity;

// CONTRACT: Reads resolve user_id via gRPC, exactly once per request. Without it, log lines
// join only by cognito_sub, which Users and Tracking do not key on.
// WHY: The class name predates gRPC on reads. These tests swap the factory's stub
// IUserDirectory for a Mock so the call count is verified rather than assumed.
// See [[logging-context]]
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
            .ReturnsAsync(new CallerProfile(
                OrdersApiFactory.KnownUserId,
                OrdersApiFactory.KnownEmail,
                OrdersApiFactory.KnownFullName,
                // These tests are about the CALL COUNT, not the address: null exercises
                // the "no address on file" branch and keeps the stub minimal.
                null));

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
        // CONTRACT: Keep Times.Once strict. CurrentCaller memoizes the resolution, and the
        // enricher reads the id on EVERY log event, so a broken cache turns one call per
        // request into one per log line. See [[logging-context]]
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
