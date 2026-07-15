namespace Orders.Application.Abstractions;

// Ambient audit actor for the current async call chain — the .NET analog of the
// Users service's `runAsActor` over AsyncLocalStorage. The write DbContext is
// resolved per-scope, but the audit SaveChanges interceptor cannot see which
// endpoint/command triggered a write; it instead reads the actor from this
// AsyncLocal, which the write paths populate by wrapping their persistence in
// `RunAsync(AuditActor.X, ...)`.
//
// `AsyncLocal` flows the value into the whole async continuation of the callback,
// so a wrapped `await db.SaveChangesAsync()` sees `Current == actor`. The value is
// restored (not just cleared) on exit, so nested RunAsync scopes compose
// correctly. When no scope is active, `Current` is null and the interceptor
// leaves whatever was explicitly set — it never crashes (see AuditInterceptor).
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
