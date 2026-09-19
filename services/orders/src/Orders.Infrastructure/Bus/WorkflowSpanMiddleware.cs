using System.Diagnostics;
using Orders.Application.Messaging;
using Orders.Infrastructure.Observability;

namespace Orders.Infrastructure.Bus;

/// <summary>
/// Pipeline step 1 of 4 — opens the workflow span, and closes it with the status the outcome
/// earned. One registration covers every flow on the bus.
/// </summary>
/// <remarks>
/// CONTRACT: Registered OUTERMOST, so <c>Activity.Current</c> is this span for the whole
/// pipeline and every log line written inside it carries that span's <c>span_id</c>.
/// CONTRACT: Read the outcome from <see cref="FlowScope"/>, never from a <c>Finally</c>
/// parameter typed as a result interface. Wolverine binds the handler's return variable only by
/// its CONCRETE type, so such a step is silently DROPPED — the pipeline runs one behavior short
/// with no error and every span reports the same status. See [[logging-context]]
/// </remarks>
public static class WorkflowSpanMiddleware
{
    private static readonly ActivitySource Source = new(WorkflowTracer.ActivitySourceName);

    public static FlowScope Before(IFlowMessage message) =>
        new(message, Source.StartActivity(message.Flow, ActivityKind.Internal));

    /// <summary>
    /// Ends the span. A ROUTINE failure carries its <c>reason</c> and stays OK; only an
    /// unwound pipeline is ERROR.
    /// </summary>
    /// <remarks>
    /// CONTRACT: Keep the routine branch OK. Marking a returned "not found" as ERROR makes
    /// every 404 an errored span, and on a service whose commonest answer is "no such order"
    /// that buries the real faults. See [[logging-context]]
    /// CONTRACT: Dispose ends the span. An activity left running is never exported, with no
    /// error to show for it.
    /// </remarks>
    public static void Finally(FlowScope scope)
    {
        var activity = scope.Activity;
        if (activity is null)
        {
            return;
        }

        if (scope.CountTag is { } count)
        {
            activity.SetTag(count.Field, count.Value);
        }

        if (scope.Reason is not null)
        {
            activity.SetTag("reason", scope.Reason);
        }

        activity.SetStatus(
            scope.Completed ? ActivityStatusCode.Ok : ActivityStatusCode.Error);

        activity.Dispose();
    }
}
