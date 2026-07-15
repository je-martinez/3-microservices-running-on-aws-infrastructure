using Grpc.Core;
using Orders.Application.Identity;
using Users.V1;

namespace Orders.Infrastructure.Grpc;

// Adapts the generated Users gRPC client to the Application port. Attaches the
// shared x-api-key on every call. NOT_FOUND → null (user does not exist).
public class UserDirectoryGrpcClient : IUserDirectory
{
    private readonly Users.V1.Users.UsersClient _client;
    private readonly string _apiKey;

    public UserDirectoryGrpcClient(Users.V1.Users.UsersClient client, string apiKey)
    {
        _client = client;
        _apiKey = apiKey;
    }

    public async Task<string?> ResolveInternalUserIdAsync(string cognitoSub, CancellationToken ct = default)
    {
        var metadata = new Metadata { { "x-api-key", _apiKey } };
        try
        {
            var response = await _client.GetUserByIdAsync(
                new GetUserByIdRequest { Id = cognitoSub },
                headers: metadata,
                cancellationToken: ct);
            return response.Id;
        }
        catch (RpcException ex) when (ex.StatusCode == StatusCode.NotFound)
        {
            return null;
        }
    }
}
