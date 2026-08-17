using Microsoft.AspNetCore.Http;
using Orders.Api.Identity;
using Orders.Infrastructure.Id;
using Serilog.Core;
using Serilog.Events;

namespace Orders.Api.Logging;

// Attaches the shared cross-service log context to every event, mirroring the
// Users service's AsyncLocalStorage store (see
// services/users/src/shared/logging/log-context.ts). Reads the request-scoped
// ICurrentCaller through IHttpContextAccessor, so no call site has to thread
// identity into the logger.
//
// Reads the caller on EVERY event rather than caching it: ICurrentCaller
// resolves the internal usr_ id lazily, so user_id is absent early in a request
// and present later. An enricher that captured the caller once would freeze the
// empty early value onto the whole request.
//
// Fields are omitted when unknown — never emitted as null. An emitted
// user_id: null reads as a resolved value that happens to be null, rather than
// "not known at this point in the request".
public sealed class LogContextEnricher(IHttpContextAccessor accessor) : ILogEventEnricher
{
    public void Enrich(LogEvent logEvent, ILogEventPropertyFactory factory)
    {
        // The REAL W3C trace id from the active span — the join key between a
        // log line and its trace. Deliberately NOT HttpContext.TraceIdentifier,
        // which is an ASP.NET-local counter ("0HNN…:00000001") that never leaves
        // this process and so cannot correlate anything across services.
        //
        // Read before the HttpContext guard: background and startup work also
        // runs under an Activity and deserves the same correlation.
        var activity = System.Diagnostics.Activity.Current;
        if (activity is not null)
        {
            logEvent.AddPropertyIfAbsent(
                factory.CreateProperty("trace_id", activity.TraceId.ToString()));
            logEvent.AddPropertyIfAbsent(
                factory.CreateProperty("span_id", activity.SpanId.ToString()));
        }

        // The cross-service correlation id, seeded at ingress by CallerContextMiddleware.
        // Read fresh on every event for the same reason the caller is (see above) and
        // omitted when absent — a startup or background line genuinely belongs to no
        // request, and request_id: null would claim otherwise.
        //
        // Read BEFORE the HttpContext guard: the id lives in an AsyncLocal, not on the
        // HttpContext, so work that flows out of a request still carries it even where
        // IHttpContextAccessor no longer resolves.
        //
        // Deliberately NOT the same thing as trace_id above. trace_id is the OTel SDK's
        // id and only reaches as far as the SDK does; this one is a plain value that costs
        // one header, and it is what correlates hops the SDK never touches (the
        // events-pipeline Lambda has no OTel SDK at all).
        if (AmbientRequestId.Current is { Length: > 0 } requestId)
        {
            logEvent.AddPropertyIfAbsent(factory.CreateProperty("request_id", requestId));
        }

        var http = accessor.HttpContext;
        if (http is null) return; // startup / background logs have no request

        var caller = http.RequestServices?.GetService<ICurrentCaller>();
        if (caller is null) return;

        if (caller.CognitoSub is { Length: > 0 } sub)
        {
            logEvent.AddPropertyIfAbsent(factory.CreateProperty("cognito_sub", sub));
        }

        // Only present once the write path has actually resolved it. Reading
        // this never triggers the gRPC call (see ICurrentCaller).
        if (caller.ResolvedInternalUserId is { Length: > 0 } userId)
        {
            logEvent.AddPropertyIfAbsent(factory.CreateProperty("user_id", userId));
        }
    }
}
