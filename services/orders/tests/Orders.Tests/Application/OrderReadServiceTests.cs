using System.Diagnostics;
using Microsoft.EntityFrameworkCore;
using Orders.Domain.Entities;
using Orders.Infrastructure.Observability;
using Orders.Infrastructure.Orders;
using Orders.Infrastructure.Persistence;
using Testcontainers.MySql;
using Xunit;

namespace Orders.Tests.Application;

public class OrderReadServiceTests : IAsyncLifetime
{
    private readonly MySqlContainer _mysql =
        new MySqlBuilder("mysql:8.0").WithDatabase("orders").Build();
    public Task InitializeAsync() => _mysql.StartAsync();
    public Task DisposeAsync() => _mysql.DisposeAsync().AsTask();

    private OrdersReadDbContext ReadCtx()
    {
        var cs = _mysql.GetConnectionString();
        return new OrdersReadDbContext(new DbContextOptionsBuilder<OrdersReadDbContext>()
            .UseMySql(cs, ServerVersion.AutoDetect(cs)).Options);
    }
    private OrdersWriteDbContext WriteCtx()
    {
        var cs = _mysql.GetConnectionString();
        return new OrdersWriteDbContext(new DbContextOptionsBuilder<OrdersWriteDbContext>()
            .UseMySql(cs, ServerVersion.AutoDetect(cs)).Options);
    }

    [Fact]
    public async Task GetById_returns_null_for_another_users_order()
    {
        await using (var w = WriteCtx())
        {
            await w.Database.MigrateAsync();
            w.Orders.Add(new Order { Id = "ord_test1", UserId = "usr_a", CognitoSub = "sub-a", CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow });
            await w.SaveChangesAsync();
        }
        await using var r = ReadCtx();
        // A real tracer, not a fake: with no ActivityListener registered here it
        // records nothing (see WorkflowTracerTests), so the read behaves exactly
        // as it did before the span was added — which is the point.
        var svc = new OrderReadService(r, new WorkflowTracer());
        Assert.Null(await svc.GetByIdAsync("ord_test1", "sub-b"));      // other user → null (→ 404)
        Assert.NotNull(await svc.GetByIdAsync("ord_test1", "sub-a"));   // owner → found
    }

    [Fact]
    public async Task GetMyOrders_emits_the_list_my_orders_workflow_span_with_the_result_count()
    {
        await using (var w = WriteCtx())
        {
            await w.Database.MigrateAsync();
            w.Orders.Add(new Order { Id = "ord_span1", UserId = "usr_s", CognitoSub = "sub-s", CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow });
            w.Orders.Add(new Order { Id = "ord_span2", UserId = "usr_s", CognitoSub = "sub-s", CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow });
            await w.SaveChangesAsync();
        }

        // Without a listener on this exact source the activity is null and nothing
        // is recorded — the same silent failure an unregistered AddSource(...) in
        // Program.cs would produce, which is why the source name is asserted here.
        var recorded = new List<Activity>();
        using var listener = new ActivityListener
        {
            ShouldListenTo = source => source.Name == WorkflowTracer.ActivitySourceName,
            Sample = (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllData,
            ActivityStopped = recorded.Add,
        };
        ActivitySource.AddActivityListener(listener);

        await using var r = ReadCtx();
        var orders = await new OrderReadService(r, new WorkflowTracer()).GetMyOrdersAsync("sub-s");

        Assert.Equal(2, orders.Count);
        var span = Assert.Single(recorded);
        Assert.Equal("list_my_orders", span.DisplayName);
        Assert.Equal(ActivityStatusCode.Ok, span.Status);
        // TagObjects, not Tags: Activity.Tags only surfaces tags whose value is a
        // string, and the count is set as an int on purpose (OTel's numeric
        // attribute type). Asserting on Tags here reported an empty collection
        // while the tag was in fact present.
        Assert.Contains(span.TagObjects, t => t.Key == "order_count" && (int?)t.Value == 2);
        // No route/method tag: the AspNetCore span above already carries those,
        // and duplicating them onto the workflow span is what this asserts against.
        Assert.DoesNotContain(span.TagObjects, t => t.Key == "http.method" || t.Key == "http.route");
        // Stopped, not merely started — a running activity never reaches Jaeger.
        Assert.NotEqual(default, span.Duration);
    }
}
