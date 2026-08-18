namespace Orders.Infrastructure.Observability;

/// <summary>
/// One manual span per business workflow — the single Orders flow in
/// docs/superpowers/specs/2026-08-18-distributed-tracing-spans-design.md
/// Decision 3 (create_order). Mirrors the SAME status/finally shape Users'
/// withWorkflowSpan and withGrpcServerSpan already use: OK on success, ERROR
/// with the failure's reason otherwise, and the span always ends.
///
/// The span carries the SAME attributes as the flow's own log line
/// (app_event, reason on failure, order_id, …) so the trace and the logs tell
/// the same story and neither needs the other to be understood.
/// </summary>
public interface IWorkflowTracer
{
    /// <summary>
    /// Run <paramref name="action"/> inside an INTERNAL span named
    /// <paramref name="name"/> (the flow name, e.g. <c>create_order</c>).
    /// </summary>
    Task<T> TraceWorkflowAsync<T>(
        string name,
        IDictionary<string, object?> attributes,
        Func<Task<T>> action);

    /// <summary>Attach an attribute to the CURRENT workflow span from inside the action.</summary>
    void SetAttribute(string key, object? value);

    /// <summary>Convenience for the one attribute every failure branch sets: "reason".</summary>
    void SetReason(string reason);
}
