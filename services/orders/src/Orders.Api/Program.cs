using Microsoft.EntityFrameworkCore;
using Orders.Api.Endpoints;
using Orders.Application.Abstractions;
using Orders.Application.Identity;
using Orders.Infrastructure.Grpc;
using Orders.Infrastructure.Messaging;
using Orders.Infrastructure.Orders;
using Orders.Infrastructure.Persistence;

var builder = WebApplication.CreateBuilder(args);

// Read side (read replica in prod; same MySQL locally). ADO connection string.
var readerCs = builder.Configuration["DATABASE_READER_URL"]!;
builder.Services.AddDbContext<OrdersReadDbContext>(o =>
    o.UseMySql(readerCs, ServerVersion.AutoDetect(readerCs)));
builder.Services.AddScoped<OrderReadService>();

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

var taxRate = decimal.Parse(builder.Configuration["ORDERS_TAX_RATE"] ?? "0.08",
    System.Globalization.CultureInfo.InvariantCulture);
builder.Services.AddScoped(sp => new CreateOrderService(
    sp.GetRequiredService<OrdersWriteDbContext>(),
    sp.GetRequiredService<IUserDirectory>(),
    sp.GetRequiredService<IEventPublisher>(),
    taxRate));

var app = builder.Build();

// Local bootstrap: apply migrations + seed the Product catalog on startup when
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
}

app.MapOrderEndpoints();

// E2E cleanup surface — only when explicitly enabled (local/CI), never in prod.
if (app.Configuration.GetValue<bool>("E2E_TESTING_ENABLED"))
{
    app.MapE2eEndpoints();
}

app.Run();

public partial class Program { }  // for WebApplicationFactory in tests
