using Orders.Application.Messaging;
using Orders.Infrastructure.Bus;
using Wolverine.Attributes;

namespace Orders.Tests.Bus;

/// <summary>
/// The three outcomes the pipeline must tell apart: happy, ROUTINE failure (returned), and
/// THROWN failure. Probes rather than the real handlers — the property under test is the
/// pipeline's, and a handler dragging in a DbContext would make these tests about persistence.
/// See [[testing]]
/// </summary>
public record ProbeRead(int Count) : IFlowMessage
{
    public string Flow => "probe_read";

    public bool EmitsStarted => false;
}

public record ProbeReadResult(int Count);

public record ProbeWrite(string? RoutineReason, bool Throw) : IFlowMessage
{
    public string Flow => "probe_write";

    public bool EmitsStarted => true;
}

public record ProbeWriteResult(string? FailureReason) : IRoutineFailure;

[NonTransactional]
public static class ProbeReadHandler
{
    public static ProbeReadResult Handle(ProbeRead query, FlowScope scope)
    {
        scope.Succeeded("probe_count", query.Count);
        return new ProbeReadResult(query.Count);
    }
}

[NonTransactional]
public static class ProbeWriteHandler
{
    /// <summary>
    /// CONTRACT: The routine failure RETURNS its reason; only the <c>Throw</c> case throws. A
    /// handler that threw for "not found" would give the pipeline no way to keep the span OK.
    /// See [[logging-context]]
    /// </summary>
    public static ProbeWriteResult Handle(ProbeWrite command, FlowScope scope)
    {
        if (command.Throw)
        {
            throw new InvalidOperationException("probe_write blew up");
        }

        if (command.RoutineReason is not null)
        {
            scope.RoutineFailure(command.RoutineReason);
        }
        else
        {
            scope.Succeeded();
        }

        return new ProbeWriteResult(command.RoutineReason);
    }
}
