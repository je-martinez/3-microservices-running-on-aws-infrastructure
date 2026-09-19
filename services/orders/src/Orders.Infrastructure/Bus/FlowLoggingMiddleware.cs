using Microsoft.Extensions.Logging;

namespace Orders.Infrastructure.Bus;

/// <summary>
/// Pipeline step 3 of 4 — the flow's structured log lines, in the shared snake_case schema.
/// </summary>
/// <remarks>
/// CONTRACT: There is no SUCCESS severity. Success is <c>INFO</c> + <c>app_event=*_succeeded</c>
/// — SUCCESS is not an OTel level. See [[logging-context]]
/// CONTRACT: Pass only the count and the reason. <c>cognito_sub</c>/<c>user_id</c> already ride
/// on every line via <c>LogContextEnricher</c>; duplicating them here is how a PII-adjacent
/// field ends up somewhere nobody audits.
/// </remarks>
public static class FlowLoggingMiddleware
{
    public static void Before(FlowScope scope, ILogger logger)
    {
        if (scope.EmitsStarted)
        {
            logger.LogInformation("Flow started {app_event}", scope.StartedAppEvent);
        }
    }

    /// <summary>
    /// The terminal line. <c>reason</c> appears only on a failure — a succeeding flow writes a
    /// template WITHOUT the placeholder, so the key is absent rather than null.
    /// </summary>
    /// <remarks>
    /// CONTRACT: Keep the two templates separate. One template with a nullable argument emits
    /// <c>"reason": null</c> on every success, which the contract forbids.
    /// See [[logging-context]]
    /// WHY: Emitted INSIDE the workflow activity, so it carries that span's <c>span_id</c> —
    /// the outer <c>request completed</c> line runs under the AspNetCore span and cannot serve
    /// a span-scoped log lookup.
    /// </remarks>
    public static void Finally(FlowScope scope, ILogger logger)
    {
        if (scope.Reason is null && scope.Completed)
        {
            if (scope.CountTag is { } count)
            {
                logger.LogInformation(
                    "Flow succeeded {app_event} {" + count.Field + "}",
                    scope.TerminalAppEvent, count.Value);
                return;
            }

            logger.LogInformation("Flow succeeded {app_event}", scope.TerminalAppEvent);
            return;
        }

        logger.LogWarning(
            "Flow failed {app_event} {reason}",
            scope.TerminalAppEvent, scope.Reason ?? "unhandled_error");
    }
}
