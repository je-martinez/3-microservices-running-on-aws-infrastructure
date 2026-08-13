using Orders.Application.Abstractions;

namespace Orders.Api.Middleware;

/// <summary>
/// Publishes <c>http_errors_total</c> for any response with status &gt;= 400.
/// </summary>
/// <remarks>
/// <para>
/// Registered immediately after <c>UseSerilogRequestLogging</c> so it observes the FINAL
/// status of the completed response — including statuses set by short-circuiting middleware
/// (<see cref="CallerContextMiddleware"/>'s 401) and by per-endpoint results, which an
/// endpoint filter would miss.
/// </para>
/// <para>
/// Only 4xx and 5xx are counted. A metric per 2xx would be a request-rate metric, which the
/// request log already provides, and it would multiply the published series for no added
/// signal.
/// </para>
/// </remarks>
public class HttpErrorMetricsMiddleware
{
    private readonly RequestDelegate _next;
    private readonly IMetricsPublisher _metrics;

    public HttpErrorMetricsMiddleware(RequestDelegate next, IMetricsPublisher metrics)
    {
        _next = next;
        _metrics = metrics;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        await _next(context);

        var status = context.Response.StatusCode;
        if (status >= 400)
        {
            await _metrics.PublishAsync(
                "http_errors_total",
                1,
                new Dictionary<string, string>
                {
                    ["Service"] = "orders",
                    ["StatusClass"] = status >= 500 ? "5xx" : "4xx",
                },
                context.RequestAborted);
        }
    }
}
