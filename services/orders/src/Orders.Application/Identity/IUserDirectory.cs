namespace Orders.Application.Identity;

// Resolves the caller against Users. Application depends on this port, not gRPC.
//
// TWO methods on purpose, rather than one widened method returning everything.
// The two call sites want genuinely different things:
//
//   * ICurrentCaller (Api) resolves an id on EVERY authenticated write, and has no
//     use for an address. Widening the existing method would make every one of those
//     calls carry PII it never reads, and would put the address one dereference away
//     from a log line on the hottest identity path in the service.
//   * Order creation needs the address too, and must get it WITHOUT a second round
//     trip — the address rides on the same GetUserById response that already resolves
//     the id, so asking twice would be a pure waste of a network call.
//
// Both hit the same RPC; only the projection differs.
public interface IUserDirectory
{
    /// <summary>
    /// Resolves the caller's Cognito sub to the internal <c>usr_</c> id. Returns null when
    /// the user does not exist.
    /// </summary>
    Task<string?> ResolveInternalUserIdAsync(string cognitoSub, CancellationToken ct = default);

    /// <summary>
    /// Resolves the caller's full profile — internal id plus delivery address — in a single
    /// call. Returns null when the user does not exist, exactly like
    /// <see cref="ResolveInternalUserIdAsync"/>.
    /// </summary>
    /// <remarks>
    /// The returned <see cref="CallerProfile.Address"/> is PII and must never be logged.
    /// </remarks>
    Task<CallerProfile?> ResolveCallerAsync(string cognitoSub, CancellationToken ct = default);
}
