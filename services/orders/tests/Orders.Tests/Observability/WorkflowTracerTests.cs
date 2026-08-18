using System.Diagnostics;
using Orders.Infrastructure.Observability;

namespace Orders.Tests.Observability;

// An ActivitySource with no listener produces NULL activities — StartActivity
// returns null and nothing is recorded. That is the same silent failure mode as
// an ActivitySource whose name Program.cs never passes to AddSource(...): no
// error, no span. So every test here installs its own ActivityListener scoped to
// WorkflowTracer.ActivitySourceName, which is also what pins that constant as
// part of the contract.
public class WorkflowTracerTests
{
    private static ActivityListener ListenerFor(List<Activity> recorded) =>
        new()
        {
            ShouldListenTo = source => source.Name == WorkflowTracer.ActivitySourceName,
            Sample = (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllData,
            ActivityStopped = recorded.Add,
        };

    [Fact]
    public async Task TraceWorkflowAsync_CreatesActivityNamedAfterFlow_WithGivenAttributes_AndOkStatusOnSuccess()
    {
        var recorded = new List<Activity>();
        using var listener = ListenerFor(recorded);
        ActivitySource.AddActivityListener(listener);

        var tracer = new WorkflowTracer();
        var result = await tracer.TraceWorkflowAsync(
            "create_order",
            new Dictionary<string, object?> { ["app_event"] = "create_order_started" },
            async () =>
            {
                await Task.Yield();
                return 42;
            });

        Assert.Equal(42, result);
        var span = Assert.Single(recorded);
        Assert.Equal("create_order", span.DisplayName);
        Assert.Equal(ActivityKind.Internal, span.Kind);
        Assert.Equal(ActivityStatusCode.Ok, span.Status);
        Assert.Contains(span.Tags, t => t.Key == "app_event" && t.Value == "create_order_started");
        // The span is STOPPED, not merely created: an activity left running never
        // reaches the exporter, so asserting the status alone would not catch it.
        Assert.NotEqual(default, span.Duration);
        Assert.Null(Activity.Current);
    }

    [Fact]
    public async Task TraceWorkflowAsync_SetsErrorStatusAndReason_WhenActionThrows()
    {
        var recorded = new List<Activity>();
        using var listener = ListenerFor(recorded);
        ActivitySource.AddActivityListener(listener);

        var tracer = new WorkflowTracer();

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            tracer.TraceWorkflowAsync<int>(
                "create_order",
                new Dictionary<string, object?> { ["app_event"] = "create_order_started" },
                async () =>
                {
                    await Task.Yield();
                    // Set from INSIDE the action, exactly as CreateOrderService's
                    // failure branches do beside their own _logger.LogError call, so
                    // the span's reason is the same string the flow log carries.
                    tracer.SetReason("unknown_user");
                    throw new InvalidOperationException("caller not found");
                }));

        var span = Assert.Single(recorded);
        Assert.Equal(ActivityStatusCode.Error, span.Status);
        Assert.Equal("caller not found", span.StatusDescription);
        Assert.Contains(span.Tags, t => t.Key == "reason" && t.Value == "unknown_user");
        // The exception path must still END the activity — the whole reason the
        // implementation uses `using` rather than a manual Stop() on the happy path.
        Assert.NotEqual(default, span.Duration);
        Assert.Null(Activity.Current);
    }

    [Fact]
    public async Task SetAttribute_AttachesToTheCurrentWorkflowSpan()
    {
        var recorded = new List<Activity>();
        using var listener = ListenerFor(recorded);
        ActivitySource.AddActivityListener(listener);

        var tracer = new WorkflowTracer();
        await tracer.TraceWorkflowAsync(
            "create_order",
            new Dictionary<string, object?> { ["app_event"] = "create_order_started" },
            async () =>
            {
                await Task.Yield();
                tracer.SetAttribute("order_id", "ord_abc123");
                return true;
            });

        var span = Assert.Single(recorded);
        Assert.Contains(span.Tags, t => t.Key == "order_id" && t.Value == "ord_abc123");
    }

    [Fact]
    public async Task TraceWorkflowAsync_StillRunsTheAction_WhenNoListenerIsRegistered()
    {
        // No listener for this source at all: StartActivity returns null. The
        // workflow must still run and return normally — the tracer is
        // observability, never a precondition for creating an order.
        var tracer = new WorkflowTracer();

        var result = await tracer.TraceWorkflowAsync(
            "create_order_unlistened",
            new Dictionary<string, object?> { ["app_event"] = "create_order_started" },
            async () =>
            {
                await Task.Yield();
                tracer.SetReason("nobody_is_listening");
                return "ok";
            });

        Assert.Equal("ok", result);
    }
}
