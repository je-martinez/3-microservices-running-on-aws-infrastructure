namespace Orders.Application.Messaging;

/// <summary>
/// A command or query dispatched through the bus. <see cref="Flow"/> names the business
/// workflow, which is what the pipeline spans and logs under.
/// </summary>
/// <remarks>
/// CONTRACT: The pipeline middleware is registered via
/// <c>Policies.ForMessagesOfType&lt;IFlowMessage&gt;()</c>, so Wolverine resolves the message
/// parameter by THIS interface. A message that does not implement it gets no span, no
/// <c>app_event</c> and no flow log — the handler still runs, silently uninstrumented.
/// See [[logging-context]]
/// </remarks>
public interface IFlowMessage
{
    /// <summary>
    /// The flow name (<c>list_my_orders</c>, <c>internal_invalidate_order_cache</c>). Becomes
    /// the span name and the <c>&lt;flow&gt;_started|_succeeded|_failed</c> stem.
    /// </summary>
    string Flow { get; }

    /// <summary>
    /// True for flows that emit the full <c>_started</c>/<c>_succeeded</c>/<c>_failed</c>
    /// triad. False for reads, which get ONE <c>_succeeded</c> line and no <c>_started</c>
    /// twin: a single SELECT has no intermediate step at which <c>_started</c> could be the
    /// last line seen. See [[logging-context]]
    /// </summary>
    bool EmitsStarted { get; }
}
