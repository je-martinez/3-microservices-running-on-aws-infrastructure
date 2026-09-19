using Wolverine;

namespace Orders.Infrastructure.Bus;

/// <summary>
/// Pipeline step 4 of 4 — the last step before the handler. Stops a flow that names no
/// workflow, which would otherwise reach a handler and log under an empty <c>app_event</c>.
/// </summary>
/// <remarks>
/// CONTRACT: Innermost of the four, so a stop still closes the span and writes the flow's
/// <c>_failed</c> line — the three steps around it have already run their <c>Before</c>, and
/// their <c>Finally</c> blocks run on the way out regardless. Validation registered OUTSIDE the
/// tracing step would reject silently, with no span and no log. See [[logging-context]]
/// CONTRACT: Bind <see cref="FlowScope"/>, not <c>IFlowMessage</c> — this step is registered
/// globally, and a global registration cannot resolve the message interface.
/// </remarks>
public static class FlowValidationMiddleware
{
    public static HandlerContinuation Validate(FlowScope scope)
    {
        if (!string.IsNullOrWhiteSpace(scope.Flow))
        {
            return HandlerContinuation.Continue;
        }

        scope.RoutineFailure("invalid_flow");
        return HandlerContinuation.Stop;
    }
}
