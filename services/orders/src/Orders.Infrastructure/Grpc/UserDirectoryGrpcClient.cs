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
        => (await LookupAsync(cognitoSub, ct))?.Id;

    public async Task<CallerProfile?> ResolveCallerAsync(string cognitoSub, CancellationToken ct = default)
    {
        var response = await LookupAsync(cognitoSub, ct);
        // Email and FullName come off the SAME GetUserById response that resolves the id —
        // see users.v1.UserResponse.email / .full_name. ORDER_CREATED needs both (who the
        // confirmation email is sent to, and who it greets), so mapping them here costs
        // nothing: no extra round trip, no new dependency. PII, like Address: never log
        // either in plaintext.
        //
        // FullName is passed through as-is, including "" — proto3 has no null, so a user
        // with no name on file arrives empty, and CallerProfile documents "" as the
        // "unnamed" value rather than collapsing it to null.
        return response is null
            ? null
            : new CallerProfile(response.Id, response.Email, response.FullName, ToAddress(response.Address));
    }

    private async Task<UserResponse?> LookupAsync(string cognitoSub, CancellationToken ct)
    {
        var metadata = new Metadata { { "x-api-key", _apiKey } };
        try
        {
            return await _client.GetUserByIdAsync(
                new GetUserByIdRequest { Id = cognitoSub },
                headers: metadata,
                cancellationToken: ct);
        }
        catch (RpcException ex) when (ex.StatusCode == StatusCode.NotFound)
        {
            return null;
        }
    }

    // proto3 has no null: a key absent from the address Users stores arrives as "".
    // Normalizing here keeps that wire detail out of the domain, so an absent line2
    // stays absent rather than being persisted as an empty string later readers
    // cannot tell from a real blank. An address that is empty in every field means
    // the user has none on file, and collapses to null rather than being stored as
    // an object that reads as "we have an address" while meaning the opposite.
    private static CallerAddress? ToAddress(Address? address)
    {
        if (address is null) return null;

        var mapped = new CallerAddress(
            NullIfBlank(address.Line1),
            NullIfBlank(address.Line2),
            NullIfBlank(address.City),
            NullIfBlank(address.State),
            NullIfBlank(address.Country),
            NullIfBlank(address.PostalCode));

        return mapped.IsEmpty ? null : mapped;
    }

    private static string? NullIfBlank(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value;
}
