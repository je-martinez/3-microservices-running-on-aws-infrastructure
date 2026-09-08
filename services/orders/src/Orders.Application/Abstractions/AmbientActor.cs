namespace Orders.Application.Abstractions;

// Ambient audit actor for the current async call chain. The audit interceptor cannot see
// which command triggered a write, so it reads the actor from here and write paths wrap their
// persistence in `RunAsync(AuditActor.X, ...)`.
// CONTRACT: The value is RESTORED, not cleared, on exit, so nested scopes compose. With no
// scope active `Current` is null and the interceptor leaves what was explicitly set.
// See [[audit-fields]]
public static class AmbientActor
{
    private static readonly AsyncLocal<string?> _current = new();

    public static string? Current => _current.Value;

    public static async Task<T> RunAsync<T>(string actor, Func<Task<T>> fn)
    {
        var previous = _current.Value;
        _current.Value = actor;
        try
        {
            return await fn();
        }
        finally
        {
            _current.Value = previous;
        }
    }

    public static async Task RunAsync(string actor, Func<Task> fn)
    {
        var previous = _current.Value;
        _current.Value = actor;
        try
        {
            await fn();
        }
        finally
        {
            _current.Value = previous;
        }
    }
}
