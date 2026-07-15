namespace Orders.Application.Identity;

// Resolves the caller's Cognito sub to the internal usr_ id via Users. Returns
// null when the user does not exist. Application depends on this port, not gRPC.
public interface IUserDirectory
{
    Task<string?> ResolveInternalUserIdAsync(string cognitoSub, CancellationToken ct = default);
}
