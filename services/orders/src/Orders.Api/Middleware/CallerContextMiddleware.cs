using Microsoft.AspNetCore.Routing;
using Orders.Api.Identity;

namespace Orders.Api.Middleware;

// Populates the scoped ICurrentCaller from x-user-id and 401s any route not on
// the public allowlist when the header is missing. Must run AFTER routing has
// resolved the endpoint (ctx.GetEndpoint() is only populated post-UseRouting),
// otherwise RoutePattern.RawText is null and the health allowlist can't match.
// Program.cs places this after app.UseSerilogRequestLogging and MapOrderEndpoints
// registers the routes ahead of Run(), so by the time this middleware executes
// for a real request, endpoint resolution has already happened.
public sealed class CallerContextMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext ctx, ICurrentCaller caller)
    {
        var sub = ctx.Request.Headers["x-user-id"].FirstOrDefault();
        var routePath = (ctx.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText;

        if (sub is null && !PublicRoutes.IsPublic(ctx.Request.Method, routePath))
        {
            ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }

        if (sub is not null) caller.SetSub(sub);
        await next(ctx);
    }
}
