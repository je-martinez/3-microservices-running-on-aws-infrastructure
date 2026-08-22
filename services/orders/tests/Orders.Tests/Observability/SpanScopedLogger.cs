using System.Diagnostics;
using Microsoft.Extensions.Logging;

namespace Orders.Tests.Observability;

/// <summary>
/// An <see cref="ILogger{T}"/> that records each entry's structured values TOGETHER WITH the
/// <see cref="Activity"/> that was current when it was written.
/// </summary>
/// <remarks>
/// Capturing <c>Activity.Current</c> at log time is the whole point of this double, and is what
/// separates it from an ordinary capturing logger. The read services' log lines exist so their
/// workflow span is not mute: in production the span id lands on the line via
/// <c>LogContextEnricher</c>, which reads <c>Activity.Current</c>. A line written after the
/// <c>using</c> activity in <c>WorkflowTracer.TraceWorkflowAsync</c> has been disposed still
/// renders identically and still asserts its <c>app_event</c> correctly — but carries a different
/// span id (or none), which is exactly the bug these lines were added to fix. Only recording the
/// ambient activity can tell those two cases apart.
/// </remarks>
public sealed class SpanScopedLogger<T> : ILogger<T>
{
    public sealed record Entry(LogLevel Level, string Rendered, Activity? Activity)
    {
        public Dictionary<string, object?> Values { get; init; } = new();
    }

    public List<Entry> Entries { get; } = new();

    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

    public bool IsEnabled(LogLevel logLevel) => true;

    public void Log<TState>(
        LogLevel logLevel,
        EventId eventId,
        TState state,
        Exception? exception,
        Func<TState, Exception?, string> formatter)
    {
        var entry = new Entry(logLevel, formatter(state, exception), Activity.Current);

        if (state is IReadOnlyList<KeyValuePair<string, object?>> values)
        {
            foreach (var (key, value) in values)
            {
                entry.Values[key] = value;
            }
        }

        Entries.Add(entry);
    }
}
