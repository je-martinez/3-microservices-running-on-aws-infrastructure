namespace Orders.Api.Identity;

// Request-scoped caller context. CognitoSub is the raw x-user-id (set by the
// middleware). ResolveInternalUserIdAsync lazily resolves the internal usr_ id
// via gRPC (write path only) and caches it for the request.
public interface ICurrentCaller
{
    string? CognitoSub { get; }
    void SetSub(string sub);
    Task<string> ResolveInternalUserIdAsync(CancellationToken ct);
}
