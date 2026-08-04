using Xunit;

// Run collections one at a time instead of in parallel.
//
// xUnit parallelises ACROSS collections by default; serialising within a collection
// (which OrdersApiCollection and OrdersE2eApiCollection both do) only orders the
// classes inside each one. That is not enough here, because the resource being
// contended is process-global rather than per-collection: RequestLogTests captures
// Serilog output by swapping Console.Out for a StringWriter around its request, and
// while that swap is in place it captures whatever ANY concurrently-running test
// writes — and, worse, a host starting up in another collection can flush its own
// startup lines into the capture, pushing the awaited "request completed" record out
// of the window the assertions look at.
//
// That is exactly how it failed: RequestLogTests passed on its own and failed in a
// full run ("Expected a 'request completed' log line") the moment a second collection
// of API-driving classes was added alongside it. Same shared-state race the
// OrdersApiCollection remarks describe, one level up.
//
// The cost is wall-clock: these classes each own a Testcontainers MySQL and were the
// slow part of the suite already. Correctness over speed — an intermittently red
// suite is worth less than a slow green one.
[assembly: CollectionBehavior(DisableTestParallelization = true)]
