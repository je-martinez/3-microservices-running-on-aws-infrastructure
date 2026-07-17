namespace Orders.Api.Identity;

// Routes that don't require x-user-id. The auth middleware lets these through.
public static class PublicRoutes
{
    public static bool IsPublic(string method, string? routePath) =>
        string.Equals(method, "GET", StringComparison.OrdinalIgnoreCase)
        && routePath == "/v1/health";
}
