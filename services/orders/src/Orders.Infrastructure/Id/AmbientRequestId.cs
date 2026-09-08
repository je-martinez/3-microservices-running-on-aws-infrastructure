namespace Orders.Infrastructure.Id;

/// <summary>
/// The current request's correlation id, ambient to the async call chain.
/// CONTRACT: Do NOT write the id straight into the <c>AsyncLocal</c> — a middleware's write
/// is restored as each frame unwinds, so the outermost "request completed" line would be the
/// one line with no request_id. <see cref="Holder"/> is the box that fixes that.
/// <see cref="Current"/> is null outside a request; readers omit the field.
/// See [[logging-context]]
/// </summary>
public static class AmbientRequestId
{
    /// <summary>
    /// A mutable cell holding one request's id. The BOX flows through <c>AsyncLocal</c>,
    /// installed by <see cref="Begin"/>; its CONTENTS are filled in by <see cref="Set"/>.
    /// </summary>
    private sealed class Holder
    {
        public string? Value;
    }

    private static readonly AsyncLocal<Holder?> _current = new();

    /// <summary>The current request's id, or null when none has been resolved.</summary>
    public static string? Current => _current.Value?.Value;

    /// <summary>
    /// Opens a correlation scope for the request, before anything can log.
    /// CONTRACT: Call this from the OUTERMOST middleware, so every later frame — the request
    /// logger on the way back out included — shares one cell. See [[logging-context]]
    /// </summary>
    public static void Begin() => _current.Value = new Holder();

    /// <summary>
    /// Records the id for the current request.
    /// CONTRACT: Set once, at ingress, never reset mid-request — a second call splits the
    /// flow's log lines into two uncorrelated halves. See [[logging-context]]
    /// </summary>
    public static void Set(string requestId)
    {
        var holder = _current.Value;

        if (holder is null)
        {
            holder = new Holder();
            _current.Value = holder;
        }

        holder.Value = requestId;
    }
}
