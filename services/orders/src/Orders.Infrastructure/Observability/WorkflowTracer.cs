using System.Diagnostics;

namespace Orders.Infrastructure.Observability;

/// <inheritdoc />
public class WorkflowTracer : IWorkflowTracer
{
    // A distinct name from AspNetCore/HttpClient/EFCore's own ActivitySources
    // (Program.cs registers those separately) — this is the ONE source for
    // manually-created workflow spans, and Program.cs's AddSource(...) call must
    // name this exact string or the spans are created but never exported,
    // silently. Same failure class as an unregistered instrumentation: no error,
    // no span in Jaeger.
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
        // No explicit `finally { activity?.Stop(); }` needed: `using` on an
        // Activity calls Dispose(), which calls Stop() — the .NET equivalent of
        // the mandatory span.end() in a finally this design requires everywhere
        // else, and it covers the exception path above too. An activity left
        // running never reaches Jaeger, with no error to show for it.
        // Documented here so nobody "simplifies" this away.
    }

    public void SetAttribute(string key, object? value) =>
        Activity.Current?.SetTag(key, value);

    public void SetReason(string reason) =>
        Activity.Current?.SetTag("reason", reason);
}
