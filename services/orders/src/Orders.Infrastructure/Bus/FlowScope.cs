using System.Diagnostics;
using Orders.Application.Messaging;

namespace Orders.Infrastructure.Bus;

/// <summary>
/// One flow's state, threaded through the pipeline: opened by the tracing middleware's
/// <c>Before</c>, filled in by the middleware inside it, and read by their <c>Finally</c>
/// methods.
/// </summary>
/// <remarks>
/// WHY: Wolverine passes an object returned from a <c>Before</c> method into the handler and
/// into every later middleware method, so this needs no DI registration.
/// CONTRACT: Do NOT infer the outcome from <see cref="Reason"/> alone — a routine "not found"
/// and a throw both leave a flow that did not succeed, and only the throw is an ERROR span.
/// <see cref="Completed"/> is the discriminator. See [[logging-context]]
/// </remarks>
public sealed class FlowScope
{
    public FlowScope(IFlowMessage message, Activity? activity)
    {
        Flow = message.Flow;
        EmitsStarted = message.EmitsStarted;
        Activity = activity;
    }

    public string Flow { get; }

    public bool EmitsStarted { get; }

    /// <summary>
    /// The workflow span, or null when nothing listens to the source (a plain unit test, no
    /// exporter registered). Every use is null-conditional on purpose: the flow must run
    /// identically either way — tracing is never a precondition.
    /// </summary>
    public Activity? Activity { get; }

    /// <summary>True once the handler returned, on either the happy or the routine path.</summary>
    public bool Completed { get; private set; }

    /// <summary>The routine failure's reason, or null.</summary>
    public string? Reason { get; private set; }

    /// <summary>The count field this flow reports, or null when it names none.</summary>
    public (string Field, int Value)? CountTag { get; private set; }

    /// <summary>The happy path, with the one business count this flow reports.</summary>
    /// <remarks>
    /// CONTRACT: Every handler MUST report an outcome — one of <see cref="Succeeded"/>,
    /// <see cref="RoutineFailure"/>, <see cref="Failing"/>. A handler returning without one is
    /// indistinguishable from one that threw: its flow logs <c>_failed</c> /
    /// <c>unhandled_error</c> while the caller gets a 200. See [[logging-context]]
    /// </remarks>
    public void Succeeded(string? countField = null, int count = 0)
    {
        Completed = true;

        if (countField is not null)
        {
            CountTag = (countField, count);
        }
    }

    /// <summary>
    /// A ROUTINE failure: reached by returning normally, so the flow logs
    /// <c>&lt;flow&gt;_failed</c> + <c>reason</c> and the span stays OK.
    /// </summary>
    public void RoutineFailure(string reason)
    {
        Completed = true;
        Reason = reason;
    }

    /// <summary>
    /// Names the reason for a failure the handler is about to THROW, whose span IS an error.
    /// </summary>
    /// <remarks>
    /// CONTRACT: Call this before throwing a reasoned exception. Without it the pipeline has
    /// only the generic <c>unhandled_error</c> to log, and the handler's specific reason —
    /// <c>unknown_user</c>, <c>insufficient_stock</c> — is the thing an operator needs.
    /// See [[logging-context]]
    /// </remarks>
    public void Failing(string reason) => Reason = reason;

    /// <summary>The <c>app_event</c> for this flow's terminal line.</summary>
    public string TerminalAppEvent =>
        Completed && Reason is null ? $"{Flow}_succeeded" : $"{Flow}_failed";

    public string StartedAppEvent => $"{Flow}_started";
}
