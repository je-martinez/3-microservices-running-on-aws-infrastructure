namespace Orders.Api.Identity;

public static class CallerIdentity
{
    // The gateway injects the Cognito sub as x-user-id. Missing → 401.
    public static string? CognitoSub(HttpContext ctx) =>
        ctx.Request.Headers["x-user-id"].FirstOrDefault();
}
