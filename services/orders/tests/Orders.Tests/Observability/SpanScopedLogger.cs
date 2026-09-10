using System.Diagnostics;
using Microsoft.Extensions.Logging;

namespace Orders.Tests.Observability;

/// <summary>
/// An <see cref="ILogger{T}"/> that records each entry's structured values TOGETHER WITH the
/// <see cref="Activity"/> that was current when it was written.
/// </summary>
/// <remarks>
/// CONTRACT: Capture <c>Activity.Current</c> at LOG time — that is what separates this from an
/// ordinary capturing logger. A line written after the workflow activity is disposed renders
/// identically and asserts its <c>app_event</c> correctly while carrying a different span id,
/// and only the ambient activity tells those two cases apart. See [[logging-context]]
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
