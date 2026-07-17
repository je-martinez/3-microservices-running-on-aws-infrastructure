using Orders.Domain.Entities;
using Xunit;

namespace Orders.Tests.Domain;

public class MoneyComputedTests
{
    [Fact]
    public void UnitPrice_converts_cents_to_dollars()
    {
        var product = new Product { UnitPriceCents = 1999 };
        Assert.Equal(19.99m, product.UnitPrice);
    }

    [Fact]
    public void Order_totals_convert_cents_to_dollars()
    {
        var order = new Order { SubtotalCents = 5000, TaxCents = 400, TotalCents = 5400 };
        Assert.Equal(50.00m, order.Subtotal);
        Assert.Equal(4.00m, order.Tax);
        Assert.Equal(54.00m, order.Total);
    }

    [Fact]
    public void IsDeleted_is_true_when_deleted_at_set()
    {
        var order = new Order { DeletedAt = new DateTime(2026, 7, 14) };
        Assert.True(order.IsDeleted);
    }

    [Fact]
    public void IsDeleted_is_false_when_deleted_at_null()
    {
        Assert.False(new Order().IsDeleted);
    }
}
