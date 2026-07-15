using Microsoft.EntityFrameworkCore;
using Orders.Api.Endpoints;
using Orders.Infrastructure.Orders;
using Orders.Infrastructure.Persistence;

var builder = WebApplication.CreateBuilder(args);

var readerCs = builder.Configuration["DATABASE_READER_URL"]!;
builder.Services.AddDbContext<OrdersReadDbContext>(o =>
    o.UseMySql(readerCs, ServerVersion.AutoDetect(readerCs)));
builder.Services.AddScoped<OrderReadService>();

var app = builder.Build();
app.MapOrderEndpoints();
app.Run();

public partial class Program { }  // for WebApplicationFactory in tests
