using Microsoft.EntityFrameworkCore;
using Orders.Domain.Entities;
using Orders.Infrastructure.Persistence;
using Xunit;

namespace Orders.Tests.Infrastructure;

public class EntityMappingTests
{
    private static OrdersWriteDbContext BuildContext()
    {
        var options = new DbContextOptionsBuilder<OrdersWriteDbContext>()
            .UseInMemoryDatabase("mapping-test")
            .Options;
        return new OrdersWriteDbContext(options);
    }

    [Fact]
    public void Order_maps_to_snake_case_table_and_cents_columns()
    {
        using var ctx = BuildContext();
        var entity = ctx.Model.FindEntityType(typeof(Order))!;
        Assert.Equal("order", entity.GetTableName());
        Assert.Equal("total_cents", entity.FindProperty(nameof(Order.TotalCents))!.GetColumnName());
        Assert.Equal("cognito_sub", entity.FindProperty(nameof(Order.CognitoSub))!.GetColumnName());
    }

    [Fact]
    public void Computed_dollar_properties_are_not_mapped()
    {
        using var ctx = BuildContext();
        var entity = ctx.Model.FindEntityType(typeof(Order))!;
        Assert.Null(entity.FindProperty(nameof(Order.Total)));
        Assert.Null(entity.FindProperty(nameof(Order.IsDeleted)));
    }
}
