using Xunit;

// CONTRACT: Run collections one at a time. Serialising WITHIN a collection is not enough —
// the contended resource is process-global: RequestLogTests swaps Console.Out to capture
// Serilog, so a host starting up in another collection flushes its startup lines into that
// capture and pushes the awaited "request completed" record out of the window. The symptom
// is a test that passes alone and fails in a full run. See [[testing]]
[assembly: CollectionBehavior(DisableTestParallelization = true)]
