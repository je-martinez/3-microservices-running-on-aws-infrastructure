namespace Orders.Infrastructure.Bus;

/// <summary>
/// Pipeline step 2 of 4 — stamps <c>app_event</c> on the workflow span: the started stem on
/// entry, the terminal one on exit.
/// </summary>
/// <remarks>
/// CONTRACT: The span carries the SAME <c>app_event</c> as the flow's log line, so the trace
/// and the logs tell one story and neither needs the other. See [[logging-context]]
/// </remarks>
public static class AppEventMiddleware
{
    public static void Before(FlowScope scope)
    {
        if (scope.EmitsStarted)
        {
            scope.Activity?.SetTag("app_event", scope.StartedAppEvent);
        }
    }

    /// <summary>
    /// Overwrites the started stem with the terminal one.
    /// CONTRACT: Set the terminal event LAST — <c>SetTag</c> is last-write-wins per key, so a
    /// step that wrote <c>app_event</c> after this one would leave every finished flow
    /// reporting <c>_started</c>. See [[logging-context]]
    /// </summary>
    public static void Finally(FlowScope scope) =>
        scope.Activity?.SetTag("app_event", scope.TerminalAppEvent);
}
