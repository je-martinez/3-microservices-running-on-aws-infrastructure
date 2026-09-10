using Orders.Application.Abstractions;

namespace Orders.Api.Middleware;

/// <summary>
/// Publishes <c>http_errors_total</c> for any response with status &gt;= 400.
/// CONTRACT: Middleware, not an endpoint filter, registered right after
/// <c>UseSerilogRequestLogging</c> so it sees the FINAL status — a filter misses the 401
/// raised before routing. Only 4xx and 5xx are counted. See [[logging-context]]
/// </summary>
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
