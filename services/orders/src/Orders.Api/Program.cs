using Amazon.CloudWatch;
using Amazon.SQS;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Orders.Api.BackgroundServices;
using Orders.Api.Endpoints;
using Orders.Api.Identity;
using Orders.Api.Logging;
using Orders.Api.Middleware;
using Orders.Application.Abstractions;
using Orders.Application.Identity;
using Orders.Application.Tracking;
using Orders.Infrastructure.Config;
using Orders.Infrastructure.Grpc;
using Orders.Infrastructure.Id;
using Orders.Infrastructure.Messaging;
using Orders.Infrastructure.Metrics;
using Orders.Infrastructure.Observability;
using Orders.Infrastructure.Orders;
using Orders.Infrastructure.Persistence;
using Orders.Infrastructure.Tracking;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using Serilog;

var builder = WebApplication.CreateBuilder(args);

// Declared up front: both the tracing resource and the Serilog formatter below
// stamp it, so they cannot disagree about which environment this process is.
var deploymentEnvironment = builder.Configuration["DEPLOYMENT_ENVIRONMENT"] ?? "local";

// Needed by LogContextEnricher to reach the request-scoped ICurrentCaller.
builder.Services.AddHttpContextAccessor();

// Distributed tracing. AddHttpClientInstrumentation is what makes the
// Orders -> Users identity call a CHILD span of the incoming request rather
// than an unrelated trace: .NET's gRPC client rides on HttpClient, so this
// instrumentation injects the W3C traceparent header on every gRPC call.
// (The dedicated GrpcNetClient package only ships as a prerelease; the stable
// Http instrumentation covers the same path, so no beta is needed for the one
// piece cross-service tracing actually depends on.)
builder.Services.AddOpenTelemetry()
    .ConfigureResource(resource => resource
        .AddService(serviceName: "orders")
        .AddAttributes([
            new KeyValuePair<string, object>("deployment.environment.name", deploymentEnvironment),
        ]))
    .WithTracing(tracing => tracing
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddEntityFrameworkCoreInstrumentation()
        // What makes SqsEventPublisher's SendMessageAsync produce a CLIENT span.
        .AddAWSInstrumentation()
        // REQUIRED, not decorative: .NET's tracing pipeline drops every
        // ActivitySource it was not explicitly told about, so without this line
        // the manually-created "create_order" Activity is still built and still
        // costs work, but never leaves the process — no error, no span in
        // Jaeger. Same silent failure class as unregistered instrumentation.
        // Register the source in the SAME change that creates one.
        .AddSource(WorkflowTracer.ActivitySourceName)
        // The SQS publish span. Same rule as the line above — unregistered means
        // created-but-never-exported, silently. It is also the span whose context
        // travels as the message's `traceparent`, so without this line the queue hop
        // still works but its parent never appears in Jaeger.
        .AddSource(SqsEventPublisher.ActivitySourceName)
        // No Endpoint set here ON PURPOSE. The exporter reads the standard
        // OTEL_EXPORTER_OTLP_ENDPOINT (set in docker-compose.yml) as a BASE url
        // and appends the signal path itself, per the OTLP spec.
        //
        // Building the URL by hand is what broke this service: it passed the
        // base with no path, so every batch was POSTed to the collector's root
        // and answered 404 — silently, since the exporter does not surface it.
        // Leaving it to the SDK means a new service needs no endpoint code at
        // all, only the env var. See [[logging-context]].
        .AddOtlpExporter());

// Structured JSON logging (snake_case OTel-aligned schema). Replaces the
// default plain-text console logger for all `orders` logs.
//
// The THREE-argument UseSerilog overload is required: the two-argument one has
// no `services` parameter, so the enricher could not resolve
// IHttpContextAccessor and the shared log context would never be attached.
// The Override below is NOISE SUPPRESSION, not a convenience — do not remove it
// without re-reading this. It is set to WARNING, not None, ON PURPOSE: a failed
// trace export still surfaces. Only the per-operation INFO chatter is silenced.
//
// Note it MUST live here, in code. This service has no
// `ReadFrom.Configuration`, so Serilog never reads `Logging:LogLevel` from
// appsettings.json — adding the category there would silence nothing.
//
//  1. System.Net.Http.HttpClient.OtlpTraceExporter — SELF-REFERENTIAL telemetry.
//     The OTLP exporter POSTs batches over HttpClient, and HttpClient logs each
//     POST at INFO ("Start processing HTTP request", "Received HTTP response
//     headers ... 200"). Those log lines are themselves exported, so exporting
//     traces generates logs that generate more exporting. The volume scales with
//     traffic and drowns the real orders logs. Scoped to the named
//     OtlpTraceExporter client rather than the whole `System.Net.Http.HttpClient`
//     prefix so genuine outbound-HTTP problems (the Users gRPC call, Tracking)
//     still log normally. It covers both handler suffixes the category expands
//     to — `.LogicalHandler` and `.ClientHandler` — because Serilog Overrides
//     match on the source-context PREFIX.
//
//  2. Microsoft.AspNetCore.Hosting.Diagnostics — "Request starting" / "Request
//     finished", one PAIR per request, both describing what
//     `request completed` already reports with more detail (method, route,
//     status, duration_ms, and the shared log context).
//
//  3. Microsoft.AspNetCore.Routing.EndpointMiddleware — "Executing endpoint" /
//     "Executed endpoint", another pair per request. It names the handler the
//     route resolved to, which is a framework-internal detail: the route itself
//     is already on the request log.
//
//  4. Microsoft.AspNetCore.Http.Result — "Setting HTTP status code 400",
//     "Writing value of type '<>f__AnonymousType0`2' as Json". The status is on
//     the request log and the CLR type name of an anonymous DTO says nothing
//     about the response. The override is on the `Http.Result` PREFIX so it
//     covers every result type (BadRequestObjectResult, OkObjectResult,
//     CreatedResult, …) rather than needing one entry per status.
//
// WHY THIS MATTERS, measured rather than assumed: of 101 orders lines in a
// two-hour window, only THREE carried an app_event — the actual business events
// (create_order_started, create_order_succeeded, init_tracking_succeeded). The
// other 98 were the framework describing its own plumbing. The events-pipeline,
// which has no such framework, sits at 93/93. A service whose business signal is
// 3% of its own log volume is one where the interesting line is found by luck.
//
// All four are WARNING, not None, for the same reason as the exporter above: a
// routing failure or a result that cannot be serialized still surfaces. Only the
// per-request INFO chatter goes quiet.
//
// Serilog.AspNetCore.RequestLoggingMiddleware is deliberately NOT here. Its
// single "request completed" line per request IS the signal these three
// duplicate — it carries method, route, status, duration and the enriched
// context. Silencing it would remove the one framework line worth keeping.
//
// EF Core's Database.Command is deliberately NOT overridden here, even though it
// is just as noisy. Its DbCommand lines are ROUTED, not suppressed: the
// collector's filter/only_sql sends them to the dedicated `sql` stream, which is
// where SQLAlchemy's equivalent from Tracking already goes. Silencing them in
// this service instead would leave the two services answering "what SQL did you
// run?" differently — orders' statements would exist nowhere at all, while
// tracking's stay queryable. See observability/otel-collector-config.yaml.
builder.Host.UseSerilog((_, services, cfg) => cfg
    .MinimumLevel.Information()
    .MinimumLevel.Override("System.Net.Http.HttpClient.OtlpTraceExporter", Serilog.Events.LogEventLevel.Warning)
    .MinimumLevel.Override("Microsoft.AspNetCore.Hosting.Diagnostics", Serilog.Events.LogEventLevel.Warning)
    .MinimumLevel.Override("Microsoft.AspNetCore.Routing.EndpointMiddleware", Serilog.Events.LogEventLevel.Warning)
    .MinimumLevel.Override("Microsoft.AspNetCore.Http.Result", Serilog.Events.LogEventLevel.Warning)
    .Enrich.With(new LogContextEnricher(services.GetRequiredService<IHttpContextAccessor>()))
    .WriteTo.Console(new SchemaLogFormatter("orders", deploymentEnvironment)));

// Read side (read replica in prod; same MySQL locally). ADO connection string.
var readerCs = builder.Configuration["DATABASE_READER_URL"]!;
builder.Services.AddDbContext<OrdersReadDbContext>(o =>
    o.UseMySql(readerCs, ServerVersion.AutoDetect(readerCs)));
builder.Services.AddScoped<OrderReadService>();
// Assets base URL for product artwork. Rows store bucket-relative keys and the read
// service composes the absolute URL, so the bucket name is never persisted (Floci
// re-mints it on every apply). Locally this comes from .env.local.orders, which
// generate_env_files.py fills from phase 2's assets_base_url output, falling back to
// the derived value when `make post-infra` has not run.
// Deliberately NOT `["ASSETS_BASE_URL"]!` and deliberately NOT a throw.
//
// The `!` was worse: a missing value reached the first request, TrimEnd threw, and
// GET /v1/products answered a bare 500 naming nothing (how this surfaced in the API
// tests). But throwing here is wrong too — the build-time OpenAPI generator boots
// this very host to read its endpoint metadata (Microsoft.Extensions.ApiDescription
// .Server, see the service's CLAUDE.md 2a), with no env file in scope, so a throw
// breaks `dotnet build` itself.
//
// So: fall back to the derived local bucket URL, which is the same value
// generate_env_files.py writes when phase 2 has not been applied. A wrong-but-shaped
// URL degrades to an image that 404s; an empty one crashes the request.
var assetsBaseUrl = builder.Configuration["ASSETS_BASE_URL"]
    ?? "http://localhost:4566/post-3mrai-local-post-assets";
builder.Services.AddScoped(sp => new ProductReadService(
    sp.GetRequiredService<OrdersReadDbContext>(),
    assetsBaseUrl,
    sp.GetRequiredService<IWorkflowTracer>(),
    sp.GetRequiredService<ILogger<ProductReadService>>()));

// Write side (write replica in prod; same MySQL locally).
var writerCs = builder.Configuration["DATABASE_WRITER_URL"]!;
builder.Services.AddDbContext<OrdersWriteDbContext>(o =>
    o.UseMySql(writerCs, ServerVersion.AutoDetect(writerCs)));

// Users gRPC client for identity resolution. One channel per process (Singleton);
// the adapter attaches the shared x-api-key on every call.
var grpcAddress = builder.Configuration["USERS_GRPC_URL"]!;   // e.g. http://users:50051
var grpcApiKey = builder.Configuration["GRPC_API_KEY"]!;
builder.Services.AddSingleton(_ =>
    new Users.V1.Users.UsersClient(Grpc.Net.Client.GrpcChannel.ForAddress(grpcAddress)));
builder.Services.AddScoped<IUserDirectory>(sp =>
    new UserDirectoryGrpcClient(sp.GetRequiredService<Users.V1.Users.UsersClient>(), grpcApiKey));

// ORDER_CREATED emission — real SQS publisher. The queue URL comes from this
// service's own generated env file (never hardcoded), like every other setting
// above; see [[env-files]].
//
// NoopEventPublisher is deliberately NOT deleted: tests that must not emit
// register it in place of this.
// Fail fast rather than `!`. A null-forgiving assertion would let the service
// boot with a null queue URL and fail at the first publish — which the
// publisher swallows by design, so the only symptom would be that no order
// ever produces a confirmation email, silently. Users does the same with Zod.
//
// Exempt during OpenAPI generation: `dotnet build` runs this very Program
// through GetDocument.Insider to emit openapi.yaml (§2a), with no env file
// loaded, so throwing there would break the build for every developer rather
// than catching a misconfigured runtime. Same entry-assembly test the
// e2e-cleanup route uses below.
var isDocumentGeneration =
    System.Reflection.Assembly.GetEntryAssembly()?.GetName().Name == "GetDocument.Insider";
var eventsQueueUrl = builder.Configuration["EVENTS_QUEUE_URL"]
    ?? (isDocumentGeneration
        ? string.Empty
        : throw new InvalidOperationException(
            "EVENTS_QUEUE_URL is not set. It is generated into .env.local.orders by "
            + "`make env-file`; see docs/shared/conventions/env-files.md."));
// One SQS client per process (Singleton) — it owns an HTTP connection pool, so a
// per-request client would build and discard one on every order.
builder.Services.AddSingleton<IAmazonSQS>(_ =>
{
    var config = new AmazonSQSConfig
    {
        // Region must be set explicitly: locally there is no EC2/ECS metadata to
        // infer one from, and the SDK throws rather than defaulting.
        RegionEndpoint = Amazon.RegionEndpoint.GetBySystemName(
            builder.Configuration["AWS_REGION"] ?? "us-east-1"),
    };

    // Only set locally (Floci); in AWS the variable is absent and the SDK resolves
    // the real regional endpoint itself.
    var endpointUrl = builder.Configuration["AWS_ENDPOINT_URL"];
    if (!string.IsNullOrWhiteSpace(endpointUrl))
    {
        config.ServiceURL = endpointUrl;
    }

    return new AmazonSQSClient(config);
});
builder.Services.AddScoped<IEventPublisher>(sp => new SqsEventPublisher(
    sp.GetRequiredService<IAmazonSQS>(),
    eventsQueueUrl,
    sp.GetRequiredService<ILogger<SqsEventPublisher>>()));

// Custom business metrics -> CloudWatch (Floci locally), scraped by the OTel
// collector into OpenObserve. One client per process (Singleton), same
// endpoint-override pattern as the SQS client above.
builder.Services.AddSingleton<IAmazonCloudWatch>(_ =>
{
    var config = new AmazonCloudWatchConfig
    {
        RegionEndpoint = Amazon.RegionEndpoint.GetBySystemName(
            builder.Configuration["AWS_REGION"] ?? "us-east-1"),
    };
    var endpointUrl = builder.Configuration["AWS_ENDPOINT_URL"];
    if (!string.IsNullOrWhiteSpace(endpointUrl))
    {
        config.ServiceURL = endpointUrl;
    }
    return new AmazonCloudWatchClient(config);
});

builder.Services.AddSingleton<IMetricsPublisher>(sp => new CloudWatchMetricsPublisher(
    sp.GetRequiredService<IAmazonCloudWatch>(),
    sp.GetRequiredService<ILogger<CloudWatchMetricsPublisher>>()));

// Skipped during build-time OpenAPI generation: GetDocument.Insider builds the app
// to read its endpoint metadata, and a hosted service would start a real timer and
// hit a database that is not there.
if (!isDocumentGeneration)
{
    builder.Services.AddHostedService<OrdersMetricsPublisher>();
}

// Tracking HTTP client (POST /v1/trackings/init-tracking). Typed client so the
// base address and timeout are configured once, in the composition root, and
// HttpClientFactory owns handler lifetime/pooling. AddHttpClientInstrumentation
// above already makes each call a child span of the incoming request.
//
// TIMEOUT: 5 seconds. This call sits on the order-creation path, so an unbounded
// wait would let a hung Tracking service pin an Orders request (and its DB
// connection) indefinitely — the classic way one slow dependency exhausts the
// pool of a healthy service. 5s is comfortably above a normal same-network round
// trip yet short enough that a stalled downstream degrades order creation by
// seconds rather than stalling it; on expiry the client returns Unreachable and
// the order still succeeds.
var trackingBaseUrl = builder.Configuration["TRACKING_BASE_URL"]!;   // e.g. http://tracking:8000
builder.Services.AddHttpClient<ITrackingInitiator, TrackingHttpClient>(client =>
{
    // Trailing slash matters: without it, Uri resolution against a relative path
    // would drop the last base-path segment.
    client.BaseAddress = new Uri(trackingBaseUrl.TrimEnd('/') + "/");
    client.Timeout = TimeSpan.FromSeconds(5);
});

// The same typed client also serves the read port. Resolved through
// ITrackingInitiator rather than registered as a second AddHttpClient so both ports
// share one HttpMessageHandler — registering it twice would build a separate handler
// pool for what is one service and one base address.
builder.Services.AddScoped<ITrackingReader>(sp =>
    (TrackingHttpClient)sp.GetRequiredService<ITrackingInitiator>());

// Request-scoped caller context, populated by CallerContextMiddleware from
// x-user-id. Replaces the old per-endpoint CallerIdentity.CognitoSub(ctx) reads.
builder.Services.AddScoped<ICurrentCaller, CurrentCaller>();

// OpenAPI 3.1 document (imported into Datadog). Document name "v1" so the
// build-time generator (Microsoft.Extensions.ApiDescription.Server) emits a clean
// `openapi.json`; the csproj then converts it to services/orders/openapi.yaml.
// A document transformer stamps a stable title/version.
builder.Services.AddOpenApi("v1", options =>
{
    options.OpenApiVersion = Microsoft.OpenApi.OpenApiSpecVersion.OpenApi3_1;
    options.AddDocumentTransformer((document, _, _) =>
    {
        document.Info.Title = "Orders Service API";
        // "1.0.0", not the document NAME "v1": this is the API's version and the
        // three services state it identically (see the openapi-specs convention).
        // The document name stays "v1" — it is what makes the generator emit a
        // clean `openapi.json`, and it is a different thing entirely.
        document.Info.Version = "1.0.0";
        document.Info.Description =
            "HTTP API for the 3MRAI Orders microservice (.NET Minimal APIs + Aurora "
            + "MySQL). Identity is enforced at the API Gateway authorizer, which "
            + "forwards the Cognito subject as the x-user-id header.";
        // The local base URL, at parity with Users (3000) and Tracking (3002).
        // Without it a consumer importing this file has no host to send to.
        document.Servers =
        [
            new Microsoft.OpenApi.OpenApiServer
            {
                Url = "http://localhost:3001",
                Description = "Local (docker compose / Floci)",
            },
        ];
        return Task.CompletedTask;
    });
});

// Tax rate now lives in the `configuration` table, read per-request via the read
// DbContext instead of the removed ORDERS_TAX_RATE env var.
builder.Services.AddScoped<IConfigurationReader, ConfigurationReader>();
// Singleton: it holds no per-request state at all — the Activity it works on is
// the ambient Activity.Current, which .NET already scopes per async flow.
builder.Services.AddSingleton<IWorkflowTracer, WorkflowTracer>();
builder.Services.AddScoped(sp => new CreateOrderService(
    sp.GetRequiredService<OrdersWriteDbContext>(),
    sp.GetRequiredService<IUserDirectory>(),
    sp.GetRequiredService<IEventPublisher>(),
    sp.GetRequiredService<IConfigurationReader>(),
    sp.GetRequiredService<ITrackingInitiator>(),
    sp.GetRequiredService<IWorkflowTracer>(),
    sp.GetRequiredService<ILogger<CreateOrderService>>()));

var app = builder.Build();

// Opens the correlation scope FIRST, ahead of the request logger below. The id
// itself is resolved later, by CallerContextMiddleware (which needs routing to
// have run); this only installs the cell that middleware writes into.
//
// The two steps are split for a reason found by a failing test: an AsyncLocal set
// in a middleware is invisible OUTSIDE it, because the value is restored as each
// frame unwinds. UseSerilogRequestLogging writes "request completed" on the way
// back OUT — after CallerContextMiddleware's frame is gone — so with a single
// write deeper down, the most useful log line this service emits would have been
// the one line missing request_id. Opening the scope here, outside everything,
// is what lets the outer frame read the value the inner one resolved.
app.Use(async (_, next) =>
{
    AmbientRequestId.Begin();
    await next();
});

// Automatic HTTP request logging in the shared snake_case schema. Placed early
// in the pipeline (right after Build) so it wraps every request. The elapsed
// time Serilog attaches internally (`Elapsed`) is renamed to `duration_ms` by
// SchemaLogFormatter; the fields set here become top-level JSON keys.
app.UseSerilogRequestLogging(options =>
{
    options.MessageTemplate = "request completed";
    // The liveness probe is exempt WHILE IT SUCCEEDS — see the
    // health-check-logging convention. A succeeding probe is the one request
    // whose log line carries nothing: the container being up already says it,
    // and its duration is a constant. A FAILING one carries the status and the
    // latency that explain why, so it keeps the normal level and is logged.
    //
    // Verbose rather than a hard suppression: this service's minimum level is
    // Information, so the line is filtered out before it reaches the sink, but
    // the record still exists for anyone who lowers the level to debug a probe.
    // Serilog's own error paths are preserved — `ex != null` and 5xx fall
    // through to the default, so a probe that throws still logs at Error.
    // The `: 500 -> Error` arm reproduces Serilog's own default, which assigning
    // GetLevel replaces wholesale. Returning a flat Information would have
    // quietly DOWNGRADED every server error on the request log — a regression
    // introduced by a change meant to remove noise.
    options.GetLevel = (http, _, ex) =>
        ex == null
        && http.Response.StatusCode is >= 200 and < 300
        && (http.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText == PublicRoutes.HealthRoute
            ? Serilog.Events.LogEventLevel.Verbose
            : ex != null || http.Response.StatusCode >= 500
                ? Serilog.Events.LogEventLevel.Error
                : Serilog.Events.LogEventLevel.Information;
    options.EnrichDiagnosticContext = (diag, http) =>
    {
        diag.Set("http_request_method", http.Request.Method);
        diag.Set(
            "http_route",
            (http.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText ?? http.Request.Path.Value);
        diag.Set("http_response_status_code", http.Response.StatusCode);
        // NO trace_id here. LogContextEnricher supplies the real OTel trace id
        // from Activity.Current; it uses AddPropertyIfAbsent, so a value set on
        // the diagnostic context would win and the request log — the single most
        // useful line — would keep ASP.NET's local, non-propagating identifier.
    };
});

// Publishes http_errors_total for every 4xx/5xx. Placed immediately after the
// request logger, and therefore OUTSIDE everything below it, so it observes the
// final status of the completed response — including CallerContextMiddleware's
// short-circuiting 401 and every per-endpoint result.
app.UseMiddleware<HttpErrorMetricsMiddleware>();

// Explicit UseRouting() so endpoint resolution happens BEFORE
// CallerContextMiddleware runs. ctx.GetEndpoint() (used by the middleware and by
// PublicRoutes.IsPublic to recognize GET /v1/health) is only populated once
// routing has matched a request to an endpoint; without this explicit call the
// middleware could run ahead of endpoint resolution and see a null route,
// breaking the public-route allowlist.
app.UseRouting();

// Resolves the caller from x-user-id and 401s any non-public route with no
// header, else sets the sub on the scoped ICurrentCaller for the endpoint to use.
app.UseMiddleware<CallerContextMiddleware>();

// Local bootstrap: apply migrations + seed the Product catalog and baseline
// configuration (tax_rate) on startup when
// SEED_ON_STARTUP is set (compose sets it locally). Chosen over a Makefile
// migrate step because no Aurora-MySQL cluster is provisioned in infra yet — the
// service owns its schema locally. Never enabled in prod (migrations run via a
// dedicated step there).
if (app.Configuration.GetValue<bool>("SEED_ON_STARTUP"))
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<OrdersWriteDbContext>();
    await db.Database.MigrateAsync();
    await ProductSeed.ApplyAsync(db);
    await ConfigurationSeed.ApplyAsync(db);
}

// Serve the OpenAPI document at runtime in Development only
// (GET /openapi/openapi.yaml). The committed artifact is the build-time file.
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi("/openapi/{documentName}.yaml");
}

app.MapOrderEndpoints();
app.MapProductEndpoints();

// E2E cleanup surface — only when explicitly enabled (local/CI), never in prod.
// Also mapped during build-time OpenAPI generation (entry assembly
// GetDocument.Insider) so the committed openapi.yaml documents this route without
// exposing it in a production runtime.
if (app.Configuration.GetValue<bool>("E2E_TESTING_ENABLED") || IsOpenApiGeneration())
{
    app.MapE2eEndpoints();
}

app.Run();

// True when the host is started by Microsoft.Extensions.ApiDescription.Server's
// build-time document generator rather than a real HTTP run.
static bool IsOpenApiGeneration() =>
    System.Reflection.Assembly.GetEntryAssembly()?.GetName().Name == "GetDocument.Insider";

public partial class Program { }  // for WebApplicationFactory in tests
