using System.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Orders.Application.Messaging;
using Orders.Infrastructure.Bus;
using Orders.Infrastructure.Observability;
using Wolverine;

namespace Orders.Tests.Bus;

/// <summary>
/// A real Wolverine host running the REAL four-step pipeline over probe handlers, plus the
/// spans and log lines it produced.
/// </summary>
/// <remarks>
/// CONTRACT: Assert through <see cref="Bus"/>, never by calling a handler underneath it. A
/// suite that invokes handlers directly never executes the middleware and stays green while
/// the pipeline destroys a <c>reason</c> or errors a routine span. See [[testing]]
/// CONTRACT: Register the middleware here EXACTLY as Program.cs does — same order, same
/// ForMessagesOfType filter. A harness wiring its own order proves nothing about the app.
/// </remarks>
public sealed class BusPipelineHarness : IAsyncDisposable
{
    private IHost _host = null!;
    private ActivityListener _listener = null!;

    public List<Activity> Spans { get; } = new();

    public RecordingLoggerProvider Logs { get; } = new();

    public IMessageBus Bus => _host.Services.GetRequiredService<IMessageBus>();

    private BusPipelineHarness() { }

    public static async Task<BusPipelineHarness> StartAsync()
    {
        var harness = new BusPipelineHarness();

        // Without a listener on this EXACT source the activity is null and nothing is
        // recorded — the same silent failure an unregistered AddSource in Program.cs makes.
        harness._listener = new ActivityListener
        {
            ShouldListenTo = source => source.Name == WorkflowTracer.ActivitySourceName,
            Sample = (ref ActivityCreationOptions<ActivityContext> _) =>
                ActivitySamplingResult.AllData,
            ActivityStopped = harness.Spans.Add,
        };
        ActivitySource.AddActivityListener(harness._listener);

        harness._host = await Host.CreateDefaultBuilder()
            .ConfigureLogging(logging =>
            {
                logging.ClearProviders();
                logging.AddProvider(harness.Logs);
                logging.SetMinimumLevel(LogLevel.Trace);
            })
            .UseWolverine(opts =>
            {
                opts.Discovery.IncludeAssembly(typeof(BusPipelineHarness).Assembly);

                opts.Policies.ForMessagesOfType<IFlowMessage>()
                    .AddMiddleware(typeof(WorkflowSpanMiddleware));
                opts.Policies.AddMiddleware(typeof(AppEventMiddleware));
                opts.Policies.AddMiddleware(typeof(FlowLoggingMiddleware));
                opts.Policies.AddMiddleware(typeof(FlowValidationMiddleware));
            })
            .StartAsync();

        return harness;
    }

    /// <summary>The single span this flow produced.</summary>
    public Activity Span() => Assert.Single(Spans);

    public async ValueTask DisposeAsync()
    {
        _listener.Dispose();
        await _host.StopAsync();
        _host.Dispose();
    }
}
