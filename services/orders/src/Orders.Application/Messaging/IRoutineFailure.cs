namespace Orders.Application.Messaging;

/// <summary>
/// A handler result that can carry a ROUTINE failure — a domain "not found" or rejection the
/// route turns into a 404/400, reached by returning normally rather than by throwing.
/// </summary>
/// <remarks>
/// CONTRACT: A routine failure logs <c>&lt;flow&gt;_failed</c> + <c>reason</c> and leaves the
/// span status OK. Only a THROWN exception sets the span to ERROR. Middleware that inferred
/// failure from catch/no-catch alone would flatten the two into one, making every 404 an
/// errored span and drowning real faults in a service whose commonest answer is "no such
/// order". See [[logging-context]]
/// </remarks>
public interface IRoutineFailure
{
    /// <summary>
    /// The failure's <c>reason</c>, or null when the flow succeeded.
    /// CONTRACT: Null means the key is OMITTED from the log line and the span, never emitted
    /// as <c>"reason": null</c>. See [[logging-context]]
    /// </summary>
    string? FailureReason { get; }
}
