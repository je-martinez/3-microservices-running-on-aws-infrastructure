namespace Orders.Api.Identity;

// Routes that don't require x-user-id. The auth middleware lets these through.
public static class PublicRoutes
{
    /// <summary>
    /// The liveness probe's route. Only its 2xx responses are exempt from the
    /// request log — see UseSerilogRequestLogging in Program.cs and the
    /// health-check-logging convention.
    /// </summary>
    /// <remarks>
    /// Deliberately a separate constant rather than reusing <see cref="IsPublic"/>:
    /// that predicate also matches the E2E cleanup route, and exempting THAT from
    /// the request log would hide a destructive operation.
    /// </remarks>
    public const string HealthRoute = "/v1/health";

    public static bool IsPublic(string method, string? routePath) =>
        (string.Equals(method, "GET", StringComparison.OrdinalIgnoreCase)
            && routePath == "/v1/health")
        // E2E cleanup deletes by tag, not by caller, and the global test teardown runs
        // with no identity — requiring x-user-id would 401 it. Listing it here does NOT
        // widen the surface: the route is only MAPPED under E2E_TESTING_ENABLED, so with
        // the flag off it never resolves to an endpoint and this arm cannot match (a
        // request to that path 404s before the middleware has a route to allow).
        || (string.Equals(method, "DELETE", StringComparison.OrdinalIgnoreCase)
            && routePath == "/v1/orders/e2e-cleanup")
        // The internal account-deletion cascade. "Public" here means only "exempt
        // from the x-user-id guard" — the route is NOT on the API Gateway and is
        // not reachable from outside the network, and its handler requires the
        // shared internal key before it touches anything. It carries no end-user
        // identity by design: the subject arrives in the body, because the caller
        // is Users acting on a user's behalf, not the user themselves.
        || (string.Equals(method, "DELETE", StringComparison.OrdinalIgnoreCase)
            && routePath == "/v1/orders/by-user");
}
