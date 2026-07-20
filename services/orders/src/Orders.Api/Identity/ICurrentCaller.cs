namespace Orders.Api.Identity;

// Request-scoped caller context. CognitoSub is the raw x-user-id (set by the
// middleware). ResolveInternalUserIdAsync lazily resolves the internal usr_ id
// via gRPC (write path only) and caches it for the request.
public interface ICurrentCaller
{
    string? CognitoSub { get; }

    // The internal usr_ id IF it has already been resolved this request, else
    // null. Deliberately does NOT trigger resolution: the log enricher reads it
    // on every event, and a property getter that fired a gRPC call would turn
    // logging into a network dependency. Resolution stays explicit, via
    // ResolveInternalUserIdAsync on the write path.
    string? ResolvedInternalUserId { get; }

    void SetSub(string sub);
    Task<string> ResolveInternalUserIdAsync(CancellationToken ct);
}
