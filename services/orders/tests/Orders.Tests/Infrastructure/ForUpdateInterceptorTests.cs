using Orders.Infrastructure.Persistence;
using Xunit;

namespace Orders.Tests.Infrastructure;

public class ForUpdateInterceptorTests
{
    [Fact]
    public void Appends_for_update_to_a_tagged_select()
    {
        var sql = $"-- {ForUpdateInterceptor.Tag}\n\nSELECT p.id FROM product AS p WHERE p.id = 'x' AND p.deleted_at IS NULL";
        var rewritten = ForUpdateInterceptor.ApplyForUpdate(sql);
        Assert.EndsWith("FOR UPDATE", rewritten.TrimEnd());
    }

    [Fact]
    public void Leaves_untagged_sql_untouched()
    {
        var sql = "SELECT p.id FROM product AS p WHERE p.id = 'x'";
        Assert.Equal(sql, ForUpdateInterceptor.ApplyForUpdate(sql));
    }

    [Fact]
    public void Does_not_double_append_when_already_present()
    {
        var sql = $"-- {ForUpdateInterceptor.Tag}\nSELECT 1 FOR UPDATE";
        var rewritten = ForUpdateInterceptor.ApplyForUpdate(sql);
        Assert.Single(System.Text.RegularExpressions.Regex.Matches(rewritten, "FOR UPDATE"));
    }

    [Fact]
    public void Does_not_touch_non_select_even_if_tagged()
    {
        var sql = $"-- {ForUpdateInterceptor.Tag}\nUPDATE product SET units_in_stock = 1";
        Assert.Equal(sql, ForUpdateInterceptor.ApplyForUpdate(sql));
    }
}
