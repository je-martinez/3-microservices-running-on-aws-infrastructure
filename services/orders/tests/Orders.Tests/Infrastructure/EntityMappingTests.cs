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
    public void Tags_map_to_a_json_column_via_a_converter()
    {
        using var ctx = BuildContext();
        var property = ctx.Model.FindEntityType(typeof(Order))!.FindProperty(nameof(Order.Tags))!;

        Assert.Equal("tags", property.GetColumnName());
        // MySQL 8 has no array type, so the list is converted to a JSON string. The
        // comparer is what makes EF notice a mutation of the list rather than comparing
        // it by reference.
        Assert.NotNull(property.GetValueConverter());
        Assert.NotNull(property.GetValueComparer());
        Assert.False(property.IsNullable);
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
