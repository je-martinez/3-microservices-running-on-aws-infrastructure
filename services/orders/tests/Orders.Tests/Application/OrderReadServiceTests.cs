using Microsoft.EntityFrameworkCore;
using Orders.Domain.Entities;
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
        var svc = new OrderReadService(r);
        Assert.Null(await svc.GetByIdAsync("ord_test1", "sub-b"));      // other user → null (→ 404)
        Assert.NotNull(await svc.GetByIdAsync("ord_test1", "sub-a"));   // owner → found
    }
}
