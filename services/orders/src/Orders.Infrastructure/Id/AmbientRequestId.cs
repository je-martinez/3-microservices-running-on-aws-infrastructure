namespace Orders.Infrastructure.Id;

/// <summary>
/// The current request's correlation id, ambient to the async call chain — the .NET analog
/// of the Users service's AsyncLocalStorage log context.
/// </summary>
/// <remarks>
/// <para>
/// Modelled directly on <see cref="Orders.Application.Abstractions.AmbientActor"/>, which
/// solves the same problem for the audit actor: a value that every layer needs but that no
/// layer should have to accept as a parameter. Seeded once per request by
/// <c>CallerContextMiddleware</c> and read by the log enricher, the Tracking HTTP client and
/// the SQS publisher.
/// </para>
/// <para>
/// AMBIENT RATHER THAN A PARAMETER, deliberately. The alternative is threading the id
/// through <c>IEventPublisher</c>, <c>ITrackingInitiator</c> and <c>ITrackingReader</c> —
/// three Application ports, both implementations of each, and every call site and test —
/// so that a field with no business meaning appears in the vocabulary of every seam it
/// crosses. Correlation is precisely the kind of cross-cutting concern an ambient context
/// exists for, and this service already made that call once for the audit actor.
/// </para>
/// <para>
/// <c>AsyncLocal</c> flows the value into the whole async continuation, so work started
/// during the request sees it without being handed it. <see cref="Current"/> is null
/// outside a request (startup, background services, a unit test that never seeded one) and
/// every reader treats that as "omit the field" — never as an empty string, and never as a
/// reason to fail.
/// </para>
/// <para>
/// PITFALL, found by a failing test rather than by reading the code. An
/// <c>AsyncLocal</c> written by a middleware is visible to everything DEEPER in the
/// pipeline, but NOT to anything outside it: the value is restored as each frame unwinds,
/// so by the time <c>UseSerilogRequestLogging</c> (the outermost middleware) writes its
/// "request completed" line, a value set in <c>CallerContextMiddleware</c> is already gone.
/// That line is the single most useful record this service emits and it would have been the
/// one line with no request_id. Hence <see cref="Holder"/>: the middleware also parks the id
/// on a mutable box created at the very start of the pipeline, so the outer frame reads the
/// value the inner one resolved.
/// </para>
/// </remarks>
public static class AmbientRequestId
{
    /// <summary>
    /// A mutable cell holding one request's id.
    /// </summary>
    /// <remarks>
    /// The indirection is the whole point. The BOX is what flows through
    /// <c>AsyncLocal</c> — installed by <see cref="Begin"/> in the outermost middleware —
    /// and its CONTENTS are filled in later, deeper in the pipeline, by
    /// <see cref="Set"/>. Mutating an object every frame already shares beats writing the
    /// <c>AsyncLocal</c> itself, which only the frames below the writer would ever see.
    /// </remarks>
    private sealed class Holder
    {
        public string? Value;
    }

    private static readonly AsyncLocal<Holder?> _current = new();

    /// <summary>The current request's id, or null when none has been resolved.</summary>
    public static string? Current => _current.Value?.Value;

    /// <summary>
    /// Opens a correlation scope for the request, before anything can log.
    /// </summary>
    /// <remarks>
    /// Called by the OUTERMOST middleware so that every later frame — including the request
    /// logger on the way back out — shares one cell. The id itself is not known yet at that
    /// point; <see cref="Set"/> fills it in.
    /// </remarks>
    public static void Begin() => _current.Value = new Holder();

    /// <summary>
    /// Records the id for the current request.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Set once, at ingress, and never reset partway through: the whole point is ONE id per
    /// logical flow, so a second call mid-request would split that flow's log lines into two
    /// uncorrelated halves.
    /// </para>
    /// <para>
    /// With no scope open (a background publish, a unit test calling this directly) it opens
    /// one implicitly, so a caller outside the HTTP pipeline still gets a working context
    /// rather than a silently discarded write.
    /// </para>
    /// </remarks>
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
