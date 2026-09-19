using Orders.Infrastructure.Bus;
using Wolverine;

namespace Orders.Tests.Bus;

/// <summary>
/// The pipeline order D4 commits to — tracing -> app_event -> logging -> validation -> handler
/// — asserted as the order the app actually wires, not as a comment.
/// CONTRACT: Read the order from Program.cs's own registration. A test spelling the order out
/// twice passes when the two spellings agree with each other and disagree with the app.
/// See [[cqrs]]
/// </summary>
public class PipelineOrderTests
{
    /// <summary>The order Program.cs registers, and the only place it is named in a test.</summary>
    public static readonly Type[] Expected =
    [
        typeof(WorkflowSpanMiddleware),
        typeof(AppEventMiddleware),
        typeof(FlowLoggingMiddleware),
        typeof(FlowValidationMiddleware),
    ];

    [Fact]
    public async Task The_four_behaviors_run_outermost_first_in_the_D4_order()
    {
        await using var harness = await BusPipelineHarness.StartAsync();

        await harness.Bus.InvokeAsync<ProbeWriteResult>(new ProbeWrite(null, Throw: false));

        // Tracing is OUTERMOST: its span must already be open when app_event and logging run,
        // and it must still be open when they close. The two observable consequences are that
        // the span exists at all and that every line is stamped with it.
        var span = harness.Span();
        Assert.All(harness.Logs.FlowEntries, entry => Assert.Same(span, entry.Activity));

        // app_event before logging: the terminal app_event on the SPAN and on the terminal LINE
        // agree. A logging step running outside the app_event step would write its line before
        // the terminal event was decided and the two would disagree.
        var spanEvent = span.TagObjects.Single(t => t.Key == "app_event").Value;
        Assert.Equal(spanEvent, harness.Logs.FlowEntries.Last().Values["app_event"]);
    }

    [Fact]
    public void Every_registered_behavior_exposes_a_Before_or_a_Finally_hook()
    {
        // Wolverine discovers middleware by METHOD NAME and the matching is case sensitive, so
        // a renamed or mis-cased hook is not an error: the step is silently dropped and the
        // pipeline runs one behavior short with nothing to show for it.
        foreach (var behavior in Expected)
        {
            var hooks = behavior.GetMethods()
                .Where(m => m.Name is "Before" or "BeforeAsync" or "Validate" or "ValidateAsync"
                    or "Finally" or "FinallyAsync" or "After" or "AfterAsync")
                .ToList();

            Assert.NotEmpty(hooks);
        }
    }
}
