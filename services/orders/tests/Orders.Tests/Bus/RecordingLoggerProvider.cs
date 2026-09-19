using System.Collections.Concurrent;
using System.Diagnostics;
using Microsoft.Extensions.Logging;

namespace Orders.Tests.Bus;

/// <summary>
/// An <see cref="ILoggerProvider"/> capturing each entry's structured values together with the
/// <see cref="Activity"/> that was current when it was written.
/// </summary>
/// <remarks>
/// CONTRACT: Capture <c>Activity.Current</c> at LOG time. A line written after the workflow
/// activity closed renders identically and asserts its <c>app_event</c> correctly while
/// carrying a different span id, and only the ambient activity tells those two apart.
/// See [[logging-context]]
/// </remarks>
public sealed class RecordingLoggerProvider : ILoggerProvider
{
    public sealed record Entry(
        string Category, LogLevel Level, string Rendered, Activity? Activity)
    {
        public Dictionary<string, object?> Values { get; init; } = new();
    }

    private readonly ConcurrentQueue<Entry> _entries = new();

    /// <summary>Only the flow lines the pipeline writes, in order — Wolverine's own excluded.</summary>
    public IReadOnlyList<Entry> FlowEntries =>
        _entries.Where(e => e.Values.ContainsKey("app_event")).ToList();

    public ILogger CreateLogger(string categoryName) => new Recorder(categoryName, _entries);

    public void Dispose() { }

    private sealed class Recorder : ILogger
    {
        private readonly string _category;
        private readonly ConcurrentQueue<Entry> _sink;

        public Recorder(string category, ConcurrentQueue<Entry> sink)
        {
            _category = category;
            _sink = sink;
        }

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            var entry = new Entry(
                _category, logLevel, formatter(state, exception), Activity.Current);

            if (state is IReadOnlyList<KeyValuePair<string, object?>> values)
            {
                foreach (var (key, value) in values)
                {
                    entry.Values[key] = value;
                }
            }

            _sink.Enqueue(entry);
        }
    }
}
