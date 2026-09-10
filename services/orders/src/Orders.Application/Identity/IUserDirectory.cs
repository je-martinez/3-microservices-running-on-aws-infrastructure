namespace Orders.Application.Identity;

// Resolves the caller against Users. Application depends on this port, not gRPC.
// CONTRACT: Keep the two methods separate; do NOT widen the id-only one. Every authenticated
// write resolves an id and has no use for an address, so widening puts PII one dereference
// from a log line on the hottest identity path. Both hit the same RPC — only the projection
// differs, so order creation gets the address without a second round trip.
// See [[logging-context]]
public interface IUserDirectory
{
    /// <summary>
    /// Resolves the caller's Cognito sub to the internal <c>usr_</c> id. Returns null when
    /// the user does not exist.
    /// </summary>
    Task<string?> ResolveInternalUserIdAsync(string cognitoSub, CancellationToken ct = default);

    /// <summary>
    /// Resolves the caller's full profile — internal id plus delivery address — in one call.
    /// Null when the user does not exist.
    /// WARNING: PII. <see cref="CallerProfile.Address"/> must never be logged.
    /// </summary>
    Task<CallerProfile?> ResolveCallerAsync(string cognitoSub, CancellationToken ct = default);
}
