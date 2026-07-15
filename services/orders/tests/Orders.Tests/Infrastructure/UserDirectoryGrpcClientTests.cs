using Grpc.Core;
using Grpc.Net.Client;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Orders.Infrastructure.Grpc;
using Users.V1;

namespace Orders.Tests.Infrastructure;

// Exercises the gRPC client against a real in-process ASP.NET Core gRPC server
// stub (Kestrel HTTP/2). Asserts the x-api-key metadata reaches the server and
// the internal id resolves. The generated namespace is Users.V1 (package
// users.v1). Grpc.Core.Server (the legacy native server) has no .NET 10 native
// runtime, so we host the stub with Grpc.AspNetCore instead.
public class UserDirectoryGrpcClientTests
{
    private static WebApplication BuildServer(StubUsers impl, out string address)
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.ConfigureKestrel(o =>
            o.Listen(System.Net.IPAddress.Loopback, 0, l => l.Protocols = HttpProtocols.Http2));
        builder.Services.AddGrpc();
        builder.Services.AddSingleton(impl);

        var app = builder.Build();
        app.MapGrpcService<StubUsers>();
        app.Start();

        address = app.Urls.First();
        return app;
    }

    [Fact]
    public async Task Resolves_internal_id_and_sends_api_key()
    {
        var impl = new StubUsers();
        await using var server = BuildServer(impl, out var address);

        using var channel = GrpcChannel.ForAddress(address);
        var client = new UserDirectoryGrpcClient(new Users.V1.Users.UsersClient(channel), "test-key");

        var id = await client.ResolveInternalUserIdAsync("sub-123");

        Assert.Equal("usr_resolved", id);
        Assert.Equal("test-key", impl.SeenApiKey);
        Assert.Equal("sub-123", impl.SeenId);
    }

    [Fact]
    public async Task Returns_null_when_user_not_found()
    {
        var impl = new StubUsers { NotFound = true };
        await using var server = BuildServer(impl, out var address);

        using var channel = GrpcChannel.ForAddress(address);
        var client = new UserDirectoryGrpcClient(new Users.V1.Users.UsersClient(channel), "test-key");

        var id = await client.ResolveInternalUserIdAsync("sub-unknown");

        Assert.Null(id);
    }

    // Concrete stub resolved from DI by MapGrpcService. Records the api key it
    // observed and can simulate the NOT_FOUND path.
    private sealed class StubUsers : Users.V1.Users.UsersBase
    {
        public string? SeenApiKey { get; private set; }
        public string? SeenId { get; private set; }
        public bool NotFound { get; init; }

        public override Task<UserResponse> GetUserById(GetUserByIdRequest request, ServerCallContext context)
        {
            SeenApiKey = context.RequestHeaders.GetValue("x-api-key");
            SeenId = request.Id;
            if (NotFound)
                throw new RpcException(new Status(StatusCode.NotFound, "user not found"));
            return Task.FromResult(new UserResponse { Id = "usr_resolved", CognitoSub = request.Id });
        }
    }
}
