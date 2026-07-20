using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Orders.Api.Endpoints;
using Orders.Api.Identity;
using Orders.Api.Logging;
using Orders.Api.Middleware;
using Orders.Application.Abstractions;
using Orders.Application.Identity;
using Orders.Infrastructure.Config;
using Orders.Infrastructure.Grpc;
using Orders.Infrastructure.Messaging;
using Orders.Infrastructure.Orders;
using Orders.Infrastructure.Persistence;
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
builder.Host.UseSerilog((_, services, cfg) => cfg
    .MinimumLevel.Information()
    .Enrich.With(new LogContextEnricher(services.GetRequiredService<IHttpContextAccessor>()))
    .WriteTo.Console(new SchemaLogFormatter("orders", deploymentEnvironment)));

// Read side (read replica in prod; same MySQL locally). ADO connection string.
var readerCs = builder.Configuration["DATABASE_READER_URL"]!;
builder.Services.AddDbContext<OrdersReadDbContext>(o =>
    o.UseMySql(readerCs, ServerVersion.AutoDetect(readerCs)));
builder.Services.AddScoped<OrderReadService>();
builder.Services.AddScoped<ProductReadService>();

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

// ORDER_CREATED emission seam (SQS deferred).
builder.Services.AddScoped<IEventPublisher, NoopEventPublisher>();

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
        document.Info.Version = "v1";
        return Task.CompletedTask;
    });
});

// Tax rate now lives in the `configuration` table, read per-request via the read
// DbContext instead of the removed ORDERS_TAX_RATE env var.
builder.Services.AddScoped<IConfigurationReader, ConfigurationReader>();
builder.Services.AddScoped(sp => new CreateOrderService(
    sp.GetRequiredService<OrdersWriteDbContext>(),
    sp.GetRequiredService<IUserDirectory>(),
    sp.GetRequiredService<IEventPublisher>(),
    sp.GetRequiredService<IConfigurationReader>(),
    sp.GetRequiredService<ILogger<CreateOrderService>>()));

var app = builder.Build();

// Automatic HTTP request logging in the shared snake_case schema. Placed early
// in the pipeline (right after Build) so it wraps every request. The elapsed
// time Serilog attaches internally (`Elapsed`) is renamed to `duration_ms` by
// SchemaLogFormatter; the fields set here become top-level JSON keys.
app.UseSerilogRequestLogging(options =>
{
    options.MessageTemplate = "request completed";
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
