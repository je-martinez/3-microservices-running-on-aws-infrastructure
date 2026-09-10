using Microsoft.AspNetCore.Http;
using Orders.Api.Identity;
using Orders.Infrastructure.Id;
using Serilog.Core;
using Serilog.Events;

namespace Orders.Api.Logging;

// Attaches the shared cross-service log context to every event, reading ICurrentCaller
// through IHttpContextAccessor so no call site threads identity into the logger.
// CONTRACT: Read the caller on EVERY event, never cache it — the internal usr_ id resolves
// lazily, so capturing once freezes the empty early value onto the whole request.
// CONTRACT: Omit unknown fields, never emit null — `user_id: null` reads as a resolved value
// rather than "not known yet". See [[logging-context]]
public sealed class LogContextEnricher(IHttpContextAccessor accessor) : ILogEventEnricher
{
    public void Enrich(LogEvent logEvent, ILogEventPropertyFactory factory)
    {
        // CONTRACT: The W3C trace id from the active span, NOT HttpContext.TraceIdentifier —
        // that is a process-local counter and correlates nothing across services. Read before
        // the HttpContext guard so background work is correlated too.
        var activity = System.Diagnostics.Activity.Current;
        if (activity is not null)
        {
            logEvent.AddPropertyIfAbsent(
                factory.CreateProperty("trace_id", activity.TraceId.ToString()));
            logEvent.AddPropertyIfAbsent(
                factory.CreateProperty("span_id", activity.SpanId.ToString()));
        }

        // CONTRACT: Read this BEFORE the HttpContext guard — the id lives in an AsyncLocal,
        // so work flowing out of a request still carries it where IHttpContextAccessor no
        // longer resolves. Not a duplicate of trace_id: that reaches only as far as the OTel
        // SDK does, while this correlates hops the SDK never touches (the events-pipeline
        // Lambda runs no SDK at all). See [[logging-context]]
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
