using Microsoft.AspNetCore.Routing;
using Orders.Api.Identity;
using Orders.Infrastructure.Id;

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
        // FIRST, and unconditionally — before the auth guard below, before anything can
        // short-circuit. An unauthenticated request is exactly the one someone comes
        // asking about later ("my call 401'd, what happened?"), so a 401 that carries no
        // request_id is the one log line where the field is most missed. The equivalent
        // ordering bug in the Users service was caught by a test for precisely this, and
        // Orders pins it the same way.
        //
        // The caller's id is honoured only if it is one of ours; anything else is
        // discarded in favour of a fresh one, silently, and never turned into a 400 —
        // see RequestId.Resolve for why both halves of that are deliberate.
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

    // Resolve the internal usr_ id ONCE, here, so every log line of the request
    // carries user_id — not only the ones emitted after some handler happened to
    // need it. The reads (my-orders, order-by-id) scope by cognito_sub and never
    // resolved it at all, so their lines carried only a sub and could not be joined
    // to Users or Tracking on the id those services key by.
    //
    // Deliberately NOT done by making the enricher's getter resolve: that getter is
    // read on EVERY log event, so a resolving getter would turn each line into a
    // gRPC call. Resolving once here is what keeps ResolvedInternalUserId a cheap,
    // non-triggering read (services/orders/CLAUDE.md §4).
    //
    // The cost is real and accepted: reads now make one Users call they previously
    // did not. CurrentCaller memoizes it, so a handler needing the id later in the
    // same request pays nothing more.
    private static async Task StampInternalUserIdAsync(ICurrentCaller caller, CancellationToken ct)
    {
        try
        {
            await caller.ResolveInternalUserIdAsync(ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // The client went away. Not a Tracking-of-ours problem, and rethrowing
            // would be pointless work on a dead request — let the pipeline unwind.
            throw;
        }
        catch (Exception)
        {
            // ANY other failure — Users down, an unknown sub, a deadline — leaves the
            // request untouched and simply without user_id. Enriching a log line must
            // never be able to fail a request that was going to succeed, and a read
            // scoped by cognito_sub is answerable with no id at all. The enricher
            // omits the field rather than emitting null, so an absent id reads as
            // "not known" instead of "resolved, and it was null".
            //
            // Not logged here: a genuine outage would emit one line per request and
            // bury the signal, and the failure is already visible as user_id being
            // absent on lines that normally carry it.
        }
    }
}
