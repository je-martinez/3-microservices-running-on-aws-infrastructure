using System.Diagnostics;

namespace Orders.Infrastructure.Observability;

/// <inheritdoc />
public class WorkflowTracer : IWorkflowTracer
{
    // CONTRACT: Program.cs's AddSource(...) must name this EXACT string. Otherwise the
    // spans are created, cost work, and are silently never exported — no error, no span.
    // See [[ADR-0019-distributed-tracing-opentelemetry]]
    public const string ActivitySourceName = "orders-workflow";

    private static readonly ActivitySource Source = new(ActivitySourceName);

    public async Task<T> TraceWorkflowAsync<T>(
        string name,
        IDictionary<string, object?> attributes,
        Func<Task<T>> action)
    {
        // Null when nothing listens to this source (no exporter registered, a
        // plain unit test). Every use below is null-conditional on purpose: the
        // workflow must run identically either way — tracing is never a
        // precondition for creating an order.
        using var activity = Source.StartActivity(name, ActivityKind.Internal);
        if (activity is not null)
        {
            foreach (var (key, value) in attributes)
            {
                activity.SetTag(key, value);
            }
        }

        try
        {
            var result = await action();
            activity?.SetStatus(ActivityStatusCode.Ok);
            return result;
        }
        catch (Exception ex)
        {
            activity?.AddException(ex);
            activity?.SetStatus(ActivityStatusCode.Error, ex.Message);
            throw;
        }
        // CONTRACT: Keep the `using` — Dispose() calls Stop(), covering the exception path
        // above. An activity left running is never exported, with no error to show for it.
    }

    public void SetAttribute(string key, object? value) =>
        Activity.Current?.SetTag(key, value);

    public void SetReason(string reason) =>
        Activity.Current?.SetTag("reason", reason);
}
