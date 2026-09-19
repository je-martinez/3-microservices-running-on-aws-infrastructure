using System.Diagnostics;
using Microsoft.Extensions.Logging;
using Orders.Application.Messaging;
using Wolverine;

namespace Orders.Tests.Bus;

/// <summary>
/// The four-step pipeline's own behavior, asserted THROUGH the real bus.
/// CONTRACT: Every test here dispatches with <c>bus.InvokeAsync</c>. Calling a handler
/// directly would exercise none of the middleware and pass no matter what the pipeline did.
/// See [[testing]]
/// </summary>
public class BusPipelineTests
{
    [Fact]
    public async Task A_succeeding_read_gets_one_span_and_one_succeeded_line_with_its_count()
    {
        await using var harness = await BusPipelineHarness.StartAsync();

        var result = await harness.Bus.InvokeAsync<ProbeReadResult>(new ProbeRead(3));

        Assert.Equal(3, result.Count);

        var span = harness.Span();
        Assert.Equal("probe_read", span.DisplayName);
        Assert.Equal(ActivityStatusCode.Ok, span.Status);
        Assert.Contains(
            span.TagObjects, t => t.Key == "app_event" && (string?)t.Value == "probe_read_succeeded");
        // TagObjects, not Tags: Activity.Tags only surfaces string values, and the count is an
        // int on purpose (OTel's numeric attribute type).
        Assert.Contains(span.TagObjects, t => t.Key == "probe_count" && (int?)t.Value == 3);
        // Omitted, never null — the contract forbids "reason": null on a success.
        Assert.DoesNotContain(span.TagObjects, t => t.Key == "reason");
        // CONTRACT: Stopped, not merely started — a running activity is never exported.
        Assert.NotEqual(default, span.Duration);

        // A read gets ONE line: no _started twin. A single SELECT has no intermediate step at
        // which _started could be the last thing seen.
        var entry = Assert.Single(harness.Logs.FlowEntries);
        Assert.Equal(LogLevel.Information, entry.Level);
        Assert.Equal("probe_read_succeeded", entry.Values["app_event"]);
        Assert.Equal(3, entry.Values["probe_count"]);
        Assert.DoesNotContain("reason", entry.Values.Keys);

        // The reason the line exists at all: a line written OUTSIDE the workflow activity
        // renders identically and carries the right app_event, and still leaves a span-scoped
        // log lookup empty. Assert the ambient activity AT LOG TIME is this very span.
        Assert.Same(span, entry.Activity);
    }

    [Fact]
    public async Task A_succeeding_write_gets_the_started_and_succeeded_pair()
    {
        await using var harness = await BusPipelineHarness.StartAsync();

        await harness.Bus.InvokeAsync<ProbeWriteResult>(new ProbeWrite(null, Throw: false));

        var span = harness.Span();
        Assert.Equal(ActivityStatusCode.Ok, span.Status);
        // CONTRACT: The TERMINAL event wins. SetTag is last-write-wins per key, so a step
        // writing app_event after the terminal one would leave every finished flow reporting
        // _started — the span would say "in progress" forever.
        Assert.Contains(
            span.TagObjects,
            t => t.Key == "app_event" && (string?)t.Value == "probe_write_succeeded");

        Assert.Collection(
            harness.Logs.FlowEntries,
            started =>
            {
                Assert.Equal(LogLevel.Information, started.Level);
                Assert.Equal("probe_write_started", started.Values["app_event"]);
            },
            succeeded =>
            {
                // No SUCCESS severity — success is INFO + app_event=*_succeeded, because
                // SUCCESS is not an OTel level. See [[logging-context]]
                Assert.Equal(LogLevel.Information, succeeded.Level);
                Assert.Equal("probe_write_succeeded", succeeded.Values["app_event"]);
                Assert.DoesNotContain("reason", succeeded.Values.Keys);
            });
    }

    [Fact]
    public async Task A_routine_not_found_logs_failed_with_its_reason_and_leaves_the_span_OK()
    {
        // The load-bearing distinction. A domain "not found" a route turns into a 404 is a
        // normal return value, so it must NOT mark the span ERROR — on a service whose
        // commonest answer is "no such order" that would bury every real fault.
        await using var harness = await BusPipelineHarness.StartAsync();

        var result = await harness.Bus.InvokeAsync<ProbeWriteResult>(
            new ProbeWrite("order_not_found", Throw: false));

        Assert.Equal("order_not_found", result.FailureReason);

        var span = harness.Span();
        Assert.Equal(ActivityStatusCode.Ok, span.Status);
        Assert.NotEqual(ActivityStatusCode.Error, span.Status);
        Assert.Contains(
            span.TagObjects,
            t => t.Key == "app_event" && (string?)t.Value == "probe_write_failed");
        Assert.Contains(span.TagObjects, t => t.Key == "reason" && (string?)t.Value == "order_not_found");

        var terminal = harness.Logs.FlowEntries.Last();
        Assert.Equal("probe_write_failed", terminal.Values["app_event"]);
        // CONTRACT: The handler's SPECIFIC reason, never a generic stamp over it. A pipeline
        // that wrote "unhandled_error" here would destroy the one field an operator needs, and
        // every test calling the handler directly would still pass. See [[testing]]
        Assert.Equal("order_not_found", terminal.Values["reason"]);
    }

    [Fact]
    public async Task A_thrown_failure_marks_the_span_ERROR_and_still_closes_it()
    {
        await using var harness = await BusPipelineHarness.StartAsync();

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            harness.Bus.InvokeAsync<ProbeWriteResult>(new ProbeWrite(null, Throw: true)));

        var span = harness.Span();
        // The other half of the distinction: only a THROW is an error.
        Assert.Equal(ActivityStatusCode.Error, span.Status);
        Assert.Contains(
            span.TagObjects,
            t => t.Key == "app_event" && (string?)t.Value == "probe_write_failed");
        // The span still ENDS on the exception path. One left running is never exported, with
        // no error to show for it.
        Assert.NotEqual(default, span.Duration);

        var terminal = harness.Logs.FlowEntries.Last();
        Assert.Equal(LogLevel.Warning, terminal.Level);
        Assert.Equal("probe_write_failed", terminal.Values["app_event"]);
        // No specific reason exists on this path, so the generic one is the honest answer —
        // it is a fallback, never an overwrite (see the routine test above).
        Assert.Equal("unhandled_error", terminal.Values["reason"]);
    }

    [Fact]
    public async Task The_span_is_the_ambient_activity_for_the_whole_pipeline()
    {
        // What makes every line the pipeline writes joinable to the trace, and what a
        // middleware order putting logging outside tracing would break.
        await using var harness = await BusPipelineHarness.StartAsync();

        await harness.Bus.InvokeAsync<ProbeWriteResult>(new ProbeWrite(null, Throw: false));

        var span = harness.Span();
        Assert.All(harness.Logs.FlowEntries, entry => Assert.Same(span, entry.Activity));
    }
}
