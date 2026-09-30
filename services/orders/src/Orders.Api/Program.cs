using Amazon.CloudWatch;
using Amazon.SimpleNotificationService;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Orders.Api.BackgroundServices;
using Orders.Api.Endpoints;
using Orders.Api.Identity;
using Orders.Api.Logging;
using Orders.Api.Middleware;
using Orders.Api.Payments;
using Orders.Application.Abstractions;
using Orders.Application.Messaging;
using Orders.Application.Identity;
using Orders.Application.Payments;
using Orders.Application.Tracking;
using Orders.Infrastructure.Bus;
using Orders.Infrastructure.Caching;
using Orders.Infrastructure.Carts;
using Orders.Infrastructure.Config;
using Orders.Infrastructure.Grpc;
using Orders.Infrastructure.Id;
using Orders.Infrastructure.Identity;
using Orders.Infrastructure.Messaging;
using Orders.Infrastructure.Metrics;
using Orders.Infrastructure.Observability;
using Orders.Infrastructure.Orders;
using Orders.Infrastructure.Orders.Handlers;
using Orders.Infrastructure.Payments;
using Orders.Infrastructure.Persistence;
using Orders.Infrastructure.Tracking;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using Serilog;
using StackExchange.Redis;
using Stripe;
using Wolverine;

var builder = WebApplication.CreateBuilder(args);

// Declared up front: both the tracing resource and the Serilog formatter below
// stamp it, so they cannot disagree about which environment this process is.
var deploymentEnvironment = builder.Configuration["DEPLOYMENT_ENVIRONMENT"] ?? "local";

// Needed by LogContextEnricher to reach the request-scoped ICurrentCaller.
builder.Services.AddHttpContextAccessor();

// CONTRACT: Keep AddHttpClientInstrumentation — .NET's gRPC client rides on HttpClient, so
// this is what injects traceparent and makes the Orders -> Users call a CHILD span rather
// than an unrelated trace. The dedicated GrpcNetClient package is prerelease and unneeded.
// See [[ADR-0019-distributed-tracing-opentelemetry]]
builder.Services.AddOpenTelemetry()
    .ConfigureResource(resource => resource
        .AddService(serviceName: "orders")
        .AddAttributes([
            new KeyValuePair<string, object>("deployment.environment.name", deploymentEnvironment),
        ]))
    .WithTracing(tracing => tracing
        // CONTRACT: Keep this enrich hook — the Stripe webhook's path carries its URL token, a
        // secret, and url.path would otherwise export it verbatim.
        // See [[2026-09-19-stripe-payments-design]]
        .AddAspNetCoreInstrumentation(options =>
            options.EnrichWithHttpRequest = StripeWebhookEndpoints.RedactSpan)
        .AddHttpClientInstrumentation()
        .AddEntityFrameworkCoreInstrumentation()
        // What makes SnsEventPublisher's PublishAsync produce a CLIENT span.
        .AddAWSInstrumentation()
        // CONTRACT: Do NOT create an ActivitySource without registering it here — .NET drops
        // unregistered sources silently; the Activity is built but never exported to OpenObserve.
        // Register the source in the SAME change that creates one.
        .AddSource(WorkflowTracer.ActivitySourceName)
        // SNS publish span; its context travels as the message traceparent.
        .AddSource(SnsEventPublisher.ActivitySourceName)
        // CloudWatch PutMetricData span.
        .AddSource(CloudWatchMetricsPublisher.ActivitySourceName)
        // Redis cache.get / cache.set spans.
        .AddSource(CacheGateway.ActivitySourceName)
        // Outbound Stripe calls.
        .AddSource(StripeActivitySource.Name)
        // CONTRACT: Do NOT set OtlpExporter Endpoint in code — hand-built URLs POST to the collector
        // root and return 404 silently; the SDK reads OTEL_EXPORTER_OTLP_ENDPOINT instead.
        // See [[logging-context]]
        .AddOtlpExporter());

// Structured JSON logging (snake_case OTel-aligned schema).
// CONTRACT: Use the THREE-argument UseSerilog overload — the two-arg one has no `services`
// parameter, so LogContextEnricher cannot resolve IHttpContextAccessor.
// WHY: No ReadFrom.Configuration here; appsettings Logging:LogLevel silences nothing.
// WARNING: Overrides are WARNING, not None — a failed trace export still surfaces.
// Four categories at WARNING (OtlpTraceExporter self-chatter, Hosting.Diagnostics,
// EndpointMiddleware, Http.Result); RequestLoggingMiddleware and EF Database.Command are NOT.
// See [[logging-context]]
builder.Host.UseSerilog((_, services, cfg) => cfg
    .MinimumLevel.Information()
    .MinimumLevel.Override("System.Net.Http.HttpClient.OtlpTraceExporter", Serilog.Events.LogEventLevel.Warning)
    .MinimumLevel.Override("Microsoft.AspNetCore.Hosting.Diagnostics", Serilog.Events.LogEventLevel.Warning)
    .MinimumLevel.Override("Microsoft.AspNetCore.Routing.EndpointMiddleware", Serilog.Events.LogEventLevel.Warning)
    .MinimumLevel.Override("Microsoft.AspNetCore.Http.Result", Serilog.Events.LogEventLevel.Warning)
    .Enrich.With(new LogContextEnricher(services.GetRequiredService<IHttpContextAccessor>()))
    .Enrich.With(new RequestPathRedactionEnricher())
    .WriteTo.Console(new SchemaLogFormatter("orders", deploymentEnvironment)));

// Read side (read replica in prod; same MySQL locally). ADO connection string.
var readerCs = builder.Configuration["DATABASE_READER_URL"]!;
builder.Services.AddDbContext<OrdersReadDbContext>(o =>
    o.UseMySql(readerCs, ServerVersion.AutoDetect(readerCs)));
// WORKAROUND(local): Do NOT throw or use `!` on ASSETS_BASE_URL — GetDocument.Insider boots with no
// env file and breaks `dotnet build`; a missing value on first request returns 500 on GET /v1/products.
// Fall back to the derived local bucket URL.
// See [[env-files]]
var assetsBaseUrl = builder.Configuration["ASSETS_BASE_URL"]
    ?? "http://localhost:4566/post-3mrai-local-post-assets";
// Registered here, not above with the other read services: it needs assetsBaseUrl, which
// is only in scope from this point on.
builder.Services.AddScoped(sp => new OrderReadService(
    sp.GetRequiredService<OrdersReadDbContext>(),
    sp.GetRequiredService<IWorkflowTracer>(),
    assetsBaseUrl,
    sp.GetRequiredService<ILogger<OrderReadService>>()));
builder.Services.AddScoped(sp => new ProductReadService(
    sp.GetRequiredService<OrdersReadDbContext>(),
    assetsBaseUrl,
    sp.GetRequiredService<IWorkflowTracer>(),
    sp.GetRequiredService<ILogger<ProductReadService>>()));
builder.Services.AddScoped(sp => new CartReadService(
    sp.GetRequiredService<OrdersReadDbContext>(),
    sp.GetRequiredService<IConfigurationReader>(),
    sp.GetRequiredService<IWorkflowTracer>(),
    sp.GetRequiredService<ILogger<CartReadService>>(),
    assetsBaseUrl));
builder.Services.AddScoped<CartWriteService>();
builder.Services.AddScoped<InvalidateOrderCacheService>();
builder.Services.AddScoped<DeleteOrdersByUserService>();

// Write side (write replica in prod; same MySQL locally).
var writerCs = builder.Configuration["DATABASE_WRITER_URL"]!;
builder.Services.AddDbContext<OrdersWriteDbContext>(o =>
    o.UseMySql(writerCs, ServerVersion.AutoDetect(writerCs)));

// True when the host is booted by Microsoft.Extensions.ApiDescription.Server's
// build-time document generator (`dotnet build` -> openapi.yaml, §2a) rather than
// by a real HTTP run. Declared HERE, ahead of the first setting that needs an
// escape hatch, because several blocks below must not fail-fast on a missing env
// var during generation: no env file is in scope there, so a throw would break
// `dotnet build` for every developer instead of catching a misconfigured runtime.
var isDocumentGeneration =
    System.Reflection.Assembly.GetEntryAssembly()?.GetName().Name == "GetDocument.Insider";

// Response cache (Redis/Valkey). When CACHE_ENABLED=false NOTHING is registered,
// so CachedReadFilter resolves ICacheGateway as null and skips itself entirely —
// no Redis call and no X-Cache header at all, which is the documented contract of
// the kill switch (a disabled cache is invisible, not a permanent BYPASS).
var cacheEnabled = builder.Configuration.GetValue("CACHE_ENABLED", true);
if (cacheEnabled)
{
    // REDIS_HOST is the Floci backing-container name on the Docker network, never
    // "localhost" — inside this container localhost is orders itself. Same
    // fail-fast-with-a-generation-escape shape as EVENTS_TOPIC_ARN below.
    var redisHost = builder.Configuration["REDIS_HOST"]
        ?? (isDocumentGeneration
            ? "localhost"
            : throw new InvalidOperationException(
                "REDIS_HOST is not set. It is generated into .env.local.orders by "
                + "`make env-file`; see docs/shared/conventions/env-files.md."));
    var redisPort = builder.Configuration.GetValue("REDIS_PORT", 6379);

    // WHY: AsyncTimeout on the multiplexer — IDatabaseAsync has no CancellationToken; WaitAsync
    // abandons the await but leaves commands in flight until Redis's 5000ms default.
    const int redisTimeoutMs = 50;

    builder.Services.AddSingleton<IConnectionMultiplexer>(_ =>
        ConnectionMultiplexer.Connect(new ConfigurationOptions
        {
            EndPoints = { { redisHost, redisPort } },
            // A cold or absent Redis must not stop the service booting: the cache is
            // fail-open, so "cannot connect" is a BYPASS on every read, not an outage.
            AbortOnConnectFail = false,
            ConnectTimeout = 1000,
            AsyncTimeout = redisTimeoutMs,
            SyncTimeout = redisTimeoutMs,
        }));
    builder.Services.AddSingleton<ICacheGateway>(sp => new CacheGateway(
        sp.GetRequiredService<IConnectionMultiplexer>().GetDatabase(),
        sp.GetRequiredService<IMetricsPublisher>(),
        sp.GetRequiredService<ILogger<CacheGateway>>()));
    // Singleton to match the gateway it wraps: it holds no per-request state, and a
    // scoped registration over a singleton dependency would only add allocations.
    builder.Services.AddSingleton<ICacheInvalidator>(sp => new CacheInvalidator(
        sp.GetRequiredService<ICacheGateway>(),
        sp.GetRequiredService<ILogger<CacheInvalidator>>()));
}
else
{
    // The write services depend on ICacheInvalidator unconditionally, so the kill switch
    // must still leave one registered — otherwise CACHE_ENABLED=false takes the service
    // down at the first cart write rather than merely disabling the cache. Nothing is
    // cached in this mode, so the no-op is the honest answer.
    builder.Services.AddSingleton<ICacheInvalidator, NoopCacheInvalidator>();
}

// Users gRPC client for identity resolution. One channel per process (Singleton);
// the adapter attaches the shared x-api-key on every call.
var grpcAddress = builder.Configuration["USERS_GRPC_URL"]!;   // e.g. http://users:50051
var internalApiKey = builder.Configuration["INTERNAL_API_KEY"]!;
builder.Services.AddSingleton(_ =>
    new Users.V1.Users.UsersClient(Grpc.Net.Client.GrpcChannel.ForAddress(grpcAddress)));
// ONE registration, decorated inside the factory rather than layered as a second
// AddScoped<IUserDirectory>. Registering twice would leave two descriptors for this
// service type, and the test factories replace the directory via
// `services.Single(d => d.ServiceType == typeof(IUserDirectory))` — which throws on
// two matches, breaking every endpoint test rather than the cache.
builder.Services.AddScoped<IUserDirectory>(sp =>
{
    var grpc = new UserDirectoryGrpcClient(
        sp.GetRequiredService<Users.V1.Users.UsersClient>(), internalApiKey);

    // The identity cache sits IN FRONT of the response cache: every per-user key
    // carries user_id, so this resolution runs before a response key can be built —
    // on cache hits too. Without it a hit would still pay a gRPC round trip.
    var cache = sp.GetService<ICacheGateway>();
    return cache is null ? grpc : new CachedUserDirectory(grpc, cache);
});

// CONTRACT: One StripeClient instance per process — never the global StripeConfiguration.ApiKey.
// The API version (2026-08-26.dahlia) is pinned by the Stripe.net 52.4.0 package itself.
// WARNING: STRIPE_ENABLED with no STRIPE_SECRET_KEY still boots — charges answer 503 instead.
// See [[2026-09-19-stripe-payments-design]]
var stripeEnabled = builder.Configuration.GetValue("STRIPE_ENABLED", false);
var stripeSecretKey = builder.Configuration["STRIPE_SECRET_KEY"];
var stripeKeyMissing = stripeEnabled && string.IsNullOrWhiteSpace(stripeSecretKey);
builder.Services.AddSingleton(new StripeSettings(stripeEnabled));
if (stripeEnabled && !stripeKeyMissing)
{
    builder.Services.AddSingleton<IStripeClient>(_ => new StripeClient(stripeSecretKey));
}
builder.Services.AddSingleton(sp => new StripePaymentCharger(
    sp.GetService<IStripeClient>(),
    sp.GetRequiredService<ILogger<StripePaymentCharger>>()));

// WARNING: STRIPE_ENABLED with no STRIPE_WEBHOOK_SECRET still boots — the webhook answers 503.
var stripeWebhookSecret = builder.Configuration["STRIPE_WEBHOOK_SECRET"];
var stripeWebhookSecretMissing = stripeEnabled && string.IsNullOrWhiteSpace(stripeWebhookSecret);
builder.Services.AddSingleton(new StripeWebhookSettings(
    string.IsNullOrWhiteSpace(stripeWebhookSecret) ? null : stripeWebhookSecret,
    TimeSpan.FromSeconds(builder.Configuration.GetValue(
        "STRIPE_ORPHAN_GRACE_PERIOD_SECONDS", StripeWebhookSettings.DefaultOrphanGracePeriodSeconds))));
// WARNING: STRIPE_ENABLED with no URL token or no valid allowlist still boots — the webhook answers 503.
var stripeWebhookAccess = StripeWebhookAccess.FromConfiguration(
    builder.Configuration, out var stripeWebhookAccessProblems);
builder.Services.AddSingleton(stripeWebhookAccess);
builder.Services.AddScoped(sp => new StripeWebhookService(
    sp.GetRequiredService<OrdersWriteDbContext>(),
    sp.GetRequiredService<StripePaymentCharger>(),
    sp.GetService<IStripeClient>() is not null,
    sp.GetRequiredService<StripeWebhookSettings>(),
    sp.GetRequiredService<IWorkflowTracer>(),
    sp.GetRequiredService<ILogger<StripeWebhookService>>()));

// CONTRACT: Fail fast on missing EVENTS_TOPIC_ARN — a null ARN boots silently and the publisher
// swallows publish failures, so no confirmation email is ever sent.
// WORKAROUND(local): Exempt during GetDocument.Insider — no env file at `dotnet build` time.
// See [[env-files]]
var eventsTopicArn = builder.Configuration["EVENTS_TOPIC_ARN"]
    ?? (isDocumentGeneration
        ? string.Empty
        : throw new InvalidOperationException(
            "EVENTS_TOPIC_ARN is not set. It is generated into .env.local.orders by "
            + "`make env-file`; see docs/shared/conventions/env-files.md."));
// One SNS client per process (Singleton) — it owns an HTTP connection pool, so a
// per-request client would build and discard one on every order.
builder.Services.AddSingleton<IAmazonSimpleNotificationService>(_ =>
{
    var config = new AmazonSimpleNotificationServiceConfig
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

    return new AmazonSimpleNotificationServiceClient(config);
});
builder.Services.AddScoped<IEventPublisher>(sp => new SnsEventPublisher(
    sp.GetRequiredService<IAmazonSimpleNotificationService>(),
    eventsTopicArn,
    sp.GetRequiredService<ILogger<SnsEventPublisher>>()));

// Custom business metrics -> CloudWatch (Floci locally), scraped by the OTel
// collector into OpenObserve. One client per process (Singleton), same
// endpoint-override pattern as the SNS client above.
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

// WHY: 5s timeout on order-creation path — an unbounded Tracking wait pins DB connections.
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
    sp.GetRequiredService<ICacheInvalidator>(),
    assetsBaseUrl,
    sp.GetRequiredService<ILogger<CreateOrderService>>(),
    sp.GetRequiredService<StripeSettings>(),
    sp.GetRequiredService<StripePaymentCharger>()));

// CQRS dispatch bus. The four behaviors are registered ONCE here, in the pipeline order the
// design commits to: tracing -> app_event -> logging -> validation -> handler. Wolverine's
// model is Russian-doll, so registration order IS the nesting order — the first registered
// wraps the rest, and its Finally runs last.
// CONTRACT: ONE type per ForMessagesOfType<T>() call. A second AddMiddleware on that same
// filter is silently DROPPED — no error, no warning, and the behavior simply never runs. Only
// the tracing step needs the filter (it binds IFlowMessage, which a global registration cannot
// resolve); the three inside it bind FlowScope, which tracing's Before supplies, so they
// register globally and compose in call order.
// See [[cqrs]] and [[logging-context]]
builder.Host.UseWolverine(opts =>
{
    // The handlers live in Infrastructure (they touch a DbContext), so discovery must be
    // pointed at that assembly — the entry assembly is Orders.Api and holds none of them.
    opts.Discovery.IncludeAssembly(typeof(GetMyOrdersHandler).Assembly);

    // CONTRACT: Opt these named types into service location, and keep the list minimal.
    // Wolverine's codegen inline-constructs a handler's dependencies and REFUSES an 'opaque'
    // lambda factory under the default NotAllowed policy — it throws
    // InvalidServiceLocationException at the FIRST dispatch, not at startup, so the app boots
    // clean and the route 500s. Two registrations here genuinely are such factories:
    // OrderReadService takes assetsBaseUrl, a value not in the container, and AddDbContext
    // registers DbContextOptions<T> through EF Core's own factory. Opt in per type rather than
    // relaxing ServiceLocationPolicy globally, which would also cover services Wolverine could
    // have injected properly. See [[cqrs]]
    opts.CodeGeneration.AlwaysUseServiceLocationFor<OrderReadService>();
    opts.CodeGeneration.AlwaysUseServiceLocationFor<OrdersReadDbContext>();

    opts.Policies.ForMessagesOfType<IFlowMessage>().AddMiddleware(typeof(WorkflowSpanMiddleware));
    opts.Policies.AddMiddleware(typeof(AppEventMiddleware));
    opts.Policies.AddMiddleware(typeof(FlowLoggingMiddleware));
    opts.Policies.AddMiddleware(typeof(FlowValidationMiddleware));

    // CONTRACT: No PersistMessagesWith*, no durability and no outbox — Phase 1 is pure
    // in-memory dispatch and touches no database. A persistence call here would have Wolverine
    // create its own schema at startup, which is Phase 2's decision, not this one.
    // See [[cqrs]]
});

var app = builder.Build();

if (stripeKeyMissing && !isDocumentGeneration)
{
    app.Logger.LogWarning(
        "STRIPE_ENABLED is true but STRIPE_SECRET_KEY is not set. Order creation will answer 503.");
}

if (stripeWebhookSecretMissing && !isDocumentGeneration)
{
    app.Logger.LogWarning(
        "STRIPE_ENABLED is true but STRIPE_WEBHOOK_SECRET is not set. The Stripe webhook will answer 503.");
}

if (stripeEnabled && !isDocumentGeneration)
{
    foreach (var problem in stripeWebhookAccessProblems)
    {
        app.Logger.LogWarning("STRIPE_ENABLED is true but {problem}. The Stripe webhook will answer 503.", problem);
    }
}

// WHY: Open AmbientRequestId here — UseSerilogRequestLogging runs on unwind after inner
// middleware, so a scope opened deeper would drop request_id from "request completed".
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
    // WHY: Verbose for succeeding health probes — see [[health-check-logging]].
    // CONTRACT: Do NOT return flat Information on 5xx — GetLevel replaces Serilog's default entirely.
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
            (http.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText
                ?? StripeWebhookEndpoints.RedactPath(http.Request.Path.Value));
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
app.MapCartEndpoints();
// Internal service-to-service surface. Always mapped — unlike the E2E routes this
// is a production path (Users' account-deletion cascade calls it), and it is kept
// off the API Gateway rather than behind a flag.
app.MapInternalEndpoints();

// E2E cleanup surface — only when explicitly enabled (local/CI), never in prod.
// Also mapped during build-time OpenAPI generation (entry assembly
// GetDocument.Insider) so the committed openapi.yaml documents this route without
// exposing it in a production runtime.
if (app.Configuration.GetValue<bool>("E2E_TESTING_ENABLED") || IsOpenApiGeneration())
{
    app.MapE2eEndpoints();
}

// CONTRACT: Stripe off means no Stripe route at all. Mapped during document generation too,
// so openapi.yaml documents it. See [[2026-09-19-stripe-payments-design]]
if (stripeEnabled || IsOpenApiGeneration())
{
    app.MapStripeWebhookEndpoints();
}

app.Run();

// True when the host is started by Microsoft.Extensions.ApiDescription.Server's
// build-time document generator rather than a real HTTP run.
static bool IsOpenApiGeneration() =>
    System.Reflection.Assembly.GetEntryAssembly()?.GetName().Name == "GetDocument.Insider";

public partial class Program { }  // for WebApplicationFactory in tests
