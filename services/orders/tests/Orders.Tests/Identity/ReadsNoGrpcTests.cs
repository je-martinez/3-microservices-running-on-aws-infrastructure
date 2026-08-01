using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Moq;
using Orders.Application.Identity;
using Orders.Tests.Api;

namespace Orders.Tests.Identity;

// Reads (my-orders, by-id) filter by cognito_sub only and must NEVER call the
// gRPC IUserDirectory — only the write path (create order) resolves the
// internal usr_ id. This test replaces the factory's stub IUserDirectory with a
// Mock so the "never called" claim is verifiable rather than assumed.
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
            .ReturnsAsync(new CallerProfile(OrdersApiFactory.KnownUserId, null));

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
        // VerifyNoOtherCalls rather than naming one method: the claim is that reads
        // never touch the directory at all, so it must hold for every method on the
        // port — including any added later. Naming one would let a new resolution
        // path slip in silently, which is how adding ResolveCallerAsync went
        // unnoticed here until the write path started using it.
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
