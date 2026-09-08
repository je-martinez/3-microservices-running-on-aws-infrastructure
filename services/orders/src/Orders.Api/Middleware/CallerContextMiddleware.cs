using Microsoft.AspNetCore.Routing;
using Orders.Api.Identity;
using Orders.Infrastructure.Id;

namespace Orders.Api.Middleware;

// Populates the scoped ICurrentCaller from x-user-id and 401s any route off the public
// allowlist when the header is missing.
// CONTRACT: Must run AFTER routing. ctx.GetEndpoint() is only populated post-UseRouting, so
// earlier RoutePattern.RawText is null and the health allowlist silently cannot match.
public sealed class CallerContextMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext ctx, ICurrentCaller caller)
    {
        // CONTRACT: Set the correlation id FIRST and unconditionally, before the auth guard
        // can short-circuit — otherwise a 401, the very request someone asks about later,
        // is the one log line with no request_id. See [[logging-context]]
        AmbientRequestId.Set(RequestId.Resolve(ctx.Request.Headers[RequestId.HeaderName].FirstOrDefault()));

        var sub = ctx.Request.Headers["x-user-id"].FirstOrDefault();
        var routePath = (ctx.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText;

        if (sub is null && !PublicRoutes.IsPublic(ctx.Request.Method, routePath))
        {
            ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }

        if (sub is not null)
        {
            caller.SetSub(sub);
            await StampInternalUserIdAsync(caller, ctx.RequestAborted);
        }

        await next(ctx);
    }

    // CONTRACT: Resolve the internal usr_ id ONCE here, so every log line carries user_id
    // and can be joined to Users and Tracking. Do NOT move this into the enricher's getter —
    // that getter is read on every log event, so it would turn each line into a gRPC call.
    // See [[logging-context]]
    private static async Task StampInternalUserIdAsync(ICurrentCaller caller, CancellationToken ct)
    {
        try
        {
            await caller.ResolveInternalUserIdAsync(ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // WHY: The client went away; let the pipeline unwind.
            throw;
        }
        catch (Exception)
        {
            // CONTRACT: Any other failure leaves the request untouched and simply without
            // user_id — enriching a log line must never fail a request that would succeed.
            // Not logged: an outage would emit one line per request and bury the signal.
            // See [[logging-context]]
        }
    }
}
